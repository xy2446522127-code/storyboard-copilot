import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
if (config?.bundle?.useLocalToolsDir !== true) {
  throw new Error("Release builds must keep Tauri packaging tools in the F-drive Cargo target directory.");
}
const mode = config?.bundle?.windows?.webviewInstallMode;
if (mode?.type !== "fixedRuntime" || typeof mode.path !== "string" || !mode.path.startsWith("./webview2-runtime/")) {
  throw new Error("Windows releases must use an F-drive bundled fixed WebView2 runtime, not a system installer.");
}

const prepare = readFileSync(resolve(root, "scripts/prepare-fixed-webview-runtime.ps1"), "utf8");
if (!prepare.includes("msedgewebview2.exe") || !prepare.includes("msedge.sf.dl.delivery.mp.microsoft.com")) {
  throw new Error("Fixed WebView2 preparation script is incomplete or no longer uses the official Microsoft source.");
}

const releaseBuild = readFileSync(resolve(root, "scripts/build-release.ps1"), "utf8");
for (const required of [
  "F:\\HuahaiBuild",
  "F:\\Huahaihuabu\\build-cache\\cargo-home",
  "F:\\Huahaihuabu\\build-cache\\npm",
  "$env:NPM_CONFIG_CACHE",
]) {
  if (!releaseBuild.includes(required)) {
    throw new Error(`Release build must keep ${required} on F:.`);
  }
}

const cargoCheck = readFileSync(resolve(root, "scripts/cargo-check.cmd"), "utf8");
for (const required of [
  "set \"CARGO_HOME=F:\\",
  "set \"CARGO_TARGET_DIR=F:\\",
  "set \"TEMP=F:\\",
  "set \"NPM_CONFIG_CACHE=F:\\",
  "rem VsDevCmd is allowed to configure the compiler, but never the storage roots.",
]) {
  if (!cargoCheck.includes(required)) {
    throw new Error(`Rust check script must keep ${required} on F:.`);
  }
}

console.log("Fixed WebView2 release configuration passed.");
