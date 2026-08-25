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
  "Two excited friends sitting together on a couch in a cozy living room, warm evening light, " +
  "one of them holds up a phone showing a flight booking app with a Tokyo flight confirmed, " +
  "she smiles and says 'Japan, here we come!' while the other claps happily, " +
  "phone screen glowing warmly in the low light, shallow depth of field, cinematic tones, " +
  "camera slowly pushes in, vertical 9:16";

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
