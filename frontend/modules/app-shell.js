import { installBranding } from "./features/branding/branding.js";
import { installSidebar } from "./features/sidebar/sidebar.js";
import { installApiSettings } from "./features/api/api-settings.js";
import { installImageStudio } from "./features/image/image-studio.js";
import { installChatPanel } from "./features/chat/chat.js";
import { installCanvasBatchTools } from "./features/canvas/batch-tools.js";
import { installAnnouncements } from "./features/announcements/announcements.js";
import { installMediaPerformance } from "./features/performance/media-performance.js";
import { installUpdateButton } from "./features/update/update.js";

function boot() {
  installBranding();
  const apiSettings = installApiSettings();
  const imageStudio = installImageStudio({ openApiSettings: () => apiSettings.open() });
  const announcements = installAnnouncements();
  // The recovered application still owns several production-only creation tools.
  // Keep it as the default until each replacement workspace has independently passed
  // real project regression tests; preview code must never hide or replace #root.
  const chat = installChatPanel({ openApiSettings: () => apiSettings.open() });
  installSidebar({ openChat: () => chat.open(), openAnnouncements: () => announcements.open(), openApiSettings: () => apiSettings.open(), openImageStudio: () => imageStudio.open() });
  installCanvasBatchTools();
  installMediaPerformance();
  installUpdateButton();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
