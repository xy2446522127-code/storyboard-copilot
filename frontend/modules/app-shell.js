import { installBranding } from "./features/branding/branding.js";
import { installAnnouncements } from "./features/announcements/announcements.js";
import { installMediaPerformance } from "./features/performance/media-performance.js";
import { installUpdateButton } from "./features/update/update.js";
import { installWorkspace } from "./features/workspace/workspace.js";

function boot() {
  installBranding();
  const announcements = installAnnouncements();
  installWorkspace({ openAnnouncements: () => announcements.open() });
  installMediaPerformance();
  installUpdateButton();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
