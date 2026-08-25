// Publishes a video to the Facebook Page from a public video URL.
// Uses the simple hosted-file_url flow (not the resumable upload session) —
// fine for our size of clips. The hosting site must not block Facebook's
// fetcher via robots.txt (GitHub raw content and GCS public URLs are fine).
//
// Usage: node publish-facebook-video.js "<public_video_url>" ["description text"]

import "dotenv/config";

const token = process.env.FB_PAGE_ACCESS_TOKEN;
const pageId = process.env.FB_PAGE_ID;

if (!token || !pageId) {
  console.error("Missing FB_PAGE_ACCESS_TOKEN or FB_PAGE_ID in .env");
  process.exit(1);
}

const videoUrl = process.argv[2];
const description = process.argv[3] || "Test video from Travafa pipeline";

if (!videoUrl) {
  console.error('Usage: node publish-facebook-video.js "<public_video_url>" ["description"]');
  process.exit(1);
}

async function main() {
  const params = new URLSearchParams({
    file_url: videoUrl,
    description,
    published: "true",
    access_token: token,
  });

  console.log("Uploading + publishing video to the Page (can take a minute)...");

  const res = await fetch(`https://graph.facebook.com/v26.0/${pageId}/videos`, {
    method: "POST",
    body: params,
  });
  const data = await res.json();

  if (!res.ok) throw new Error(`Publish failed: ${JSON.stringify(data)}`);
  console.log("Published! Video ID:", data.id);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
