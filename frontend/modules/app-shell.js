import { installBranding } from "./features/branding/branding.js";
import { installSidebar } from "./features/sidebar/sidebar.js";
import { installApiSettings } from "./features/api/api-settings.js";
import { installLegacyModelBridge } from "./features/api/legacy-model-bridge.js";
import { installImageStudio } from "./features/image/image-studio.js";
import { installChatPanel } from "./features/chat/chat.js";
import { installCanvasBatchTools } from "./features/canvas/batch-tools.js";
import { installBlankCanvasImageDrop } from "./features/canvas/blank-image-drop.js";
import { installAssetDropImport } from "./features/assets/asset-drop-import.js";
import { installAnnouncements } from "./features/announcements/announcements.js";
import { installMediaPerformance } from "./features/performance/media-performance.js";
import { installUpdateButton } from "./features/update/update.js";

function boot() {
  // Optional features are intentionally isolated.  A failed enhancement must
  // never prevent the recovered legacy canvas from starting or receiving input.
  const optional = (name, installer, fallback = null) => {
    try { return installer(); }
    catch (error) { console.error(`[花海画布] ${name} 未加载`, error); return fallback; }
  };
  optional("品牌", installBranding);
  const apiSettings = optional("API 设置", installApiSettings, { open: () => {} });
  optional("旧版模型选择", installLegacyModelBridge);
  const imageStudio = optional("在线生图", () => installImageStudio({ openApiSettings: () => apiSettings.open() }), { open: () => {} });
  const announcements = optional("公告", installAnnouncements, { open: () => {} });
  // The recovered application still owns several production-only creation tools.
  // Keep it as the default until each replacement workspace has independently passed
  // real project regression tests; preview code must never hide or replace #root.
  const chat = optional("创作助手", () => installChatPanel({ openApiSettings: () => apiSettings.open() }), { open: () => {} });
  optional("侧栏", () => installSidebar({ openChat: () => chat.open(), openAnnouncements: () => announcements.open(), openApiSettings: () => apiSettings.open(), openImageStudio: () => imageStudio.open() }));
  optional("空白画布拖图", installBlankCanvasImageDrop);
  optional("素材库拖入", installAssetDropImport);
  optional("批量画布工具", installCanvasBatchTools);
  optional("媒体性能优化", installMediaPerformance);
  optional("更新检查", installUpdateButton);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
