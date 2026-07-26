import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const mode = config?.bundle?.windows?.webviewInstallMode;
if (mode?.type !== "fixedRuntime" || typeof mode.path !== "string" || !mode.path.startsWith("./webview2-runtime/")) {
  throw new Error("Windows releases must use an F-drive bundled fixed WebView2 runtime, not a system installer.");
}

const prepare = readFileSync(resolve(root, "scripts/prepare-fixed-webview-runtime.ps1"), "utf8");
if (!prepare.includes("msedgewebview2.exe") || !prepare.includes("msedge.sf.dl.delivery.mp.microsoft.com")) {
  throw new Error("Fixed WebView2 preparation script is incomplete or no longer uses the official Microsoft source.");
}

console.log("Fixed WebView2 release configuration passed.");
