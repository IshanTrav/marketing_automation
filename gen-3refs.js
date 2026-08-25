// Creates the three-image continuity pack for one Travafa reel.
// Every image call receives the real Travafa web and app screenshots as visual references.
// Usage: node gen-3refs.js <brief.json> [out-dir]

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";

const [, , briefPath, outputDir = "prompts/_refs"] = process.argv;
if (!briefPath) {
  console.error("usage: node gen-3refs.js <brief.json> [out-dir]");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in .env");
  process.exit(1);
}

const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
// One unified brief now feeds both this script and gen-veo-prompt.js. Its canonical keys
// are UPPER_SNAKE (PRODUCT_FOCUS, PAIN_POINT, TARGET_AUDIENCE); the image-only fields
// (wardrobe/setting/tone/action) have no veo-side equivalent and keep their PascalCase
// names. Accept either casing so an older PascalCase-only brief still runs.
const ALIASES = {
  ProductFocus: ["PRODUCT_FOCUS"],
  PainPoint: ["PAIN_POINT"],
  ICP: ["TARGET_AUDIENCE"],
};
const value = (name) => {
  for (const key of [name, name[0].toLowerCase() + name.slice(1), ...(ALIASES[name] || [])]) {
    if (brief[key]) return brief[key];
  }
  return undefined;
};
const required = ["ProductFocus", "PainPoint", "ICP", "CharacterStyle", "Setting", "ReferenceTone", "PhoneShotAction"];
const missing = required.filter((name) => !value(name));
if (missing.length) {
  console.error(`brief is missing: ${missing.join(", ")}`);
  process.exit(1);
}

// Locked to the same four rows as the BRAND table in veo-prompt-template.md. A brief that
// names a feature outside this list is how an invented capability (e.g. "Create Memories")
// ends up on screen with nothing in the product backing it.
const APPROVED_FOCUS = ["AI trip planner", "Group trip planning", "Booking in the plan", "Shared coordination"];
const focus = value("ProductFocus");
if (!APPROVED_FOCUS.some((f) => focus.toLowerCase().includes(f.toLowerCase()))) {
  console.error(`ProductFocus "${focus}" is not one of the approved features: ${APPROVED_FOCUS.join(", ")}`);
  process.exit(1);
}

const MODEL = process.env.IMAGE_MODEL || "gemini-3-pro-image";
const BRAND_REFS = (process.env.TRAVAFA_BRAND_REFS ||
  "assets/ref/travafa-web-reference.png,assets/ref/travafa-app-reference.png")
  .split(",").map((p) => p.trim()).filter(Boolean);
for (const ref of BRAND_REFS) {
  if (!fs.existsSync(ref)) throw new Error(`Missing Travafa brand reference: ${ref}`);
}
fs.mkdirSync(outputDir, { recursive: true });

const mime = (file) => path.extname(file).toLowerCase() === ".jpg" || path.extname(file).toLowerCase() === ".jpeg"
  ? "image/jpeg" : "image/png";
const imagePart = (file) => ({ inlineData: { data: fs.readFileSync(file).toString("base64"), mimeType: mime(file) } });
const brandParts = BRAND_REFS.map(imagePart);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const context = `
This is a reference image for a vertical Travafa marketing reel.
Product focus: ${value("ProductFocus")}
Traveller pain point: ${value("PainPoint")}
Audience/person: ${value("ICP")}
Locked character styling: ${value("CharacterStyle")}
Setting: ${value("Setting")}
Visual tone: ${value("ReferenceTone")}
Phone action: ${value("PhoneShotAction")}

The attached images are authoritative Travafa web and mobile-app visual references. Carry
their mint-aqua background, white rounded cards, deep-teal actions, generous rounded
corners, soft shadows, clean geometric type and calm modern travel-app feel into the image.
When a Travafa phone screen appears, it must clearly read as Travafa and use this same visual
language. Do not show another app, another brand, watermarks, subtitles or gibberish text.
`.trim();

async function generate(filename, prompt, extraParts = []) {
  const file = path.join(outputDir, filename);
  if (process.env.RESUME === "1" && fs.existsSync(file) && fs.statSync(file).size > 0) {
    console.log(`reusing ${filename}`);
    return file;
  }
  console.log(`generating ${filename} with ${BRAND_REFS.length} Travafa UI references`);
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ parts: [...brandParts, ...extraParts, { text: `${context}\n\n${prompt}` }] }],
    config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16" } },
  });
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error(`No image returned for ${filename}: ${JSON.stringify(res).slice(0, 500)}`);
  fs.writeFileSync(file, Buffer.from(part.inlineData.data, "base64"));
  return file;
}

const character = await generate("character.png", `
Create a waist-up documentary identity portrait of the person described above. Natural skin
texture, believable hair and wardrobe, subtle expression appropriate to the pain point.
This exact face, hairstyle, clothing and accessories must remain unchanged in later images.
No phone, no text, no logos and no other people. Keep the setting's lighting direction and
colour grade without making the background the subject.`);

const hero = await generate("hero-phone.png", `
The additional attached image is character.png and is authoritative for the person's face,
hair, body proportions, wardrobe and accessories. Create the same person in the stated
setting, naturally performing the phone action. They hold a modern phone with realistic
hands and fingers. The screen is front-facing enough to be readable in the central 66% of
the vertical frame and visibly shows the selected Travafa feature in the supplied Travafa
design language. Preserve the app's mint, white-card and deep-teal design; make the Travafa
wordmark clear and readable. Do not claim a completed booking, payment or confirmation unless
the product focus explicitly concerns a screen that visibly supports it. No other app,
brand, overlay, selfie stick or camera phone.`, [imagePart(character)]);

const environment = await generate("environment.png", `
Create a people-free wide environmental plate for the stated setting. Show the correct light
direction, depth, objects, textures and palette that will surround the person. Leave the
central vertical safe area plausible for the character and phone. Include only objects that
support the pain point. No visible text, logos, UI or people.`);

const manifest = {
  product_focus: value("ProductFocus"),
  brand_references: BRAND_REFS,
  images: { character, hero_phone: hero, environment },
  constraints: {
    character: "identity and wardrobe source of truth",
    hero_phone: "identity plus Travafa feature and phone-handling source of truth",
    environment: "setting, lighting and palette source of truth",
  },
};
fs.writeFileSync(path.join(outputDir, "references.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\nreference pack → ${outputDir}`);
