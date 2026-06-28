#!/usr/bin/env node
// Daily APOD → Instagram poster.
//
// What this does:
//   1. Fetches NASA's Astronomy Picture of the Day.
//   2. If today's APOD is a video, exits silently (v1 only handles images).
//   3. Builds a caption from the title + explanation + hashtags.
//   4. Creates an Instagram media container, then publishes it.
//
// Required environment variables:
//   META_ACCESS_TOKEN        — long-lived system-user token from Meta Business Portfolio
//   IG_BUSINESS_ACCOUNT_ID   — the Instagram Business Account ID (e.g. 17841416854670812)
//   NASA_API_KEY             — NASA APOD API key (DEMO_KEY works but is heavily rate-limited)
//
// Runs on GitHub Actions cron once per day. Can also be invoked manually
// via the "Run workflow" button (workflow_dispatch) for test posts.

const GRAPH_API_VERSION = "v21.0";
const NASA_APOD_URL = "https://api.nasa.gov/planetary/apod";
const IG_CAPTION_MAX = 2200; // Instagram hard limit
const EXPLANATION_BUDGET = 1800; // leaves room for title, date, hashtags, credit

const {
  META_ACCESS_TOKEN,
  IG_BUSINESS_ACCOUNT_ID,
  NASA_API_KEY = "DEMO_KEY",
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
}

requireEnv("META_ACCESS_TOKEN", META_ACCESS_TOKEN);
requireEnv("IG_BUSINESS_ACCOUNT_ID", IG_BUSINESS_ACCOUNT_ID);

async function fetchAPOD() {
  const url = `${NASA_APOD_URL}?api_key=${encodeURIComponent(NASA_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`APOD fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function buildCaption({ title, explanation, date, copyright }) {
  const hashtags = [
    "#nasa",
    "#apod",
    "#astronomy",
    "#space",
    "#astrophotography",
    "#cosmos",
    "#universe",
    "#nightsky",
    "#science",
    "#nasaapod",
  ].join(" ");

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

async function createMediaContainer(imageUrl, caption) {
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_BUSINESS_ACCOUNT_ID}/media`;
  const data = await postForm(endpoint, { image_url: imageUrl, caption });
  return data.id;
}

async function publishMedia(creationId) {
  const endpoint = `https://graph.facebook.com/${GRAPH_API_VERSION}/${IG_BUSINESS_ACCOUNT_ID}/media_publish`;
  const data = await postForm(endpoint, { creation_id: creationId });
  return data.id;
}

async function main() {
  console.log("→ Fetching APOD…");
  const apod = await fetchAPOD();
  console.log(`  Date:       ${apod.date}`);
  console.log(`  Title:      ${apod.title}`);
  console.log(`  Media type: ${apod.media_type}`);

  if (apod.media_type !== "image") {
    console.log("⏭  Today's APOD is not an image — skipping.");
    return;
  }

  // APOD provides `url` (standard res) and sometimes `hdurl`. Standard res is
  // already plenty for IG (max 1080px wide displayed) and smaller payload =
  // less chance of IG fetch timeout.
  const imageUrl = apod.url;
  console.log(`  Image URL:  ${imageUrl}`);

  const caption = buildCaption(apod);
  console.log(`→ Caption built (${caption.length} chars)`);

  console.log("→ Creating IG media container…");
  const containerId = await createMediaContainer(imageUrl, caption);
  console.log(`  Container ID: ${containerId}`);

  // For images the container is normally ready instantly. Brief wait is
  // defensive against very occasional IG-side processing lag.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  console.log("→ Publishing…");
  const mediaId = await publishMedia(containerId);
  console.log(`✅ Published. Media ID: ${mediaId}`);
}

main().catch((err) => {
  console.error("❌ Post failed:");
  console.error(err.message || err);
  process.exit(1);
});
