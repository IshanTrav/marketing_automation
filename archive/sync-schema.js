// Mirrors the live dial set into the response schema. Run this after editing dials.json.
//
// Drift here is silent and expensive: a schema listing a dial that no longer exists makes
// the model echo a phantom value, and one missing a new dial makes verification quietly
// incomplete. Both happened before this existed.
//
// Usage: node sync-schema.js [prompts/response-schema.v4.json]

import fs from "node:fs";

const schemaPath = process.argv[2] || "prompts/response-schema.v4.json";
const sc = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const dials = JSON.parse(fs.readFileSync("dials.json", "utf8"));

const names = Object.keys(dials.dials)
  .filter((n) => !n.startsWith("$") && dials.dials[n].applies_to.includes("reel"));

const props = {};
for (const n of names) props[n] = { type: "string" };
sc.properties.dials_used.properties = props;
sc.properties.dials_used.required = names;
sc.properties.dials_used.propertyOrdering = names;

fs.writeFileSync(schemaPath, JSON.stringify(sc, null, 2) + "\n");
console.log(`${schemaPath}: dials_used mirrors ${names.length} reel dials`);
