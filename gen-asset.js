// Generates the still assets that get passed to Veo as reference images.
//
// A still is where the interface can be made correct: image models spell far better than
// video models, and a single frame can be inspected and regenerated cheaply. Veo then
// holds whatever the reference shows, instead of inventing an app every eight seconds.
//
// Usage: node gen-asset.js <preset> <out.png>

import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.IMAGE_MODEL || "gemini-3-pro-image";

// The real app's design language, sampled from screenshots in assets/app/. Kept in one
// place so the placeholder screens and the real ones stay recognisably the same product.
const DESIGN = `
The app's visual language, which must be followed exactly:
- background is a soft mint aqua, hex #C2FCEE
- content sits on pure white cards with very generous rounded corners and soft shadows
- accents are bright teal #09CFB7; the main action button is deep teal #288A82
- selected states are near-black fully rounded pills with white text
- icons sit in small pastel-tinted rounded squares
- typography is a clean geometric sans, headings bold and dark slate
- everything is rounded; nothing has sharp corners
- the wordmark reads "Travafa" in dark slate, set beside a small rounded teal-to-green mark
`.trim();

const SHOT = `
A product photograph of a modern iPhone, shown alone with nothing else in the frame.
The phone is straight on to the camera, perfectly square, with no perspective tilt and no
rotation. It fills about three quarters of the image height and is centred. The background
is a plain, evenly lit light grey studio sweep with no objects, no texture and no shadows
cast across it. Lighting is soft, broad and even, with no glare, no hotspots and no
reflections anywhere on the glass, so every detail of the screen stays legible. The screen
is in sharp focus, bright, and rendered as crisp flat vector interface pixels rather than a
photographed glowing display. No hands, no props, no packaging, no other devices.
`.trim();

const PRESETS = {
  results: `${SHOT}

The screen shows a flight results page for the travel booking app Travafa.

${DESIGN}

Screen content, laid out top to bottom:
- a slim mint header with the Travafa wordmark, and beneath it a compact route line reading
  "Mumbai (BOM) to Delhi (DEL)" with a smaller grey line under it reading "28 Aug, 1 Adult"
- a row of small rounded filter chips reading "Recommended", "Cheapest", "Sort", "Filter",
  with "Recommended" selected as a dark pill
- three white flight cards stacked with clear spacing. Each card shows an airline name on the
  left, a departure and arrival time in bold dark text, a small grey duration line reading
  "2h 20m Non-Stop", and on the right a large bold price in Indian rupees. The three prices
  read exactly "₹6,041", "₹6,097" and "₹6,201"
- every word on the screen must be real, correctly spelled English or a rupee price. No
  invented words, no scrambled letters, no placeholder gibberish.
- do NOT use any real airline name or airline logo. Each card carries a small plain
  rounded square in a muted colour where a carrier mark would sit, and a neutral label
  reading "Direct". Real carrier branding cannot appear in an advertisement, and a video
  model asked to reproduce one will render it badly.`,

  search: `${SHOT}

The screen shows the flight search page for the travel booking app Travafa.

${DESIGN}

Screen content, laid out top to bottom:
- a mint header with a bold dark heading reading "Where to next?" and a smaller grey line
  beneath reading "Flights, stays and activities"
- a white card holding four rounded category tiles in a row, labelled "Flights", "Hotels",
  "Activities", "Transfers", with "Flights" selected
- a pill toggle with "One-way" selected as a dark pill and "Round-trip" unselected
- a white form card with four labelled rows reading "FROM Mumbai (BOM)", "TO Delhi (DEL)",
  "DEPART 28 Aug", and "TRAVELLERS 1 Adult"
- a wide deep teal button at the bottom reading "Search Flights"
- every word on the screen must be real, correctly spelled English. No invented words, no
  scrambled letters, no placeholder gibberish.`,
};

PRESETS.results_bali = `${SHOT}

The screen shows a flight results page for the travel booking app Travafa.

${DESIGN}

Screen content, laid out top to bottom:
- a slim mint header. The small rounded teal-to-green mark sits to the LEFT of the word
  "Travafa"
- beneath it a route line in bold dark text reading "Bengaluru (BLR) to Denpasar (DPS)",
  and a smaller grey line under it reading "12 Sep, 2 Adults"
- a row of small rounded chips reading "Recommended", "Cheapest", "Sort", "Filter", with
  "Recommended" selected as a dark pill. All four chips fit inside the screen
- three white flight cards, each showing a DIFFERENT flight. Reading down, the three cards
  are exactly:
    card 1 -- "01:15 BLR" arrow "13:40 DPS", under it "7h 45m . 1 stop", price "₹28,410"
    card 2 -- "06:50 BLR" arrow "20:05 DPS", under it "8h 25m . 1 stop", price "₹31,180"
    card 3 -- "23:30 BLR" arrow "12:10 DPS", under it "6h 55m . 1 stop", price "₹34,900"
- each card carries one small plain rounded square in a muted colour on the left where a
  carrier mark would sit. The square is empty. There is no airline name and no airline logo
  anywhere, and no card repeats the same times or the same price as another
- prices are in Indian rupees only. No dollar signs anywhere on the screen
- a wide deep teal button across the bottom, clearly labelled "View more flights" in white.
  The button is never blank
- every word on the screen must be real, correctly spelled English or a rupee price. No
  invented words, no scrambled letters, no duplicated labels, no placeholder gibberish`;

PRESETS.search_bali = PRESETS.search
  .split("Mumbai (BOM)").join("Bengaluru (BLR)")
  .split("Delhi (DEL)").join("Denpasar (DPS)")
  .split("DEPART 28 Aug").join("DEPART 12 Sep")
  .split("1 Adult").join("2 Adults");

PRESETS.traveller = `A clean, well-lit reference photograph of one South Indian woman in her late twenties,
shown alone from the waist up, facing the camera almost straight on with her head turned
very slightly. She has a wheatish complexion, soft South Indian features with a rounded
face and expressive dark brown eyes, thick dark wavy hair loosely tied back with a few
strands falling at the temples, small gold studs in her ears, natural minimal makeup, and
a calm neutral expression with her mouth closed. She wears a plain cream linen shirt with
the sleeves rolled to the elbow, no patterns and no other jewellery.

The background is a plain, evenly lit pale grey studio wall with nothing on it. Lighting
is soft and broad from the front left, with gentle shadow on the right side of her face,
no harsh contrast and no coloured light. Realistic skin texture with visible pores and
fine flyaway hair, natural documentary photography, shallow depth of field, portrait lens.

She is the only person in the frame. No phone, no props, no furniture, no text anywhere.`;

PRESETS.bare_phone = `A product photograph of a modern iPhone shown alone with nothing else in the frame.
The phone is straight on to the camera, perfectly square, with no perspective tilt and no
rotation. It fills about three quarters of the image height and is centred.

The screen is switched on but completely blank: a plain, even, soft off-white panel with
no icons, no text, no interface, no wallpaper and no colour gradient. Nothing is displayed
on it at all.

The background is a plain, evenly lit light grey studio sweep with no objects and no
texture. Lighting is soft, broad and even, with no glare, no hotspots and no reflections
anywhere on the glass or the metal edges. The device body, its rounded corners, its side
buttons and its camera housing are all sharp and clearly visible.

No hands, no props, no packaging, no other devices, no text anywhere in the image.`;

const [, , preset, out] = process.argv;
if (!PRESETS[preset] || !out) {
  console.error(`usage: node gen-asset.js <${Object.keys(PRESETS).join("|")}> <out.png>`);
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const res = await ai.models.generateContent({
  model: MODEL,
  contents: [{ parts: [{ text: PRESETS[preset] }] }],
  config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:4" } },
});

const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
if (!part) {
  console.error("no image returned:", JSON.stringify(res).slice(0, 500));
  process.exit(1);
}
fs.writeFileSync(out, Buffer.from(part.inlineData.data, "base64"));
console.log(`${preset} → ${out} (${(fs.statSync(out).size / 1e3).toFixed(0)} KB, ${part.inlineData.mimeType})`);
