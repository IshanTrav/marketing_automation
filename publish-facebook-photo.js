// Publishes a photo to the Facebook Page from a public image URL.
// Usage: node publish-facebook-photo.js "<public_image_url>" ["caption text"]

import "dotenv/config";

const token = process.env.FB_PAGE_ACCESS_TOKEN;
const pageId = process.env.FB_PAGE_ID;

if (!token || !pageId) {
  console.error("Missing FB_PAGE_ACCESS_TOKEN or FB_PAGE_ID in .env");
  process.exit(1);
}

const imageUrl = process.argv[2];
const caption = process.argv[3] || "Test photo from Travafa pipeline";

if (!imageUrl) {
  console.error('Usage: node publish-facebook-photo.js "<public_image_url>" ["caption"]');
  process.exit(1);
}

async function main() {
  const params = new URLSearchParams({
    url: imageUrl,
    caption,
    published: "true",
    access_token: token,
  });

  const res = await fetch(`https://graph.facebook.com/v26.0/${pageId}/photos`, {
    method: "POST",
    body: params,
  });
  const data = await res.json();

  if (!res.ok) throw new Error(`Publish failed: ${JSON.stringify(data)}`);
  console.log("Published! Post ID:", data.post_id || data.id);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
