import { invoke, selectedFlowNodeIds, toast } from "../../shared/tauri.js";

const LEGACY_SAVE_TIMEOUT_MS = 4_000;
const LEGACY_SAVE_POLL_MS = 120;

export function installCanvasBatchTools() {
  const toolbar = document.createElement("div");
  toolbar.id = "huahai-canvas-batch-tools";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "多图批量操作");
  toolbar.innerHTML = `
    <button type="button" data-batch-action="connect-video">连接到生视频</button>
    <button type="button" data-batch-action="arrange-horizontal">横向排列</button>
    <button type="button" data-batch-action="arrange-vertical">纵向排列</button>
    <button type="button" data-batch-action="arrange-connected">按连线排列</button>
    <button type="button" data-batch-action="group">分组</button>
    <button type="button" data-batch-action="ungroup">解组</button>
    <button type="button" data-batch-action="undo">撤销</button>
    <button type="button" data-batch-action="redo">重做</button>
    <button type="button" data-batch-action="cancel">取消选择</button>`;
  document.body.append(toolbar);
  let selected = [];
  let refreshTimer;
  let selectionRevision = 0;

  const setImageActionAvailability = (enabled) => {
    toolbar.querySelectorAll('[data-batch-action="connect-video"], [data-batch-action="arrange-horizontal"], [data-batch-action="arrange-vertical"], [data-batch-action="arrange-connected"]')
      .forEach((button) => { button.disabled = !enabled; });
  };

  // The recovered node renderer can defer an image preview or use a CSS
  // background. Testing for a selected `<img>` therefore hides valid image
  // nodes. Ask the same persisted canvas classifier that executes the action.
  const refresh = async () => {
    selected = selectedFlowNodeIds();
    const revision = ++selectionRevision;
    const selectedNodes = [...document.querySelectorAll(".react-flow__node.selected, .xyflow__node.selected")];
    const hasGroup = selectedNodes.some((node) => (node.innerText || "").includes("分组"));
    toolbar.classList.toggle("is-visible", hasGroup || selected.length >= 2);
    setImageActionAvailability(false);
    toolbar.querySelector('[data-batch-action="group"]').disabled = selected.length < 2;
    toolbar.querySelector('[data-batch-action="ungroup"]').disabled = !hasGroup;
    if (selected.length < 2) return;
    try {
      const projectId = await invoke("find_project_for_canvas_selection", { nodeIds: selected });
      if (!projectId || revision !== selectionRevision) return;
      const preview = await invoke("preview_canvas_batch_action", { projectId, selectedNodeIds: selected });
      if (revision !== selectionRevision) return;
      const hasImages = (preview?.imageNodeIds || []).length >= 2;
      toolbar.classList.toggle("is-visible", hasImages || hasGroup);
      setImageActionAvailability(hasImages);
    } catch {
      // Newly created legacy nodes may not have completed their autosave yet.
      // Keep grouping available and retry on the next pointer/key selection
      // change; never change or intercept the legacy canvas in this path.
    }
  };
  const delayedRefresh = () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, 40);
  };
  const saveLegacyCanvas = () => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent || "").trim() === "保存画布");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  };
  const savedProjectForSelection = async (nodeIds) => {
    if (!nodeIds.length) return null;
    const before = await invoke("list_project_summaries");
    const beforeUpdatedAt = new Map(before.map((project) => [project.id, project.updatedAt]));
    if (!saveLegacyCanvas()) return undefined;
    // The legacy canvas does not expose a save-complete event.  Do not assume a
    // fixed delay is enough: wait for the project containing this exact current
    // selection to receive a new persisted timestamp before changing its canvas
    // from the compatibility plug-in.
    const deadline = Date.now() + LEGACY_SAVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, LEGACY_SAVE_POLL_MS));
      const projectId = await invoke("find_project_for_canvas_selection", { nodeIds });
      if (!projectId) continue;
      const projects = await invoke("list_project_summaries");
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project && beforeUpdatedAt.get(project.id) !== project.updatedAt) return projectId;
    }
    return null;
  };
  document.addEventListener("pointerup", delayedRefresh, true);
  document.addEventListener("keyup", delayedRefresh, true);
  const nodeSelector = ".react-flow__node, .xyflow__node";
  const selectionObserver = new MutationObserver((mutations) => {
    const selectionChanged = mutations.some((mutation) => {
      if (mutation.type === "attributes") return mutation.target instanceof Element && mutation.target.matches(nodeSelector);
      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node instanceof Element && (node.matches(nodeSelector) || node.querySelector?.(nodeSelector)));
    });
    if (selectionChanged) delayedRefresh();
  });
  selectionObserver.observe(document.getElementById("root"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  window.addEventListener("pagehide", () => selectionObserver.disconnect(), { once: true });

  toolbar.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-batch-action]")?.dataset.batchAction;
    if (!action) return;
    if (action === "cancel") {
      const pane = document.querySelector(".react-flow__pane, .xyflow__pane");
      pane?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      refresh();
      return;
    }
    if (action === "undo" || action === "redo") {
      try {
        const nodeIds = selectedFlowNodeIds();
        const projectId = await invoke("find_project_for_canvas_selection", { nodeIds });
        if (!projectId) throw new Error("请先打开并保存项目，再使用撤销或重做。");
        await invoke(action === "undo" ? "undo_last_canvas_batch_action" : "redo_last_canvas_batch_action", { projectId });
        toast(action === "undo" ? "已撤销上一次批量操作。" : "已重做批量操作。", "success");
        window.setTimeout(() => window.location.reload(), 450);
      } catch (error) { toast(`${action === "undo" ? "撤销" : "重做"}未执行：${String(error)}`, "error"); }
      return;
    }
    try {
      const nodeIds = selectedFlowNodeIds();
      const projectId = await savedProjectForSelection(nodeIds);
      if (projectId === undefined) {
        toast("请先使用旧画布顶部的“保存画布”保存项目，再进行批量操作。", "info");
        return;
      }
      if (!projectId) throw new Error("画布保存未完成或当前项目无法唯一确认；请稍后重试。");
      const needsImages = ["connect-video", "arrange-horizontal", "arrange-vertical", "arrange-connected"].includes(action);
      const preview = needsImages ? await invoke("preview_canvas_batch_action", { projectId, selectedNodeIds: nodeIds }) : null;
      let targetVideoNodeId = null;
      if (action === "connect-video") {
        if (preview.videoTargets.length > 1) {
          const choices = preview.videoTargets.map((target, index) => `${index + 1}. ${target.name}`).join("\n");
          const choice = Number(window.prompt(`请选择目标生视频节点：\n${choices}`, "1"));
          if (!Number.isInteger(choice) || !preview.videoTargets[choice - 1]) return;
          targetVideoNodeId = preview.videoTargets[choice - 1].id;
        }
        if (!window.confirm("将建立批量连线。若没有选中生视频节点，会在图片组右侧新建一个；重复连线会自动跳过。生成前仍需确认模型是否支持多参考图。继续吗？")) return;
      }
      const result = await invoke("apply_canvas_batch_action", {
        projectId,
        selectedNodeIds: nodeIds,
        action,
        targetVideoNodeId,
      });
      const messages = {
        "connect-video": "批量连线已保存；视频生成前会要求确认多参考图能力。",
        "arrange-horizontal": "横向排列已保存；可从画布历史撤销。",
        "arrange-vertical": "纵向排列已保存；可从画布历史撤销。",
        "arrange-connected": "已按连线顺序排列；无连线节点保持稳定顺序。",
        group: "已创建分组；原节点和连线保持不变。",
        ungroup: "已解组；成员节点和连线保持不变。",
      };
      toast(messages[action] || "批量操作已保存。", "success");
      // The recovered React application owns its canvas state.  A reload is the safe bridge
      // after a database-level batch action, avoiding a second, divergent in-memory graph.
      window.setTimeout(() => window.location.reload(), 650);
      return result;
    } catch (error) {
      toast(`批量操作未执行：${String(error)}`, "error");
    }
  });
}
