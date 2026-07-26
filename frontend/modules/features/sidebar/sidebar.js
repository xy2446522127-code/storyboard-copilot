import { invoke, toast } from "../../shared/tauri.js";

const entries = [
  ["projects", "▣", "项目管理"],
  ["image", "◎", "在线生图"],
  ["chat", "□", "GPT 对话"],
  ["canvas", "▦", "无限画布"],
  ["assets", "▤", "素材库"],
];

function findNativeControl(label) {
  return [...document.querySelectorAll("button, [role=button], a")]
    .find((element) => (element.textContent || "").trim().includes(label) || (element.title || "").includes(label));
}

function isCanvasActive() {
  return Boolean(document.querySelector(".react-flow, .xyflow"));
}

export function installSidebar({ openChat, openAnnouncements, openApiSettings, openImageStudio }) {
  const root = document.createElement("div");
  root.id = "huahai-module-root";
  root.innerHTML = `
    <aside id="huahai-sidebar" aria-label="花海画布导航">
      <div class="huahai-sidebar__head">
        <img class="huahai-sidebar__logo" src="/huahai-canvas.png" alt="花海画布" />
        <span class="huahai-sidebar__brand">花海画布</span>
        <button class="huahai-sidebar__collapse" type="button" title="收起侧栏">‹</button>
      </div>
      <nav class="huahai-sidebar__nav">
        ${entries.map(([key, icon, label]) => `<button class="huahai-nav-button" type="button" data-nav="${key}"><span class="huahai-nav-icon">${icon}</span>${label}</button>`).join("")}
      </nav>
      <button class="huahai-sidebar__section" type="button" aria-expanded="false"><span data-other-arrow>›</span>&nbsp;&nbsp;其他功能</button>
      <nav class="huahai-sidebar__extra" aria-label="其他功能">
        <button type="button" data-nav="announcements">公告</button>
      </nav>
      <div class="huahai-sidebar__spacer"></div>
      <div class="huahai-sidebar__bottom">
        <button type="button" data-nav="api">API 设置</button>
        <button type="button" data-nav="settings">更多设置</button>
        <button type="button" data-nav="homepage">项目主页</button>
      </div>
      <div class="huahai-sidebar__version-row">
        <span class="huahai-sidebar__version" data-app-version>读取版本中…</span>
        <button type="button" class="huahai-sidebar__update" data-update-button>检查更新</button>
      </div>
    </aside>`;
  document.body.append(root);

  const sidebar = root.querySelector("#huahai-sidebar");
  const versionLabel = root.querySelector("[data-app-version]");
  invoke("app_version")
    .then((version) => { versionLabel.textContent = `v${version}`; })
    .catch(() => { versionLabel.textContent = "花海画布"; });

  const section = root.querySelector(".huahai-sidebar__section");
  const otherArrow = root.querySelector("[data-other-arrow]");
  let lastCanvasActive = null;
  let canvasSyncQueued = false;
  const syncCanvasState = () => {
    canvasSyncQueued = false;
    const active = isCanvasActive();
    if (active === lastCanvasActive) return;
    lastCanvasActive = active;
    document.body.classList.toggle("huahai-canvas-active", active);
  };
  const scheduleCanvasStateSync = () => {
    if (canvasSyncQueued) return;
    canvasSyncQueued = true;
    window.requestAnimationFrame(syncCanvasState);
  };
  const open = () => {
    document.body.classList.add("huahai-sidebar-open");
    scheduleCanvasStateSync();
  };
  const close = () => {
    if (!sidebar.contains(document.activeElement)) document.body.classList.remove("huahai-sidebar-open");
  };
  open();

  // No fixed hotzone element: a transparent overlay steals canvas drag/drop events.
  const onPointerMove = (event) => {
    if (event.clientX <= 3) open();
  };
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  sidebar.addEventListener("pointerleave", close);
  sidebar.addEventListener("focusin", open);
  sidebar.addEventListener("focusout", () => window.setTimeout(close, 0));
  root.querySelector(".huahai-sidebar__collapse").addEventListener("click", close);
  section.addEventListener("click", () => {
    const expanded = section.getAttribute("aria-expanded") === "true";
    section.setAttribute("aria-expanded", String(!expanded));
    otherArrow.textContent = expanded ? "›" : "⌄";
  });

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-nav]");
    if (!button) return;
    const action = button.dataset.nav;
    if (action === "chat") return openChat();
    if (action === "announcements") return openAnnouncements();
    if (action === "homepage") {
      try { await invoke("open_project_homepage"); }
      catch { window.open("https://github.com/xy2446522127-code/storyboard-copilot", "_blank", "noopener,noreferrer"); }
      return;
    }
    if (action === "api") return openApiSettings?.();
    if (action === "image") return openImageStudio?.();
    if (action === "projects") {
      const native = findNativeControl("项目管理");
      if (native && native !== button) native.click(); else window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (action === "assets") {
      const native = findNativeControl("素材库");
      if (native) native.click(); else toast("请先打开一个项目，再进入素材库。", "info");
      return;
    }
    if (action === "canvas") {
      if (isCanvasActive()) return close();
      toast("请从项目管理打开项目，即可进入无限画布。", "info");
      return;
    }
    if (action === "settings") {
      const native = findNativeControl("设置");
      if (native) native.click(); else toast("更多设置只包含通用、外观和文件保存选项。", "info");
    }
  });

  // The recovered React application mutates deeply while rendering nodes and
  // generation progress. Coalesce those mutations so the optional sidebar
  // never repeatedly queries the whole legacy canvas in one frame.
  const observer = new MutationObserver(scheduleCanvasStateSync);
  observer.observe(document.getElementById("root"), { childList: true, subtree: true });
  window.addEventListener("pagehide", () => {
    observer.disconnect();
    document.removeEventListener("pointermove", onPointerMove);
  }, { once: true });
  invoke("list_project_summaries").catch(() => {});
  return { open, close };
}
