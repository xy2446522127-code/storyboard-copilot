const FEED_URL = "https://raw.githubusercontent.com/xy2446522127-code/storyboard-copilot/main/announcements.json";
const READ_KEY = "huahai-canvas:read-announcement-ids:v1";
const MAX_ITEMS = 30;

function readIds() {
  try {
    const value = JSON.parse(localStorage.getItem(READ_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
  } catch { return new Set(); }
}

function saveIds(ids) {
  localStorage.setItem(READ_KEY, JSON.stringify([...ids].slice(-200)));
}

function validAnnouncement(value) {
  if (!value || typeof value !== "object") return false;
  if (!["info", "success", "warning", "error"].includes(value.level || "info")) return false;
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9._-]{3,100}$/.test(value.id)) return false;
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 140) return false;
  return typeof value.body === "string" && value.body.length <= 4000;
}

function activeAnnouncements(feed) {
  const now = Date.now();
  const list = Array.isArray(feed?.announcements) ? feed.announcements : [];
  return list.filter(validAnnouncement).filter((item) => {
    const expires = item.expiresAt ? Date.parse(item.expiresAt) : NaN;
    return !Number.isFinite(expires) || expires > now;
  }).slice(0, MAX_ITEMS);
}

function renderAnnouncement(item) {
  const article = document.createElement("article");
  article.className = `huahai-announcement huahai-announcement--${item.level || "info"}`;
  const title = document.createElement("h3");
  title.textContent = item.title;
  const body = document.createElement("p");
  body.textContent = item.body;
  article.append(title, body);
  if (typeof item.url === "string" && /^https:\/\//i.test(item.url)) {
    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "查看详情";
    article.append(link);
  }
  return article;
}

export function installAnnouncements() {
  const root = document.createElement("section");
  root.id = "huahai-announcement-drawer";
  root.className = "huahai-announcement-drawer";
  root.setAttribute("aria-label", "花海画布公告");
  root.innerHTML = `<div class="huahai-announcement-drawer__panel" role="dialog" aria-modal="true"><header><h2>花海画布公告</h2><button type="button" aria-label="关闭公告">×</button></header><div class="huahai-announcement-list"><p class="huahai-announcement-status">正在同步公告…</p></div></div>`;
  document.body.append(root);
  const list = root.querySelector(".huahai-announcement-list");
  const close = () => root.classList.remove("is-open");
  root.querySelector("button").addEventListener("click", close);
  root.addEventListener("click", (event) => { if (event.target === root) close(); });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });

  let current = [];
  const render = (items, error = "") => {
    list.replaceChildren();
    if (error) {
      const message = document.createElement("p");
      message.className = "huahai-announcement-status";
      message.textContent = error;
      list.append(message);
      return;
    }
    if (!items.length) {
      const message = document.createElement("p");
      message.className = "huahai-announcement-status";
      message.textContent = "当前没有公告。";
      list.append(message);
      return;
    }
    items.forEach((item) => list.append(renderAnnouncement(item)));
  };
  const sync = async ({ autoOpen = false } = {}) => {
    try {
      const response = await fetch(FEED_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const feed = await response.json();
      current = activeAnnouncements(feed);
      render(current);
      const read = readIds();
      const unread = current.filter((item) => !read.has(item.id));
      if (autoOpen && unread.length) root.classList.add("is-open");
      current.forEach((item) => read.add(item.id));
      saveIds(read);
    } catch {
      // A network outage must not stop the canvas from opening. The user can retry from the drawer.
      render([], "公告暂时无法同步；请检查网络后重新打开公告。 ");
    }
  };
  sync({ autoOpen: true });
  return { open: () => { root.classList.add("is-open"); sync(); }, close, sync };
}
