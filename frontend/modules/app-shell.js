import { installBranding } from "./features/branding/branding.js";
import { installSidebar } from "./features/sidebar/sidebar.js";
import { installChatPanel } from "./features/chat/chat.js";
import { installCanvasBatchTools } from "./features/canvas/batch-tools.js";
import { installAnnouncements } from "./features/announcements/announcements.js";
import { installMediaPerformance } from "./features/performance/media-performance.js";
import { installUpdateButton } from "./features/update/update.js";

function boot() {
  installBranding();
  const chat = installChatPanel();
  const announcements = installAnnouncements();
  installSidebar({ openChat: () => chat.open(), openAnnouncements: () => announcements.open() });
  installCanvasBatchTools();
  installMediaPerformance();
  installUpdateButton();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
