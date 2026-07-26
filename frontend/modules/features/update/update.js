import { invoke, toast } from "../../shared/tauri.js";

function displayDate(value) {
  if (!value) return "未提供发布日期";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleDateString("zh-CN");
}

export function installUpdateButton() {
  const button = document.querySelector("[data-update-button]");
  if (!window.__TAURI_INTERNALS__ || !button || button.dataset.ready === "true") return;
  button.dataset.ready = "true";
  let available = null;
  const render = (update) => {
    available = update || null;
    if (!update) {
      button.classList.remove("is-available");
      button.textContent = "检查更新";
      button.title = "检查花海画布更新";
      return;
    }
    button.classList.add("is-available");
    button.textContent = `更新 v${update.version}`;
    button.title = `发现 v${update.version}，更新日期：${displayDate(update.date)}`;
  };
  const check = async (interactive) => {
    if (button.disabled) return;
    button.disabled = true;
    const before = available;
    button.textContent = "检查中…";
    try {
      const update = await invoke("check_for_update");
      render(update);
      if (!update) {
        if (interactive) toast("花海画布已是最新版本。", "success");
        return;
      }
      if (!interactive) return;
      const notes = String(update.notes || "本次版本包含功能优化与问题修复。").slice(0, 1200);
      const message = `发现花海画布 v${update.version}\n更新日期：${displayDate(update.date)}\n\n${notes}\n\n安装前请先保存当前内容。现在下载、验签并安装吗？`;
      if (!window.confirm(message)) return;
      button.textContent = "下载并验签中…";
      await invoke("install_available_update");
    } catch (error) {
      render(before);
      if (interactive) toast(`更新服务暂不可用：${String(error)}`, "error");
    } finally {
      button.disabled = false;
    }
  };
  button.addEventListener("click", () => check(true));
  window.setTimeout(() => check(false), 2500);
}
