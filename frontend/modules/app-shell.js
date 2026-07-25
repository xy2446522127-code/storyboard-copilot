import { installBranding } from "./features/branding/branding.js";
import { installSidebar } from "./features/sidebar/sidebar.js";
import { installChatPanel } from "./features/chat/chat.js";
import { installCanvasBatchTools } from "./features/canvas/batch-tools.js";
import { installUpdateButton } from "./features/update/update.js";

function boot() {
  installBranding();
  const chat = installChatPanel();
  installSidebar({ openChat: () => chat.open() });
  installCanvasBatchTools();
  installUpdateButton();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
