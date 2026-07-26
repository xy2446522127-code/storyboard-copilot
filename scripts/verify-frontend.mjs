import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const assets = [
  "frontend/index.html",
  "frontend/huahai-canvas.png",
  "frontend/module-loader.js",
  "frontend/legacy-network-guard.js",
  "frontend/modules/app-shell.js",
  "frontend/modules/features/announcements/announcements.js",
  "frontend/modules/features/announcements/announcements.css",
  "frontend/modules/features/performance/media-performance.js",
  "frontend/modules/features/performance/media-performance.css",
  "frontend/modules/shared/tauri.js",
  "frontend/assets/index-DTdX5WAD.js",
  "frontend/assets/index-Du98eh5K.css",
  "frontend/assets/window-CIyEo8f3.js",
  "frontend/assets/event-C2tqEC6O.js",
  "frontend/qr-contact.jpg",
  "announcements.json",
];

for (const file of assets) {
  const content = readFileSync(resolve(root, file));
  if (content.length === 0) throw new Error(`${file} is empty`);
}

const announcementFeed = JSON.parse(readFileSync(resolve(root, "announcements.json"), "utf8"));
if (announcementFeed.schemaVersion !== 1 || !Array.isArray(announcementFeed.announcements)) {
  throw new Error("announcements.json must use schemaVersion 1 and an announcements array.");
}

function walkScripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return walkScripts(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

const scripts = [resolve(root, "frontend/assets/index-DTdX5WAD.js"), ...walkScripts(resolve(root, "frontend/modules"))];
for (const script of scripts) {
  const content = readFileSync(script, "utf8");
  if (/sk-[a-f0-9]{32}/i.test(content)) {
    throw new Error(`${script} still contains an embedded API key.`);
  }
  // Optional modules are allowed to observe the recovered root, but never to
  // hide or replace it.  This regression gate prevents the old whole-page
  // workspace mistake from silently returning in a later feature branch.
  if (/legacyRoot\s*\.hidden\s*=\s*true|#root\s*\{[^}]*display\s*:\s*none/is.test(content)) {
    throw new Error(`${script} attempts to hide the recovered legacy root.`);
  }
}

console.log(`Recovered frontend assets, ${scripts.length - 1} modules, and credential scan passed.`);
