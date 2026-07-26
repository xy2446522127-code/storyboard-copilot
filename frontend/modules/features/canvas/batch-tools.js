import { invoke, selectedFlowNodeIds, toast } from "../../shared/tauri.js";

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

  const refresh = () => {
    selected = selectedFlowNodeIds();
    const images = [...document.querySelectorAll(".react-flow__node.selected img, .xyflow__node.selected img")];
    const selectedNodes = [...document.querySelectorAll(".react-flow__node.selected, .xyflow__node.selected")];
    const hasGroup = selectedNodes.some((node) => (node.innerText || "").includes("分组"));
    const visible = (selected.length >= 2 && images.length >= 2) || hasGroup;
    toolbar.classList.toggle("is-visible", visible);
    toolbar.querySelectorAll('[data-batch-action="connect-video"], [data-batch-action="arrange-horizontal"], [data-batch-action="arrange-vertical"], [data-batch-action="arrange-connected"]')
      .forEach((button) => { button.disabled = images.length < 2; });
    toolbar.querySelector('[data-batch-action="group"]').disabled = selected.length < 2;
    toolbar.querySelector('[data-batch-action="ungroup"]').disabled = !hasGroup;
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
    if (!saveLegacyCanvas()) {
      toast("请先使用旧画布顶部的“保存画布”保存项目，再进行批量操作。", "info");
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    const nodeIds = selectedFlowNodeIds();
    try {
      const projectId = await invoke("find_project_for_canvas_selection", { nodeIds });
      if (!projectId) throw new Error("未能识别当前项目；请先保存并重新打开画布。");
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
