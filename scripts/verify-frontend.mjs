import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const assets = [
  "frontend/index.html",
  "frontend/update.js",
  "frontend/assets/index-DTdX5WAD.js",
  "frontend/assets/index-Du98eh5K.css",
  "frontend/assets/window-CIyEo8f3.js",
  "frontend/assets/event-C2tqEC6O.js",
  "frontend/zy-logo.jpg",
  "frontend/qr-contact.jpg",
];

for (const file of assets) {
  const content = readFileSync(resolve(root, file));
  if (content.length === 0) throw new Error(`${file} is empty`);
}

for (const script of ["frontend/assets/index-DTdX5WAD.js", "frontend/update.js"]) {
  const content = readFileSync(resolve(root, script), "utf8");
  if (/sk-[a-f0-9]{32}/i.test(content)) {
    throw new Error(`${script} still contains an embedded API key.`);
  }
}

console.log("Recovered frontend assets and credential scan passed.");
