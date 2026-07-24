#!/usr/bin/env node
// Daily APOD → Instagram poster.
//
// What this does:
//   1. Fetches NASA's Astronomy Picture of the Day.
//   2. Dispatches on media type:
//       - image        → posts to feed as an image (single container + publish)
//       - direct video → posts as a Reel with share_to_feed=true; needs a
//                        polling step because IG processes video async
//       - embed video  → skipped (IG cannot fetch YouTube/Vimeo URLs)
//   3. Builds a caption from the title + explanation + hashtags.
//   4. Creates an Instagram media container, then publishes it.
//   5. Appends a structured JSON line to logs/YYYY-MM.jsonl (always — even
//      on errors, skipped runs, and dry runs). The workflow commits that
//      file back to the repo as a permanent audit trail.
//
// Required environment variables:
//   META_ACCESS_TOKEN        — long-lived system-user token from Meta Business Portfolio
//   IG_BUSINESS_ACCOUNT_ID   — the Instagram Business Account ID (e.g. 17841416854670812)
//   NASA_API_KEY             — NASA APOD API key (DEMO_KEY works but is heavily rate-limited)
//
// Optional:
//   DRY_RUN=true             — Fetch APOD and build the caption, but skip the
//                              actual IG container-create + publish calls.
//                              Use for safe verification before a real post.
//                              When dry-running, the IG token + account ID are
//                              not required, so this also works for local
//                              development without any secrets configured.
//   TRIGGER=<event>          — Stamped into the log line ("schedule",
//                              "workflow_dispatch", "local", etc.).
//
// Runs on GitHub Actions cron once per day. Can also be invoked manually
// via the "Run workflow" button (workflow_dispatch) for test posts.

import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const GRAPH_API_VERSION = "v21.0";
const NASA_APOD_URL = "https://api.nasa.gov/planetary/apod";
const IG_CAPTION_MAX = 2200; // Instagram hard limit
const EXPLANATION_BUDGET = 1800; // leaves room for title, date, hashtags, credit

// Retry policy: 3 attempts at 1s, 4s, 16s (~21s max wall time per call).
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const RETRY_FACTOR = 4;

const {
  META_ACCESS_TOKEN,
  IG_BUSINESS_ACCOUNT_ID,
  NASA_API_KEY = "DEMO_KEY",
  ANTHROPIC_API_KEY,
} = process.env;

const DRY_RUN = process.env.DRY_RUN === "true";
const TRIGGER = process.env.TRIGGER || "local";

function requireEnv(name, value) {
  if (!value) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
}

// Real posts need IG credentials. Dry runs do not — that lets us
// safely test caption building locally without any secrets set.
if (!DRY_RUN) {
  requireEnv("META_ACCESS_TOKEN", META_ACCESS_TOKEN);
  requireEnv("IG_BUSINESS_ACCOUNT_ID", IG_BUSINESS_ACCOUNT_ID);
}

// Module-level retry counter — incremented every time retryWithBackoff
// schedules a retry. Stamped into the log record at the end of the run
// so we can grep months later for "days where the APIs were flaky."
let retryCount = 0;

// Classify an error as transient (worth retrying) vs permanent (won't fix
// itself with another attempt). Inspects the message format used by our
// fetchAPOD() and postForm() helpers, plus Node fetch's native errors.
function isRetryable(err) {
  if (!err) return false;

  // postForm: "Graph API call failed (503): {...}"
  const graphMatch = err.message?.match(/Graph API call failed \((\d+)\)/);
  if (graphMatch) return isRetryableStatus(Number(graphMatch[1]));

  // fetchAPOD: "APOD fetch failed: 503 Service Unavailable"
  const apodMatch = err.message?.match(/APOD fetch failed: (\d+)/);
  if (apodMatch) return isRetryableStatus(Number(apodMatch[1]));

  // Native fetch TypeError ("fetch failed", ECONNRESET, ENOTFOUND, etc.)
  // These have a `cause` with a system error code. Always transient.
  if (err.cause || err.code === "ECONNRESET" || err.code === "ETIMEDOUT") {
    return true;
  }

  return false;
}

function isRetryableStatus(status) {
  // 408 timeout, 429 rate limit, 5xx server errors → retry.
  // 4xx other than 408/429 → permanent (bad auth, bad payload, etc.).
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

async function retryWithBackoff(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      const isLast = attempt === RETRY_ATTEMPTS;
      if (!retryable || isLast) {
        if (!retryable) {
          console.error(
            `  ✋ ${label} hit a non-retryable error — giving up: ${err.message}`
          );
        }
        throw err;
      }
      const waitMs = RETRY_BASE_MS * Math.pow(RETRY_FACTOR, attempt - 1);
      console.warn(
        `  ⚠️  ${label} failed (attempt ${attempt}/${RETRY_ATTEMPTS}): ${err.message}`
      );
      console.warn(`  ⏳ Retrying in ${waitMs / 1000}s…`);
      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

async function fetchAPOD() {
  const url = `${NASA_APOD_URL}?api_key=${encodeURIComponent(NASA_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`APOD fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ── Hashtag generation ──────────────────────────────────────────────────
//
// Instagram suppresses posts from Explore/recommendations when they carry
// more than 5 hashtags, so we cap at 5 and spend each slot on a distinct
// *classification* rather than piling on synonyms. Slots:
//
//   1. anchor        — always "#apod" (our brand/discovery anchor)
//   2. object_class  — what kind of object (#nebula, #galaxy, #aurora…)
//   3. named_subject — the specific named thing (#orionnebula, #jupiter…)
//   4. community     — the audience community (#astrophotography…)
//   5. source        — instrument/mission when relevant (#jwst, #hubble…)
//
// A Haiku call picks the slots from the APOD title + explanation. Every
// suggestion is validated in code against approved lists (object_class,
// community, source) or, for the free-form named_subject, against a
// hallucination guard: the model must quote a verbatim substring of the
// APOD text as evidence. Anything that fails validation is dropped, never
// posted. If the whole call fails (no key, API error, bad JSON), we fall
// back to a safe static set so a tagging problem never blocks a post.

const HASHTAG_MODEL = "claude-haiku-4-5";
const HASHTAG_ANCHOR = "apod";
const HASHTAG_FALLBACK = ["apod", "astrophotography", "astronomy"];

// Approved object-class tags. The model must pick from this list (it maps
// the APOD subject to the closest class); anything off-list is dropped.
const OBJECT_CLASS_TAGS = new Set([
  "nebula",
  "galaxy",
  "starcluster",
  "supernova",
  "aurora",
  "comet",
  "meteor",
  "eclipse",
  "moon",
  "sun",
  "solareclipse",
  "lunareclipse",
  "milkyway",
  "planet",
  "star",
  "blackhole",
  "galaxycluster",
  "nightsky",
  "deepsky",
  "constellation",
  "sunset",
  "planetarynebula",
  "spiralgalaxy",
  "cometnucleus",
  "asteroid",
]);

// Approved audience-community tags.
const COMMUNITY_TAGS = new Set([
  "astrophotography",
  "deepskyastrophotography",
  "astronomy",
  "spacephotography",
]);

// Approved source/instrument tags.
const SOURCE_TAGS = new Set([
  "jwst",
  "hubbletelescope",
  "chandra",
  "esa",
  "timelapse",
]);

const HASHTAG_TOKEN_RE = /^[a-z0-9]{3,30}$/;

// Normalize a model-suggested tag to a bare token: strip leading '#',
// lowercase, remove any non-alphanumerics. Returns "" if nothing usable.
function normalizeTag(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const HASHTAG_SCHEMA = {
  type: "object",
  properties: {
    object_class: {
      type: "string",
      description:
        "The single closest object-class tag for the APOD subject, chosen " +
        "from the approved list. Empty string if none fits.",
    },
    named_subject: {
      type: "string",
      description:
        "A hashtag for the specific named subject (e.g. 'orionnebula' for " +
        "the Orion Nebula, 'jupiter' for Jupiter). Lowercase, no spaces or " +
        "punctuation. Empty string if the APOD has no specific named subject.",
    },
    named_subject_evidence: {
      type: "string",
      description:
        "A short verbatim quote copied EXACTLY from the APOD title or " +
        "explanation that proves the named_subject appears in the text. " +
        "Must be an exact substring. Empty string if named_subject is empty.",
    },
    community: {
      type: "string",
      description:
        "The best audience-community tag from the approved list. Empty " +
        "string if none fits.",
    },
    source: {
      type: "string",
      description:
        "The instrument/mission/source tag from the approved list if the " +
        "APOD text clearly indicates one, else empty string.",
    },
  },
  required: [
    "object_class",
    "named_subject",
    "named_subject_evidence",
    "community",
    "source",
  ],
  additionalProperties: false,
};

// Ask Haiku to classify the APOD into hashtag slots, validate every
// suggestion in code, and return an ordered, deduped, ≤5 array of bare
// tag tokens (no '#'). Never throws — returns the static fallback on any
// failure so a tagging problem can't block a post.
async function generateHashtags({ title, explanation }) {
  if (!ANTHROPIC_API_KEY) {
    console.warn(
      "  ⚠️  ANTHROPIC_API_KEY not set — using static fallback hashtags."
    );
    return [...HASHTAG_FALLBACK];
  }

  const text = `${title}\n\n${explanation}`;
  const haystack = text.toLowerCase();

  const system =
    "You classify NASA Astronomy Picture of the Day entries into Instagram " +
    "hashtag slots. Choose object_class, community, and source ONLY from the " +
    "approved lists below — if nothing fits a slot, return an empty string " +
    "for it. For named_subject, produce a hashtag for the specific named " +
    "astronomical object in the APOD, and copy a verbatim substring of the " +
    "provided text into named_subject_evidence to prove it appears. Never " +
    "invent a subject that is not in the text.\n\n" +
    `Approved object_class: ${[...OBJECT_CLASS_TAGS].join(", ")}\n` +
    `Approved community: ${[...COMMUNITY_TAGS].join(", ")}\n` +
    `Approved source: ${[...SOURCE_TAGS].join(", ")}`;

  let slots;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: HASHTAG_MODEL,
      max_tokens: 512,
      system,
      messages: [
        {
          role: "user",
          content:
            `APOD title and explanation:\n\n${text}\n\n` +
            "Return the hashtag slots for this entry.",
        },
      ],
      output_config: {
        format: { type: "json_schema", schema: HASHTAG_SCHEMA },
      },
    });
    const raw = response.content.find((b) => b.type === "text")?.text ?? "";
    slots = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `  ⚠️  Hashtag generation failed (${err.message || err}) — using fallback.`
    );
    return [...HASHTAG_FALLBACK];
  }

  const tags = [HASHTAG_ANCHOR];

  const objectClass = normalizeTag(slots.object_class);
  if (OBJECT_CLASS_TAGS.has(objectClass)) tags.push(objectClass);

  // named_subject is free-form, so guard against hallucination: the model's
  // cited evidence must be a real substring of the APOD text.
  const named = normalizeTag(slots.named_subject);
  const evidence =
    typeof slots.named_subject_evidence === "string"
      ? slots.named_subject_evidence.trim().toLowerCase()
      : "";
  if (
    named &&
    HASHTAG_TOKEN_RE.test(named) &&
    evidence.length >= 3 &&
    haystack.includes(evidence)
  ) {
    tags.push(named);
  } else if (named) {
    console.warn(
      `  ⚠️  Dropping named_subject "#${named}" — evidence not found in APOD text.`
    );
  }

  const community = normalizeTag(slots.community);
  if (COMMUNITY_TAGS.has(community)) tags.push(community);

  const source = normalizeTag(slots.source);
  if (SOURCE_TAGS.has(source)) tags.push(source);

  // Dedupe preserving order, then cap at Instagram's 5-tag sweet spot.
  const deduped = [...new Set(tags)].slice(0, 5);

  // Guarantee at least the anchor + a couple of safe community tags so we
  // never post a bare single tag if the model returned mostly empties.
  if (deduped.length < 3) {
    for (const t of HASHTAG_FALLBACK) {
      if (!deduped.includes(t) && deduped.length < 5) deduped.push(t);
    }
  }

  return deduped;
}

function buildCaption({ title, explanation, date, copyright }, hashtagTokens) {
  const hashtags = (hashtagTokens?.length ? hashtagTokens : HASHTAG_FALLBACK)
    .map((t) => `#${t}`)
    .join(" ");

  const credit = copyright
    ? `📷 Image credit: ${copyright.trim()} / NASA APOD`
    : `📷 Image credit: NASA APOD`;

  const trimmedExplanation =
    explanation.length > EXPLANATION_BUDGET
      ? explanation.slice(0, EXPLANATION_BUDGET - 1).trimEnd() + "…"
      : explanation;

  const caption = `🌌 ${title}\n${date}\n\n${trimmedExplanation}\n\n${credit}\n\n${hashtags}`;

  // Final safety check — should never trip given the budget above, but defensive.
  if (caption.length > IG_CAPTION_MAX) {
    return caption.slice(0, IG_CAPTION_MAX - 1) + "…";
  }
  return caption;
}

async function postForm(endpoint, params) {
  const body = new URLSearchParams({
    ...params,
    access_token: META_ACCESS_TOKEN,
  });
  const res = await fetch(endpoint, { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Graph API call failed (${res.status}): ${JSON.stringify(data)}`
    );
  }
  return data;
}

async function createImageContainer(imageUrl, caption) {
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_BUSINESS_ACCOUNT_ID}/media`;
  const data = await postForm(endpoint, { image_url: imageUrl, caption });
  return data.id;
}

// Post video as a Reel. share_to_feed=true keeps it visible on the main
// grid (not just the Reels tab), same as the image posts.
async function createVideoContainer(videoUrl, caption) {
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_BUSINESS_ACCOUNT_ID}/media`;
  const data = await postForm(endpoint, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: "true",
  });
  return data.id;
}

// Instagram processes video containers asynchronously — you can't publish
// until status_code === "FINISHED". Poll every 5s for up to 4 min.
// Statuses: IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED.
async function pollContainerReady(
  containerId,
  { timeoutMs = 4 * 60 * 1000, intervalMs = 5000 } = {}
) {
  const endpoint =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${containerId}` +
    `?fields=status_code,status&access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`;
  const startedAt = Date.now();
  let lastStatus;
  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(endpoint);
    const data = await res.json().catch(() => ({}));
    lastStatus = data.status_code;
    console.log(`  ⏳ container ${containerId} status: ${lastStatus || "?"}`);
    if (lastStatus === "FINISHED") return;
    if (lastStatus === "ERROR" || lastStatus === "EXPIRED") {
      throw new Error(
        `Container ${containerId} unusable (${lastStatus}): ${JSON.stringify(data)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Container ${containerId} did not finish processing within ` +
      `${timeoutMs / 1000}s (last status: ${lastStatus})`
  );
}

async function publishMedia(creationId) {
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_BUSINESS_ACCOUNT_ID}/media_publish`;
  const data = await postForm(endpoint, { creation_id: creationId });
  return data.id;
}

// APOD's video days come in two flavors:
//   1. Direct .mp4 or .mov files hosted on apod.nasa.gov — IG can ingest these
//      via video_url. This is what we support.
//   2. Embedded YouTube / Vimeo URLs — IG cannot fetch these; skip.
function isDirectVideoFile(url) {
  return /\.(mp4|mov)(\?.*)?$/i.test(url || "");
}

// Append a single structured line to logs/YYYY-MM.jsonl.
// File is bucketed by month so each file stays small (~30 lines/year-month).
async function writeLog(record) {
  const month =
    record.apod_date?.slice(0, 7) ?? new Date().toISOString().slice(0, 7);
  const path = `logs/${month}.jsonl`;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
  console.log(`📝 Logged to ${path}`);
}

// Idempotency guard — read the current month's log, return the first OK
// entry whose timestamp matches today (UTC). Used to short-circuit
// retries (Layer 2 + 3) if the post already succeeded on an earlier run.
//
// Why date-based and not apod-date-based? The cron fires at 02:00 UTC.
// APOD's "date" field follows US Eastern, so an entry's apod_date may
// not match today's UTC date. But we only want one post per calendar
// day — and that calendar day is the day the script runs.
async function findTodaysSuccessfulPost() {
  const todayUTC = new Date().toISOString().slice(0, 10);
  const month = todayUTC.slice(0, 7);
  const path = `logs/${month}.jsonl`;
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null; // first run of the month
    throw err;
  }
  const lines = content.split("\n").filter(Boolean);
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // tolerate malformed lines rather than crash
    }
    if (entry.status === "ok" && entry.ts?.startsWith(todayUTC)) {
      return entry;
    }
  }
  return null;
}

async function run(record) {
  // Idempotency guard. Runs FIRST so Layer 2 step retries and Layer 3
  // recovery crons can fire freely without ever double-posting.
  // Dry runs deliberately skip this check — re-running dry-run should
  // always exercise the script fully even if a real post already happened.
  if (!DRY_RUN) {
    const existing = await findTodaysSuccessfulPost();
    if (existing) {
      console.log(
        `✅ Already posted today (media_id=${existing.media_id}, at ${existing.ts}).`
      );
      console.log("   Skipping — nothing to do.");
      record.status = "already_posted";
      record.existing_media_id = existing.media_id;
      record.apod_date = existing.apod_date;
      return;
    }
  }

  console.log("→ Fetching APOD…");
  const apod = await retryWithBackoff("APOD fetch", () => fetchAPOD());
  console.log(`  Date:       ${apod.date}`);
  console.log(`  Title:      ${apod.title}`);
  console.log(`  Media type: ${apod.media_type}`);

  record.apod_date = apod.date;
  record.apod_title = apod.title;
  record.apod_media_type = apod.media_type;
  record.apod_url = apod.url;

  // Decide the publish path.
  //   image                                → post to feed as image
  //   video + direct .mp4/.mov URL         → post as Reel (share_to_feed=true)
  //   video + embed URL (YouTube/Vimeo)    → skip (IG can't fetch embeds)
  //   anything else                        → skip
  let mediaKind;
  if (apod.media_type === "image") {
    mediaKind = "image";
  } else if (
    apod.media_type === "video" &&
    isDirectVideoFile(apod.url)
  ) {
    mediaKind = "video";
  } else {
    console.log(
      `⏭  Skipping — media_type=${apod.media_type}, url=${apod.url} is not a supported format.`
    );
    record.status = "skipped_unsupported_media";
    return;
  }
  record.media_kind = mediaKind;

  const mediaUrl = apod.url;
  console.log(`  Media URL:  ${mediaUrl}`);

  console.log("→ Generating hashtags…");
  const hashtags = await generateHashtags(apod);
  console.log(`  Hashtags: ${hashtags.map((t) => `#${t}`).join(" ")}`);
  record.hashtags = hashtags;

  const caption = buildCaption(apod, hashtags);
  console.log(`→ Caption built (${caption.length} chars)`);
  record.caption_length = caption.length;

  if (DRY_RUN) {
    console.log(
      `🧪 DRY_RUN=true — would post as ${mediaKind}, skipping Instagram publish.`
    );
    console.log("─── Caption preview ───────────────────────");
    console.log(caption);
    console.log("─── End caption preview ───────────────────");
    console.log("Re-run with DRY_RUN unchecked (or unset) to actually post.");
    record.status = "dry_run";
    return;
  }

  let containerId;
  if (mediaKind === "image") {
    console.log("→ Creating IG image container…");
    containerId = await retryWithBackoff("IG image container create", () =>
      createImageContainer(mediaUrl, caption)
    );
    console.log(`  Container ID: ${containerId}`);
    record.container_id = containerId;

    // For images the container is normally ready instantly. Brief wait is
    // defensive against very occasional IG-side processing lag.
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } else {
    console.log("→ Creating IG video (Reels) container…");
    containerId = await retryWithBackoff("IG video container create", () =>
      createVideoContainer(mediaUrl, caption)
    );
    console.log(`  Container ID: ${containerId}`);
    record.container_id = containerId;

    // Videos require IG to fetch, transcode, and prepare the file. Poll until
    // the container reports FINISHED or throws (ERROR/EXPIRED/timeout).
    console.log("→ Waiting for IG to process video…");
    await pollContainerReady(containerId);
  }

  console.log("→ Publishing…");
  const mediaId = await retryWithBackoff("IG publish", () =>
    publishMedia(containerId)
  );
  console.log(`✅ Published. Media ID: ${mediaId}`);
  record.media_id = mediaId;
  record.status = "ok";
}

async function main() {
  const startedAt = Date.now();
  const record = {
    ts: new Date().toISOString(),
    trigger: TRIGGER,
    dry_run: DRY_RUN,
    status: "pending",
  };

  let exitCode = 0;
  try {
    await run(record);
  } catch (err) {
    console.error("❌ Post failed:");
    console.error(err.message || err);
    record.status = "error";
    record.error = err.message || String(err);
    exitCode = 1;
  } finally {
    record.duration_ms = Date.now() - startedAt;
    record.retry_count = retryCount;
    // Log write itself must not crash the process — wrap defensively.
    try {
      await writeLog(record);
    } catch (logErr) {
      console.error("⚠️  Failed to write log entry:", logErr.message || logErr);
    }
  }
  process.exit(exitCode);
}

main();
