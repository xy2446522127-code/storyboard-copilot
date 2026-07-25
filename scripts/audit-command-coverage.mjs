import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const recoveredFrontend = readFileSync(resolve(root, "frontend/assets/index-DTdX5WAD.js"), "utf8");
const updaterFrontend = readFileSync(resolve(root, "frontend/update.js"), "utf8");
const backend = readFileSync(resolve(root, "src-tauri/src/main.rs"), "utf8");
const recovered = new Set();
for (const match of recoveredFrontend.matchAll(/N\(`([a-z][a-z0-9_]+)`/g)) recovered.add(match[1]);
const updaterCommands = new Set();
for (const match of updaterFrontend.matchAll(/invoke\('([a-z][a-z0-9_]+)'/g)) updaterCommands.add(match[1]);
const used = new Set([...recovered, ...updaterCommands]);
const implemented = new Set();
for (const match of backend.matchAll(/#\[tauri::command\][\s\S]*?fn\s+([a-z][a-z0-9_]+)/g)) implemented.add(match[1]);

const missing = [...used].filter((name) => !implemented.has(name)).sort();
const unexpected = [...implemented].filter((name) => !used.has(name)).sort();
console.log(`recovered=${recovered.size} updater=${updaterCommands.size} implemented=${implemented.size} missing=${missing.length}`);
for (const name of missing) console.log(`missing: ${name}`);
for (const name of unexpected) console.log(`unused: ${name}`);
if (missing.length) process.exitCode = 1;
