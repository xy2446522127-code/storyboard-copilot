import { invoke, toast } from "../../shared/tauri.js";

const entries = [
  ["projects", "projects", "项目管理"],
  ["image", "image", "在线生图"],
  ["chat", "chat", "GPT 对话"],
  ["canvas", "canvas", "无限画布"],
  ["assets", "assets", "素材库"],
];

// Keep the navigation self-contained: no icon font, emoji fallback, or network
// request can make an essential control disappear in an offline desktop build.
const iconMarkup = (name, label = "") => {
  const paths = {
    projects: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l1.7 2H18.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M3 9h18"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-4.5-4.5L6 20"/>',
    chat: '<path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/><path d="M8 10h8M8 14h5"/>',
    canvas: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    assets: '<path d="M4 4h16v16H4z"/><path d="M7 8h10M7 12h10M7 16h7"/>',
    other: '<path d="M7 4 17 12 7 20"/>',
    announcement: '<path d="M4 10v4h3l5 4V6l-5 4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
    api: '<path d="M7 8h10M7 16h10M4 12h16"/><circle cx="7" cy="8" r="2"/><circle cx="17" cy="16" r="2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06A1.7 1.7 0 0 0 15.74 18a1.7 1.7 0 0 0-1.02 1.56V20h-3v-.44A1.7 1.7 0 0 0 10.7 18a1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7.04 14.3 1.7 1.7 0 0 0 5.5 13.28H5v-3h.5A1.7 1.7 0 0 0 7.04 9.26 1.7 1.7 0 0 0 6.7 7.38l-.06-.06L8.76 5.2l.06.06A1.7 1.7 0 0 0 10.7 5.6a1.7 1.7 0 0 0 1.02-1.56V3.6h3v.44a1.7 1.7 0 0 0 1.02 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.02h.44v3h-.44A1.7 1.7 0 0 0 19.4 15z"/>',
    homepage: '<path d="M4 4h16v16H4z"/><path d="M9 15 15 9M10 9h5v5"/>',
    update: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v6h-6M12 8v8M9 13l3 3 3-3"/>',
    collapse: '<path d="m14 6-6 6 6 6"/>',
  };
  return `<svg class="huahai-sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.assets}</svg><span class="huahai-sidebar-label">${label}</span>`;
};

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
        <button class="huahai-sidebar__collapse" type="button" title="收起侧栏" aria-label="收起侧栏">${iconMarkup("collapse")}</button>
      </div>
      <nav class="huahai-sidebar__nav">
        ${entries.map(([key, icon, label]) => `<button class="huahai-nav-button" type="button" data-nav="${key}" aria-label="${label}">${iconMarkup(icon, label)}</button>`).join("")}
      </nav>
      <button class="huahai-sidebar__section" type="button" aria-expanded="false">${iconMarkup("other", "其他功能")}</button>
      <nav class="huahai-sidebar__extra" aria-label="其他功能">
        <button type="button" data-nav="announcements" aria-label="公告">${iconMarkup("announcement", "公告")}</button>
      </nav>
      <div class="huahai-sidebar__spacer"></div>
      <div class="huahai-sidebar__bottom">
        <button type="button" data-nav="api" aria-label="API 设置">${iconMarkup("api", "API 设置")}</button>
        <button type="button" data-nav="settings" aria-label="更多设置">${iconMarkup("settings", "更多设置")}</button>
        <button type="button" data-nav="homepage" aria-label="项目主页">${iconMarkup("homepage", "项目主页")}</button>
      </div>
      <div class="huahai-sidebar__version-row">
        <span class="huahai-sidebar__version" data-app-version>读取版本中…</span>
        <button type="button" class="huahai-sidebar__update" data-update-button aria-label="检查更新">${iconMarkup("update", "检查更新")}</button>
      </div>
    </aside>`;
  document.body.append(root);

  const sidebar = root.querySelector("#huahai-sidebar");
  const versionLabel = root.querySelector("[data-app-version]");
  invoke("app_version")
    .then((version) => { versionLabel.textContent = `v${version}`; })
    .catch(() => { versionLabel.textContent = "花海画布"; });

  const section = root.querySelector(".huahai-sidebar__section");
  let lastCanvasActive = null;
  let canvasSyncQueued = false;
  const syncCanvasState = () => {
    canvasSyncQueued = false;
    const active = isCanvasActive();
    if (active === lastCanvasActive) return;
    lastCanvasActive = active;
    document.body.classList.toggle("huahai-canvas-active", active);
    // A recovered canvas owns the full viewport.  Do not leave the optional
    // navigation overlay open while that canvas mounts: it can conceal the
    // first column of nodes before the user has moved the pointer.  Focused
    // sidebar controls stay open for keyboard users.
    if (active && !sidebar.contains(document.activeElement)) {
      document.body.classList.remove("huahai-sidebar-open");
    }
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
