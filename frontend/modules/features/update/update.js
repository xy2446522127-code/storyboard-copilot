import { invoke, toast } from "../../shared/tauri.js";

export function installUpdateButton() {
  if (!window.__TAURI_INTERNALS__ || document.getElementById("huahai-update-button")) return;
  const button = document.createElement("button");
  button.id = "huahai-update-button";
  button.type = "button";
  button.textContent = "检查更新";
  button.title = "检查花海画布更新";
  const check = async (interactive) => {
    if (button.disabled) return;
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = "正在检查…";
    try {
      const update = await invoke("check_for_update");
      if (!update) {
        button.textContent = "检查更新";
        if (interactive) toast("花海画布已是最新版本。", "success");
        return;
      }
      button.textContent = `发现 v${update.version}`;
      button.classList.add("is-available");
      if (!interactive) return;
      const notes = String(update.notes || "本次版本包含功能优化与问题修复。").slice(0, 1200);
      if (!window.confirm(`发现花海画布 v${update.version}\n\n${notes}\n\n安装前请先保存当前内容。现在下载、验签并安装吗？`)) return;
      button.textContent = "正在下载并验证…";
      toast("正在下载并验证更新；完成后程序会自动退出并启动安装器。", "info");
      await invoke("install_available_update");
    } catch (error) {
      button.textContent = previous;
      toast(`更新服务暂不可用：${String(error)}`, "error");
    } finally {
      button.disabled = false;
    }
  };
  button.addEventListener("click", () => check(true));
  document.body.append(button);
  window.setTimeout(() => check(false), 3500);
}
