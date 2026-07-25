import { invoke, projectHomepage, toast } from "../../shared/tauri.js";

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

export function installSidebar({ openChat, openAnnouncements }) {
  const root = document.createElement("div");
  root.id = "huahai-module-root";
  root.innerHTML = `
    <div id="huahai-sidebar-hotzone" aria-hidden="true"></div>
    <aside id="huahai-sidebar" aria-label="花海画布导航">
      <div class="huahai-sidebar__head">
        <img class="huahai-sidebar__logo" src="/huahai-canvas.png" alt="花海画布" />
        <span class="huahai-sidebar__brand">花海画布</span>
        <button class="huahai-sidebar__collapse" type="button" title="收起侧栏">‹</button>
      </div>
      <button class="huahai-sidebar__section" type="button" aria-expanded="false">›&nbsp;&nbsp;其他功能</button>
      <nav class="huahai-sidebar__nav">
        ${entries.map(([key, icon, label]) => `<button class="huahai-nav-button" type="button" data-nav="${key}"><span class="huahai-nav-icon">${icon}</span>${label}</button>`).join("")}
      </nav>
      <div class="huahai-sidebar__spacer"></div>
      <div class="huahai-sidebar__bottom">
        <button type="button" data-nav="api">⛓&nbsp;&nbsp;API 设置</button>
        <button type="button" data-nav="settings">⚙&nbsp;&nbsp;更多设置</button>
        <button type="button" data-nav="homepage">◉&nbsp;&nbsp;项目主页</button>
      </div>
      <div class="huahai-sidebar__version" data-app-version>正在读取版本…</div>
    </aside>`;
  document.body.append(root);

  const announcementButton = document.createElement("button");
  announcementButton.type = "button";
  announcementButton.dataset.nav = "announcements";
  announcementButton.textContent = "公告";
  root.querySelector(".huahai-sidebar__bottom").prepend(announcementButton);

  const sidebar = root.querySelector("#huahai-sidebar");
  const versionLabel = root.querySelector("[data-app-version]");
  invoke("app_version")
    .then((version) => { versionLabel.textContent = `v${version} · 本地优先`; })
    .catch(() => { versionLabel.textContent = "花海画布 · 本地优先"; });
  const section = root.querySelector(".huahai-sidebar__section");
  let hideTimer;
  const open = () => {
    document.body.classList.add("huahai-sidebar-open");
    if (isCanvasActive()) document.body.classList.add("huahai-canvas-active");
  };
  const close = () => document.body.classList.remove("huahai-sidebar-open");
  const scheduleClose = () => {
    window.clearTimeout(hideTimer);
    if (!isCanvasActive() || sidebar.contains(document.activeElement)) return;
    hideTimer = window.setTimeout(close, 10_000);
  };
  open();
  root.querySelector("#huahai-sidebar-hotzone").addEventListener("pointerenter", open);
  sidebar.addEventListener("pointerenter", () => window.clearTimeout(hideTimer));
  sidebar.addEventListener("pointerleave", scheduleClose);
  sidebar.addEventListener("focusin", () => window.clearTimeout(hideTimer));
  sidebar.addEventListener("focusout", () => window.setTimeout(scheduleClose, 0));
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
      window.open(projectHomepage, "_blank", "noopener,noreferrer");
      return;
    }
    if (action === "projects") {
      const native = findNativeControl("项目管理");
      if (native && native !== button) native.click();
      else window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (action === "assets") {
      const native = findNativeControl("素材库");
      if (native) native.click(); else toast("请先打开一个项目，再进入素材库。", "info");
      return;
    }
    if (action === "image") {
      const native = findNativeControl("在线生图") || findNativeControl("生图");
      if (native) native.click(); else toast("请先打开项目，在画布节点中使用在线生图。", "info");
      return;
    }
    if (action === "canvas") {
      if (isCanvasActive()) { close(); return; }
      toast("请从项目管理打开项目，即可进入无限画布。", "info");
      return;
    }
    if (action === "api" || action === "settings") {
      const native = findNativeControl(action === "api" ? "API 设置" : "设置");
      if (native) native.click(); else toast("设置入口由现有工具栏提供；API 密钥只保存在本机。", "info");
    }
  });

  // The original recovered frontend mounts asynchronously.  Re-evaluate the mode once
  // its React Flow canvas appears, then use the requested 10-second project auto-hide.
  new MutationObserver(() => {
    if (isCanvasActive()) {
      document.body.classList.add("huahai-canvas-active");
      scheduleClose();
    }
  }).observe(document.getElementById("root"), { childList: true, subtree: true });

  // Ensure the local database is reachable early without reading any API setting.
  invoke("list_project_summaries").catch(() => {});
  window.addEventListener("huahai:media-load", (event) => {
    const count = Number(event.detail?.count || 0);
    toast(`当前画布已有 ${count} 个媒体项：已启用懒加载与离屏视频暂停。建议按项目拆分超大画布。`, "info");
  });
  return { open, close };
}
