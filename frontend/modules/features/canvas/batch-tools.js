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
    <button type="button" data-batch-action="cancel">取消选择</button>`;
  document.body.append(toolbar);
  let selected = [];
  let refreshTimer;

  const refresh = () => {
    selected = selectedFlowNodeIds();
    const images = [...document.querySelectorAll(".react-flow__node.selected img, .xyflow__node.selected img")];
    const visible = selected.length >= 2 && images.length >= 2;
    toolbar.classList.toggle("is-visible", visible);
  };
  const delayedRefresh = () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, 40);
  };
  document.addEventListener("pointerup", delayedRefresh, true);
  document.addEventListener("keyup", delayedRefresh, true);
  new MutationObserver(delayedRefresh).observe(document.getElementById("root"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

  toolbar.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-batch-action]")?.dataset.batchAction;
    if (!action) return;
    if (action === "cancel") {
      document.querySelectorAll(".react-flow__node.selected, .xyflow__node.selected").forEach((node) => node.classList.remove("selected"));
      refresh();
      return;
    }
    const nodeIds = selectedFlowNodeIds();
    try {
      const projectId = await invoke("find_project_for_canvas_selection", { nodeIds });
      if (!projectId) throw new Error("未能识别当前项目；请先保存并重新打开画布。");
      const preview = await invoke("preview_canvas_batch_action", { projectId, selectedNodeIds: nodeIds });
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
      toast(action === "connect-video" ? "批量连线已保存；视频生成前会要求确认多参考图能力。" : "批量排列已保存；可从画布历史撤销。", "success");
      // The recovered React application owns its canvas state.  A reload is the safe bridge
      // after a database-level batch action, avoiding a second, divergent in-memory graph.
      window.setTimeout(() => window.location.reload(), 650);
      return result;
    } catch (error) {
      toast(`批量操作未执行：${String(error)}`, "error");
    }
  });
}
