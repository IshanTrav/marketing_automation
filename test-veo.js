// Quick standalone test: generate a short video with Veo 3.1 via the Gemini API,
// poll until it's ready, and save it locally. Just a proof-of-concept script —
// not part of the real orchestrator yet.

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY in .env — see .env.example");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

// Change this to whatever you want to test — a real travel-post style prompt
// works better than something generic, since that's the actual use case.
const prompt =
  "Cinematic drone shot descending toward a quiet Goa beach at golden hour, " +
  "turquoise water, palm trees swaying in the breeze, warm cinematic tones, vertical 9:16";

async function main() {
  console.log("Submitting video generation request to Veo 3.1...");

  let operation = await ai.models.generateVideos({
    model: "veo-3.1-generate-preview",
    prompt,
    config: {
      aspectRatio: "9:16", // vertical, matches Reels/Stories
    },
  });

  console.log("Job submitted, polling until it's ready (this can take a minute or two)...");

  while (!operation.done) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    operation = await ai.operations.getVideosOperation({ operation });
    console.log("Still processing...");
  }

  if (operation.response?.generatedVideos?.length) {
    const outputPath = "output_video.mp4";
    await ai.files.download({
      file: operation.response.generatedVideos[0].video,
      downloadPath: outputPath,
    });
    console.log(`Done. Video saved to ${outputPath}`);
  } else {
    console.error("Generation finished but no video came back:", JSON.stringify(operation, null, 2));
  }
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
