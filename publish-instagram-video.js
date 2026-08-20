// Publishes a video/Reel to Instagram from a public video URL — the same
// create-container -> poll -> publish flow we already proved manually with
// curl, just for video/REELS instead of a plain image.
//
// Usage: node publish-instagram-video.js "<public_video_url>" ["caption text"]

import "dotenv/config";

const token = process.env.IG_ACCESS_TOKEN;
const igUserId = process.env.IG_USER_ID;

if (!token || !igUserId) {
  console.error("Missing IG_ACCESS_TOKEN or IG_USER_ID in .env");
  process.exit(1);
}

const videoUrl = process.argv[2];
const caption = process.argv[3] || "Test video post from Travafa pipeline";

if (!videoUrl) {
  console.error('Usage: node publish-instagram-video.js "<public_video_url>" ["caption"]');
  process.exit(1);
}

const BASE = "https://graph.instagram.com/v21.0";

async function createContainer() {
  const params = new URLSearchParams({
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    access_token: token,
  });

  const res = await fetch(`${BASE}/${igUserId}/media`, { method: "POST", body: params });
  const data = await res.json();
  if (!res.ok) throw new Error(`Container creation failed: ${JSON.stringify(data)}`);

  console.log("Container created:", data.id);
  return data.id;
}

async function waitUntilFinished(containerId) {
  while (true) {
    const res = await fetch(
      `${BASE}/${containerId}?fields=status_code&access_token=${token}`
    );
    const data = await res.json();
    console.log("Status:", data.status_code);

    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      throw new Error(`Container failed: ${JSON.stringify(data)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

async function publish(containerId) {
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: token,
  });

  const res = await fetch(`${BASE}/${igUserId}/media_publish`, { method: "POST", body: params });
  const data = await res.json();
  if (!res.ok) throw new Error(`Publish failed: ${JSON.stringify(data)}`);

  console.log("Published! Media ID:", data.id);
}

async function main() {
  const containerId = await createContainer();
  console.log("Waiting for video to process (can take a minute or two)...");
  await waitUntilFinished(containerId);
  await publish(containerId);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
