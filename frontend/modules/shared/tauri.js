export const invoke = (command, args = {}) => {
  const runtime = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
  if (!runtime) return Promise.reject(new Error("花海画布桌面能力不可用：请在桌面程序中打开。"));
  return runtime(command, args);
};

export const projectHomepage = "https://github.com/xy2446522127-code/storyboard-copilot";

export function toast(message, tone = "info") {
  const container = document.getElementById("huahai-toast-stack") || (() => {
    const node = document.createElement("div");
    node.id = "huahai-toast-stack";
    node.className = "huahai-toast-stack";
    document.body.append(node);
    return node;
  })();
  const item = document.createElement("div");
  item.className = `huahai-toast huahai-toast--${tone}`;
  item.textContent = String(message);
  container.append(item);
  window.setTimeout(() => item.remove(), 4800);
}

export function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function selectedFlowNodeIds() {
  return [...document.querySelectorAll(".react-flow__node.selected, .xyflow__node.selected")]
    .map((node) => node.dataset.id || node.getAttribute("data-id") || node.id?.replace(/^reactflow__node-/, ""))
    .filter(Boolean);
}
