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

// The recovered application has been built with more than one React Flow
// version. Some versions mark a selection with `.selected`, while others use
// `aria-selected` or `data-selected`. Keep this list here rather than making
// every canvas plug-in guess a single DOM shape.
export const flowNodeSelector = [
  ".react-flow__node",
  ".xyflow__node",
].join(", ");

const selectedFlowNodeSelector = [
  ".react-flow__node.selected",
  ".xyflow__node.selected",
  ".react-flow__node[aria-selected=\"true\"]",
  ".xyflow__node[aria-selected=\"true\"]",
  ".react-flow__node[data-selected=\"true\"]",
  ".xyflow__node[data-selected=\"true\"]",
].join(", ");

function flowNodeId(node) {
  return node.dataset.id
    || node.getAttribute("data-id")
    || node.id?.replace(/^(?:reactflow|react-flow|xyflow)__node-/, "")
    || null;
}

export function selectedFlowNodes() {
  const unique = new Map();
  document.querySelectorAll(selectedFlowNodeSelector).forEach((node) => {
    const id = flowNodeId(node);
    if (id) unique.set(id, node);
  });
  return [...unique.entries()].map(([id, element]) => ({ id, element }));
}

export function selectedFlowNodeIds() {
  return selectedFlowNodes().map(({ id }) => id);
}
