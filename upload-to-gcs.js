// Uploads a local file to the GCS bucket and returns a public URL.
// Usage: node upload-to-gcs.js output_video.mp4

import "dotenv/config";
import { Storage } from "@google-cloud/storage";
import path from "path";

const bucketName = process.env.GCS_BUCKET_NAME;
if (!bucketName) {
  console.error("Missing GCS_BUCKET_NAME in .env");
  process.exit(1);
}

const localFile = process.argv[2];
if (!localFile) {
  console.error("Usage: node upload-to-gcs.js <path-to-file>");
  process.exit(1);
}

// Uses GOOGLE_APPLICATION_CREDENTIALS from .env (path to a service account
// JSON key file) to authenticate — no gcloud CLI login needed.
const storage = new Storage();

async function main() {
  const destination = `test-uploads/${Date.now()}-${path.basename(localFile)}`;

  console.log(`Uploading ${localFile} to gs://${bucketName}/${destination} ...`);
  await storage.bucket(bucketName).upload(localFile, {
    destination,
  });

  // Make just this one file public so Meta's servers can fetch it.
  await storage.bucket(bucketName).file(destination).makePublic();

  const publicUrl = `https://storage.googleapis.com/${bucketName}/${destination}`;
  console.log("Done. Public URL:");
  console.log(publicUrl);
}

main().catch((err) => {
  console.error("Upload failed:", err);
  process.exit(1);
});
