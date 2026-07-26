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

const shellStyles = readFileSync(resolve(root, "frontend/modules/styles/shell.css"), "utf8");
if (!shellStyles.includes('img[src="/zy-logo.jpg"]') || !shellStyles.includes('url("/huahai-canvas.png")')) {
  throw new Error("Recovered header logo must render the 花海画布 icon without React DOM mutation.");
}

const blankCanvasDrop = readFileSync(resolve(root, "frontend/modules/features/canvas/blank-image-drop.js"), "utf8");
if (blankCanvasDrop.includes("window.prompt") || !blankCanvasDrop.includes("savedProjectAfterLegacySave")) {
  throw new Error("Blank-canvas drops must target the just-saved legacy project without an ambiguous project picker.");
}
if (!blankCanvasDrop.includes("LEGACY_SAVE_TIMEOUT_MS") || blankCanvasDrop.includes("|| after[0] || null")) {
  throw new Error("Blank-canvas drops must wait for one unambiguous legacy save and must not guess a project.");
}

const sidebar = readFileSync(resolve(root, "frontend/modules/features/sidebar/sidebar.js"), "utf8");
if (!sidebar.includes('event.clientX <= 3') || !sidebar.includes('sidebar.addEventListener("pointerleave", close)')) {
  throw new Error("Sidebar must retain the non-overlay left-edge reveal and immediate pointer-leave close behavior.");
}
if (/addEventListener\(["'](?:dragover|drop)["']/.test(sidebar)) {
  throw new Error("Sidebar must not register drag/drop handlers that could intercept the legacy canvas.");
}
if (!sidebar.includes('if (active && !sidebar.contains(document.activeElement))')) {
  throw new Error("Sidebar must auto-collapse when the recovered canvas mounts, unless keyboard focus is inside it.");
}

console.log(`Recovered frontend assets, ${scripts.length - 1} modules, and credential scan passed.`);
