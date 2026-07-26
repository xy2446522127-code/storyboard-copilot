import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "frontend/modules/features/performance/media-performance.js"), "utf8");
const stylesheet = readFileSync(resolve(root, "frontend/modules/features/performance/media-performance.css"), "utf8");

for (const requirement of [
  "const MAX_ACTIVE_VIDEOS = 4",
  "new IntersectionObserver",
  "media.pause()",
  "record.addedNodes",
  "requestAnimationFrame",
]) {
  if (!source.includes(requirement)) throw new Error(`Media performance guard missing: ${requirement}`);
}
if (source.includes("setInterval(")) throw new Error("Media performance must not use recurring full-canvas polling.");
if (!stylesheet.includes("content-visibility: auto")) throw new Error("Media performance stylesheet must preserve content visibility containment.");

console.log("Media performance guard passed.");
