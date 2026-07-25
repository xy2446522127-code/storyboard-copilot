import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sources = [
  "frontend/index.html",
  "frontend/assets/index-DTdX5WAD.js",
  "frontend/assets/window-CIyEo8f3.js",
];
const extensions = "png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf";
const pattern = new RegExp(String.raw`["'\x60](\/[^"'\x60\s]+?\.(?:${extensions}))["'\x60]`, "gi");
const references = new Set();

for (const source of sources) {
  const content = readFileSync(resolve(root, source), "utf8");
  for (const match of content.matchAll(pattern)) references.add(match[1]);
}

const missing = [...references].filter((reference) => !existsSync(resolve(root, "frontend", `.${reference}`)));
for (const reference of missing) console.log(`missing: ${reference}`);
console.log(`referenced=${references.size} missing=${missing.length}`);
if (missing.length) process.exitCode = 1;
