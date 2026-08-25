// Generates one Veo clip with reference images attached.
//
// Reference images are how identity is held across shots. Chaining the previous clip's
// last frame drifts; a reference is re-read on every generation, so the face and the
// interface stay put. ASSET covers a character, an object or a scene; STYLE covers look.
//
// Usage: node gen-with-refs.js <prompt.txt> <out.mp4> [negative.txt]
// Set REFS_MANIFEST=<references.json> to use a pack made by gen-3refs.js.

import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";

const [, , promptFile, out, negFile] = process.argv;
if (!promptFile || !out) { console.error("usage: node gen-with-refs.js <prompt.txt> <out.mp4> [negative.txt]"); process.exit(1); }

const MODEL = process.env.VEO_MODEL || "veo-3.1-generate-preview";
const manifestPath = process.env.REFS_MANIFEST;
const manifestRefs = manifestPath
  ? (() => {
      const { images } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return [images.character, images.hero_phone, images.environment];
    })()
  : null;
const REFS = (process.env.REFS
  ? process.env.REFS.split(",")
  : manifestRefs || ["assets/ref/traveller.png", "assets/ref/phone-results-bali.png"]);
if (REFS.length > 3) throw new Error("Veo accepts at most three reference images");
for (const ref of REFS) {
  if (!fs.existsSync(ref.trim())) throw new Error(`Missing Veo reference image: ${ref}`);
}

const asset = (p) => ({
  image: { imageBytes: fs.readFileSync(p.trim()).toString("base64"), mimeType: "image/png" },
  referenceType: "ASSET",
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const prompt = fs.readFileSync(promptFile, "utf8");

const config = {
  aspectRatio: "9:16",
  resolution: process.env.RESOLUTION || "1080p",
  durationSeconds: 8,
  referenceImages: REFS.map(asset),
};
if (negFile) config.negativePrompt = fs.readFileSync(negFile, "utf8").trim();

console.log(`${promptFile} → ${out}`);
console.log(`  model ${MODEL} | ${config.resolution} | refs: ${REFS.map((r) => r.split("/").pop()).join(", ")}${negFile ? " | negative prompt" : ""}`);

let op;
for (let attempt = 1; attempt <= 3; attempt++) {
  try { op = await ai.models.generateVideos({ model: MODEL, prompt, config }); break; }
  catch (e) {
    console.log(`  attempt ${attempt}: ${String(e.message).slice(0, 160)}`);
    if (attempt === 3) throw e;
    await new Promise((r) => setTimeout(r, 5000 * 2 ** (attempt - 1)));
  }
}
let polls = 0;
while (!op.done) {
  await new Promise((r) => setTimeout(r, 10000));
  op = await ai.operations.getVideosOperation({ operation: op });
  polls++;
}
if (!op.response?.generatedVideos?.length) {
  console.error("  no video returned:", JSON.stringify(op).slice(0, 600));
  process.exit(1);
}
await ai.files.download({ file: op.response.generatedVideos[0].video, downloadPath: out });
console.log(`  done after ${polls} polls → ${out} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`);
