#!/usr/bin/env node
// Daily APOD → Instagram poster.
//
// What this does:
//   1. Fetches NASA's Astronomy Picture of the Day — from the science.nasa.gov
//      APOD feed, falling back to api.nasa.gov/planetary/apod. Every candidate
//      must name a real /apod/ asset and serve image|video bytes, or the run
//      fails instead of publishing. See fetchAPOD() for why that matters.
//   2. Dispatches on media type:
//       - image        → posts to feed as an image (single container + publish)
//       - wide / tall  → images outside Instagram's 0.8–1.91 aspect window are
//                        sliced into a swipeable carousel rather than cropped
//                        or rejected. Panoramas cut left→right, tall mosaics
//                        top→bottom. The slices are committed to slices/ and
//                        served to IG from raw.githubusercontent.com, so this
//                        path needs GitHub Actions. See planSlices().
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
//   NASA_API_KEY             — NASA APOD API key, used only by the fallback
//                              source (DEMO_KEY works but is heavily rate-limited)
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

import { mkdir, appendFile, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { Jimp } from "jimp";

const execFileAsync = promisify(execFile);

const GRAPH_API_VERSION = "v21.0";
const NASA_APOD_URL = "https://api.nasa.gov/planetary/apod";

// Primary metadata source. In late Sept 2026 NASA migrated APOD off
// apod.nasa.gov to science.nasa.gov; api.nasa.gov/planetary/apod scrapes the
// old page, so it now follows the redirect and returns the *site chrome*
// instead of the photo — title "NASA Science" and url/hdurl pointing at
// nasa-logo@2x.png. The explanation field still comes through correctly,
// which is why this failed silently: every run reported status "ok" while
// publishing the NASA logo. This feed is the migrated, structured source.
const APOD_FEED_URL = "https://science.nasa.gov/feed/apod-basic/";

// Instagram's accepted aspect-ratio window for feed images (w/h).
const IG_MIN_ASPECT = 0.8; // 4:5 portrait
const IG_MAX_ASPECT = 1.91; // 1.91:1 landscape

// Photos outside that window are split across a swipeable carousel instead
// of being cropped or rejected. Wide panoramas cut along x (swipe = pan
// left→right); tall mosaics cut along y (swipe = scroll top→bottom).
//
// The epsilon keeps images that sit a hair outside the limit — a 4455x5592
// APOD is 0.797 — as single posts, since a two-page carousel for a 0.4%
// overshoot is worse than just posting the photo.
const ASPECT_EPSILON = 0.02;
const MAX_CAROUSEL_ITEMS = 10; // Instagram's per-carousel limit
const SLICE_LONG_EDGE = 1440; // IG downscales beyond this anyway
const SLICE_SOURCE_CAP = 2880; // fetch a scaled source, not the 92 MP original
const SLICE_DIR = "slices";
// Instagram documents JPEG-only feed images with an 8 MB ceiling. APOD
// publishes PNGs (two in the last 30 days) and they can be enormous — the
// Sharpless catalog is a 36 MB PNG, still 10.8 MB even scaled to 2880px.
// Anything that is not a modest JPEG gets re-encoded through the same
// pipeline as the slices. That 36 MB PNG lands at ~550 KB.
const IG_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SLICE_RETENTION_DAYS = 30; // prune older slice sets so the repo stays small
const RAW_HOST = "https://raw.githubusercontent.com";
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

  // assertMediaFetchable: "Media URL not fetchable: 503 Service Unavailable".
  // A wrong content-type is deliberately absent here — that means the asset
  // host is serving something that is not media, which retrying cannot fix.
  const mediaMatch = err.message?.match(/Media URL not fetchable: (\d+)/);
  if (mediaMatch) return isRetryableStatus(Number(mediaMatch[1]));
  if (/^Media URL unreachable:/.test(err.message || "")) return true;

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

// ── APOD metadata sources ───────────────────────────────────────────────

function decodeEntities(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#0?38;|&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(s = "") {
  return decodeEntities(s).replace(/<[^>]*>/g, "");
}

function tidy(s = "") {
  return s.replace(/\s+/g, " ").trim();
}

// APOD explanations end with site boilerplate ("Tomorrow's picture: …",
// submission notices). It is not part of the photo's description and only
// eats into the caption budget, so cut it off at the first marker.
const EXPLANATION_CUTOFFS = [
  /APOD'?s email for image submissions/i,
  /Tomorrow'?s picture/i,
  /digg_url|APOD Submissions/i,
];

function cleanExplanation(raw) {
  let text = tidy(stripHtml(raw).replace(/^\s*Explanation:\s*/i, ""));
  for (const marker of EXPLANATION_CUTOFFS) {
    const m = text.match(marker);
    if (m) text = text.slice(0, m.index).trim();
  }
  return text.replace(/[\s.]+$/, (t) => (t.includes(".") ? "." : ""));
}

// The feed's credit field is prefixed with its own "Image Credit:" label,
// which buildCaption adds again — strip it to avoid doubling.
function cleanCredit(raw) {
  const text = tidy(stripHtml(raw));
  if (!text) return "";
  return text
    .replace(/^\s*(Image\s+)?Credit\s*(&|and)?\s*(Copyright)?\s*:?\s*/i, "")
    .trim();
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : "";
}

// The feed's hdurl carries the asset's native dimensions in its query
// string (?w=1600&h=800&fit=clip), so we learn the aspect ratio without
// downloading the image.
function dimsFromUrl(url) {
  try {
    const q = new URL(url).searchParams;
    const w = Number(q.get("w"));
    const h = Number(q.get("h"));
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch {}
  return null;
}

async function fetchApodFromFeed() {
  const res = await fetch(APOD_FEED_URL, {
    headers: { accept: "application/rss+xml, application/xml, text/xml" },
  });
  if (!res.ok) {
    throw new Error(`APOD fetch failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const item = xml.match(/<item>[\s\S]*?<\/item>/i)?.[0];
  if (!item) throw new Error("APOD feed contained no <item> entries");

  const hdurl = decodeEntities(tagText(item, "apod:hdurl")).trim();
  const pubDate = tagText(item, "pubDate").trim();
  const date = pubDate
    ? new Date(pubDate).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  return {
    date,
    title: tidy(stripHtml(tagText(item, "title"))),
    explanation: cleanExplanation(tagText(item, "apod:explanation")),
    url: hdurl,
    hdurl,
    // On video days the feed points at a file rather than a still, so keep
    // the Reels path reachable instead of mislabelling it an image.
    media_type: isDirectVideoFile(hdurl) ? "video" : "image",
    copyright: cleanCredit(tagText(item, "apod:copyright")),
    permalink: tidy(stripHtml(tagText(item, "link"))),
    source: "feed",
  };
}

async function fetchApodFromApi() {
  const url = `${NASA_APOD_URL}?api_key=${encodeURIComponent(NASA_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`APOD fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return {
    ...data,
    explanation: cleanExplanation(data.explanation || ""),
    copyright: cleanCredit(data.copyright || ""),
    source: "api",
  };
}

// Every genuine APOD asset lives under an /apod/ path segment, on either the
// new science.nasa.gov asset host or the legacy apod.nasa.gov one. The site
// chrome that api.nasa.gov now returns (…/themes/nasa-child/assets/images/
// nasa-logo@2x.png) does not, so this one check is what stops the logo from
// being published.
function looksLikeApodAsset(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (!/(^|\.)nasa\.gov$/i.test(parsed.hostname)) return false;
  if (!/\/apod\//i.test(parsed.pathname)) return false;
  if (/nasa-logo|\/themes\//i.test(parsed.pathname)) return false;
  return true;
}

function validateApod(apod, label) {
  const problems = [];
  if (!apod?.url) problems.push("no media url");
  else if (!looksLikeApodAsset(apod.url))
    problems.push(`url is not an APOD asset (${apod.url})`);
  if (!apod?.title) problems.push("no title");
  else if (/^NASA Science$/i.test(apod.title.trim()))
    problems.push(`placeholder title "${apod.title}"`);
  if (!apod?.explanation) problems.push("no explanation");

  if (problems.length) {
    console.log(`  ⚠️  ${label} source unusable: ${problems.join("; ")}`);
    return false;
  }
  return true;
}

// Try the migrated feed first, fall back to the legacy API, and refuse to
// continue if neither yields a real photo. Posting nothing is recoverable;
// posting the wrong image to the feed every day is not.
async function fetchAPOD() {
  const sources = [
    ["feed", fetchApodFromFeed],
    ["api.nasa.gov", fetchApodFromApi],
  ];

  const failures = [];
  for (const [label, fn] of sources) {
    let apod;
    try {
      apod = await fn();
    } catch (err) {
      console.log(`  ⚠️  ${label} source errored: ${err.message || err}`);
      failures.push(`${label}: ${err.message || err}`);
      continue;
    }
    if (validateApod(apod, label)) {
      if (label !== "feed") {
        console.log(`  ℹ️  Using fallback source: ${label}`);
      }
      return apod;
    }
    failures.push(`${label}: returned no usable APOD asset`);
  }

  throw new Error(
    `No usable APOD found from any source — ${failures.join(" | ")}`
  );
}

// Last line of defence before handing a URL to Instagram. Since the
// migration, any path under apod.nasa.gov answers 200 with the new landing
// page's HTML, so a status check alone is not enough — IG would be told to
// ingest a 265 KB HTML document. Confirm the bytes are actually media.
async function assertMediaFetchable(url, mediaKind) {
  let res;
  try {
    res = await fetch(url, { method: "HEAD", redirect: "follow" });
  } catch (err) {
    throw new Error(`Media URL unreachable: ${err.message || err}`);
  }
  if (!res.ok) {
    throw new Error(`Media URL not fetchable: ${res.status} ${res.statusText}`);
  }
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const expected = mediaKind === "video" ? "video/" : "image/";
  if (!type.startsWith(expected)) {
    throw new Error(
      `Media URL returned content-type "${type || "unknown"}", expected ${expected}* — ` +
        `refusing to publish (url=${url})`
    );
  }
  const length = Number(res.headers.get("content-length"));
  return { type, bytes: Number.isFinite(length) && length > 0 ? length : null };
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

// ── Panorama / tall-mosaic slicing ──────────────────────────────────────
//
// Instagram only accepts 0.8–1.91 aspect. NASA's asset host ignores every
// crop-offset parameter (rect, crop=x,y,w,h, cx/cy/cw/ch) — it only ever
// scales to native aspect — so slicing has to happen here, and the pieces
// have to be hosted somewhere Instagram can fetch them. They are committed
// to this public repo and served from raw.githubusercontent.com.

// Choose the cut axis and slice count so every piece lands inside the
// accepted window, aiming for roughly square slices. Returns null when the
// photo is already postable as-is.
function planSlices(width, height) {
  const aspect = width / height;
  let axis;
  let count;
  if (aspect > IG_MAX_ASPECT + ASPECT_EPSILON) {
    axis = "x";
    count = Math.round(aspect);
  } else if (aspect < IG_MIN_ASPECT - ASPECT_EPSILON) {
    axis = "y";
    count = Math.round(1 / aspect);
  } else {
    return null;
  }
  count = Math.min(MAX_CAROUSEL_ITEMS, Math.max(2, count));

  let sliceWidth = axis === "x" ? Math.floor(width / count) : width;
  let sliceHeight = axis === "y" ? Math.floor(height / count) : height;

  // Beyond ~19:1 even ten slices stay too wide, so trim each piece to the
  // limit. That leaves small gaps between pages — unavoidable, and still
  // better than failing to post at all.
  let gapped = false;
  if (sliceWidth / sliceHeight > IG_MAX_ASPECT) {
    sliceWidth = Math.floor(sliceHeight * IG_MAX_ASPECT);
    gapped = true;
  }
  if (sliceWidth / sliceHeight < IG_MIN_ASPECT) {
    sliceHeight = Math.floor(sliceWidth / IG_MIN_ASPECT);
    gapped = true;
  }

  // Centre the covered span so any remainder is split between both ends
  // rather than all falling off one edge.
  const spanWidth = axis === "x" ? sliceWidth * count : sliceWidth;
  const spanHeight = axis === "y" ? sliceHeight * count : sliceHeight;
  const originX = Math.floor((width - spanWidth) / 2);
  const originY = Math.floor((height - spanHeight) / 2);

  const regions = Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    left: axis === "x" ? originX + i * sliceWidth : originX,
    top: axis === "y" ? originY + i * sliceHeight : originY,
    width: sliceWidth,
    height: sliceHeight,
  }));

  return {
    axis,
    count,
    gapped,
    aspect: Number(aspect.toFixed(3)),
    sliceAspect: Number((sliceWidth / sliceHeight).toFixed(3)),
    regions,
  };
}

// Ask the asset host for a scaled copy rather than the full original — the
// Carina mosaic is 8200x11220, which is 92 MP of decoded bitmap for an image
// Instagram will show at 1440px.
function scaledSourceUrl(url, cap = SLICE_SOURCE_CAP) {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("w") && !parsed.searchParams.has("h")) {
      return url;
    }
    parsed.searchParams.set("w", String(cap));
    parsed.searchParams.set("h", String(cap));
    parsed.searchParams.set("fit", "clip");
    return parsed.toString();
  } catch {
    return url;
  }
}

// Produces the JPEG files Instagram will actually be given. Normally that is
// a slice set; with `reencodeOnly` it is a single full-frame copy, which is
// how PNG and oversized sources are normalised (everything written here is
// JPEG, capped at SLICE_LONG_EDGE).
async function sliceImage(sourceUrl, apodDate, { reencodeOnly = false } = {}) {
  const image = await Jimp.read(scaledSourceUrl(sourceUrl));
  const { width, height } = image.bitmap;
  let plan = planSlices(width, height);
  if (!plan) {
    if (!reencodeOnly) return null;
    const aspect = Number((width / height).toFixed(3));
    plan = {
      axis: null,
      count: 1,
      gapped: false,
      aspect,
      sliceAspect: aspect,
      regions: [{ index: 1, left: 0, top: 0, width, height }],
    };
  }

  const dir = join(SLICE_DIR, apodDate);
  await mkdir(dir, { recursive: true });

  const files = [];
  for (const region of plan.regions) {
    const slice = image.clone().crop({
      x: region.left,
      y: region.top,
      w: region.width,
      h: region.height,
    });
    // Resize on the long edge only; Jimp keeps the aspect ratio for the other.
    if (Math.max(region.width, region.height) > SLICE_LONG_EDGE) {
      slice.resize(
        region.width >= region.height
          ? { w: SLICE_LONG_EDGE }
          : { h: SLICE_LONG_EDGE }
      );
    }
    const file = join(dir, `${String(region.index).padStart(2, "0")}.jpg`);
    await slice.write(file, { quality: 90 });
    files.push(file);
  }

  return { ...plan, dir, files, sourceWidth: width, sourceHeight: height };
}

async function git(...args) {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}

// Drop slice sets we no longer need. Instagram keeps its own copy once a
// post is published, so these only have to survive the publish call.
async function pruneOldSlices(keepDate) {
  let entries;
  try {
    entries = await readdir(SLICE_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - SLICE_RETENTION_DAYS * 86400000;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepDate) continue;
    const stamp = Date.parse(`${entry.name}T00:00:00Z`);
    if (Number.isNaN(stamp) || stamp >= cutoff) continue;
    await rm(join(SLICE_DIR, entry.name), { recursive: true, force: true });
  }
}

// Instagram fetches carousel children over the public internet, so the
// slices must be pushed before any container is created. Returns the public
// URLs, in order.
async function hostSlices(sliced, apodDate) {
  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  if (!repo || !branch) {
    throw new Error(
      "Carousel hosting needs GITHUB_REPOSITORY and GITHUB_REF_NAME " +
        "(set by GitHub Actions) to build raw.githubusercontent.com URLs"
    );
  }

  await pruneOldSlices(apodDate);
  await git("add", "-A", SLICE_DIR);

  const staged = await git("diff", "--cached", "--name-only");
  if (staged) {
    await git(
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "-m",
      `slices: APOD ${apodDate} carousel (${sliced.count} pieces)`
    );
    try {
      await git("push", "origin", `HEAD:${branch}`);
    } catch {
      // The branch moved under us (a previous run's log commit). Rebase and
      // retry once rather than losing the slices.
      await git("pull", "--rebase", "--autostash", "origin", branch);
      await git("push", "origin", `HEAD:${branch}`);
    }
  }

  const sha = await git("rev-parse", "HEAD");
  return sliced.files.map(
    (file) => `${RAW_HOST}/${repo}/${sha}/${file.split("/").map(encodeURIComponent).join("/")}`
  );
}

async function createCarouselChild(imageUrl) {
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_BUSINESS_ACCOUNT_ID}/media`;
  const data = await postForm(endpoint, {
    image_url: imageUrl,
    is_carousel_item: "true",
  });
  return data.id;
}

async function createCarouselContainer(childIds, caption) {
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_BUSINESS_ACCOUNT_ID}/media`;
  const data = await postForm(endpoint, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption,
  });
  return data.id;
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

// Idempotency guard #1 (fast path) — read the current month's log, return
// the first OK entry whose run timestamp matches today (UTC). Runs BEFORE
// the APOD fetch so recovery crons short-circuit cheaply without hitting
// NASA again. With the mid-day schedule (all three fires land on the same
// UTC calendar day), this reliably catches the "already posted today" case.
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

// Idempotency guard #2 (authoritative) — has THIS SPECIFIC APOD already
// been posted successfully? Keyed on the APOD's own date (the identity of
// the photo), not the run's calendar day. This is the real "same photo,
// never twice" check: it holds even if two fires straddle a UTC midnight,
// if a run is manually retried on another day, or if NASA hasn't rolled the
// APOD over yet (in which case we'd re-fetch yesterday's photo — and skip).
// Runs AFTER the fetch, once we know which APOD we're actually looking at.
// The log is bucketed by apod_date's month, so we read exactly that file.
async function findSuccessfulPostForApodDate(apodDate) {
  if (!apodDate) return null;
  const month = apodDate.slice(0, 7);
  const path = `logs/${month}.jsonl`;
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  for (const line of content.split("\n").filter(Boolean)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.status === "ok" && entry.apod_date === apodDate) {
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
  record.apod_source = apod.source;

  // Idempotency guard #2 — same photo, never twice. If this exact APOD
  // (by its date) was already posted OK, stop here and wait for tomorrow's
  // photo. This is what actually kills the double-posts: an early-hours fire
  // and a later scheduled fire can both wake up on the same APOD, but only
  // the first one gets to publish it.
  if (!DRY_RUN) {
    const dup = await findSuccessfulPostForApodDate(apod.date);
    if (dup) {
      console.log(
        `✅ APOD ${apod.date} already posted (media_id=${dup.media_id}, at ${dup.ts}).`
      );
      console.log("   Skipping — will wait for tomorrow's APOD.");
      record.status = "already_posted";
      record.existing_media_id = dup.media_id;
      return;
    }
  }

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
  console.log(`  Source:     ${apod.source}`);

  // Photos outside Instagram's accepted window go out as a swipeable
  // carousel instead of being cropped or rejected.
  const dims = dimsFromUrl(mediaUrl);
  if (dims) {
    record.aspect_ratio = Number((dims.width / dims.height).toFixed(3));
    record.dimensions = `${dims.width}x${dims.height}`;
  }

  // Confirm the bytes are real media, and learn the format and weight before
  // deciding how to publish.
  const probe = await retryWithBackoff("media preflight", () =>
    assertMediaFetchable(mediaUrl, mediaKind)
  );
  console.log(
    `  Content-Type: ${probe.type}${
      probe.bytes ? ` (${(probe.bytes / 1048576).toFixed(1)} MB)` : ""
    }`
  );
  record.source_content_type = probe.type;
  if (probe.bytes) record.source_bytes = probe.bytes;

  let sliced = null;
  if (mediaKind === "image") {
    const aspect = dims ? dims.width / dims.height : null;
    const needsSlicing =
      aspect !== null &&
      (aspect > IG_MAX_ASPECT + ASPECT_EPSILON ||
        aspect < IG_MIN_ASPECT - ASPECT_EPSILON);
    // Instagram takes JPEG only, up to 8 MB. APOD also publishes PNGs.
    const notJpeg = !/^image\/jpe?g/.test(probe.type);
    const tooBig = probe.bytes != null && probe.bytes > IG_MAX_IMAGE_BYTES;

    if (needsSlicing) {
      console.log(
        `→ Aspect ${record.aspect_ratio} is outside Instagram's ` +
          `${IG_MIN_ASPECT}–${IG_MAX_ASPECT} window — slicing into a carousel…`
      );
    } else if (notJpeg || tooBig) {
      console.log(
        `→ Re-encoding to JPEG — ${
          notJpeg ? `source is ${probe.type}` : "source exceeds 8 MB"
        }…`
      );
      record.reencoded = true;
    }

    if (needsSlicing || notJpeg || tooBig) {
      sliced = await retryWithBackoff("image prepare", () =>
        sliceImage(mediaUrl, apod.date, { reencodeOnly: !needsSlicing })
      );
    }
  }

  if (sliced && sliced.count > 1) {
    const direction = sliced.axis === "x" ? "left→right" : "top→bottom";
    console.log(
      `  ${sliced.count} slices on ${sliced.axis} (${direction}), ` +
        `each ${sliced.sliceAspect} — from ${sliced.sourceWidth}x${sliced.sourceHeight}`
    );
    if (sliced.gapped) {
      console.log(
        "  ⚠️  Too wide for 10 slices — pieces were trimmed, so small gaps fall between pages."
      );
    }
    record.media_kind = "carousel";
    record.carousel_count = sliced.count;
    record.slice_axis = sliced.axis;
    record.slice_aspect = sliced.sliceAspect;
    if (sliced.gapped) record.slice_gapped = true;
  } else if (sliced) {
    console.log(
      `  Re-encoded to JPEG from ${sliced.sourceWidth}x${sliced.sourceHeight}.`
    );
  }

  console.log("→ Generating hashtags…");
  const hashtags = await generateHashtags(apod);
  console.log(`  Hashtags: ${hashtags.map((t) => `#${t}`).join(" ")}`);
  record.hashtags = hashtags;

  const caption = buildCaption(apod, hashtags);
  console.log(`→ Caption built (${caption.length} chars)`);
  record.caption_length = caption.length;

  if (DRY_RUN) {
    console.log(
      `🧪 DRY_RUN=true — would post as ${
        sliced
          ? sliced.count > 1
            ? `a ${sliced.count}-slice carousel`
            : "a re-encoded JPEG image"
          : mediaKind
      }, skipping Instagram publish.`
    );
    console.log("─── Caption preview ───────────────────────");
    console.log(caption);
    console.log("─── End caption preview ───────────────────");
    console.log("Re-run with DRY_RUN unchecked (or unset) to actually post.");
    record.status = "dry_run";
    return;
  }

  let containerId;
  let sliceUrls = [];
  if (sliced) {
    console.log("→ Publishing prepared image(s) so Instagram can fetch them…");
    sliceUrls = await hostSlices(sliced, apod.date);
    record.slice_urls = sliceUrls;

    // raw.githubusercontent.com serves the commit SHA immediately, but
    // confirm before handing the URLs to Instagram — a 404 here would come
    // back as an opaque Graph API error.
    for (const url of sliceUrls) {
      await retryWithBackoff("slice preflight", () =>
        assertMediaFetchable(url, "image")
      );
    }
    console.log(`  ${sliceUrls.length} file(s) reachable.`);
  }

  if (sliced && sliced.count === 1) {
    // A re-encoded single frame: an ordinary image post, just served from
    // our copy instead of NASA's.
    console.log("→ Creating IG image container (re-encoded source)…");
    containerId = await retryWithBackoff("IG image container create", () =>
      createImageContainer(sliceUrls[0], caption)
    );
    console.log(`  Container ID: ${containerId}`);
    record.container_id = containerId;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } else if (sliced) {
    console.log("→ Creating carousel children…");
    const childIds = [];
    for (const url of sliceUrls) {
      const childId = await retryWithBackoff("IG carousel child create", () =>
        createCarouselChild(url)
      );
      childIds.push(childId);
    }
    record.child_ids = childIds;

    console.log("→ Creating carousel container…");
    containerId = await retryWithBackoff("IG carousel container create", () =>
      createCarouselContainer(childIds, caption)
    );
    console.log(`  Container ID: ${containerId}`);
    record.container_id = containerId;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } else if (mediaKind === "image") {
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
