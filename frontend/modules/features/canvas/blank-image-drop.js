import { invoke, toast } from "../../shared/tauri.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff", "image/avif"]);
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function canvasPane(target) {
  const pane = target.closest(".react-flow__pane, .xyflow__pane, .react-flow, .xyflow");
  if (!pane || target.closest(".react-flow__node, .xyflow__node")) return null;
  return pane;
}

function droppedImages(dataTransfer) {
  const seen = new Set();
  return [...(dataTransfer?.files || [])].filter((file) => {
    if (!IMAGE_TYPES.has(file.type)) return false;
    const identity = `${file.name}::${file.size}::${file.lastModified}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function canvasPosition(pane, event) {
  const rect = pane.getBoundingClientRect();
  const viewport = pane.querySelector(".react-flow__viewport, .xyflow__viewport");
  const transform = viewport ? getComputedStyle(viewport).transform : "none";
  try {
    const matrix = transform && transform !== "none" ? new DOMMatrixReadOnly(transform) : null;
    if (matrix && matrix.a) {
      return { x: (event.clientX - rect.left - matrix.e) / matrix.a, y: (event.clientY - rect.top - matrix.f) / matrix.d };
    }
  } catch { /* A malformed third-party transform must not block legacy canvas drops. */ }
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function clickLegacySave() {
  const save = [...document.querySelectorAll("button")].find((button) => (button.textContent || "").trim() === "保存画布");
  if (!save || save.disabled) return false;
  save.click();
  return true;
}

export function installBlankCanvasImageDrop() {
  let importing = false;
  const onDragOver = (event) => {
    if (importing || !canvasPane(event.target) || !droppedImages(event.dataTransfer).length) return;
    // We only claim an image drop over blank canvas.  Existing upload nodes keep
    // their original drag/drop handlers and retain full ownership of the event.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = async (event) => {
    const pane = canvasPane(event.target);
    const allFiles = [...(event.dataTransfer?.files || [])];
    const files = droppedImages(event.dataTransfer);
    if (importing || !pane || !allFiles.length) return;
    event.preventDefault();
    if (!files.length) return toast("空白画布只支持拖入图片文件。", "error");
    if (files.length !== allFiles.length) toast("已跳过非图片或重复文件。", "info");
    if (files.length > 20) return toast("一次最多拖入 20 张图片。", "error");
    const tooLarge = files.find((file) => file.size > MAX_FILE_BYTES);
    if (tooLarge) return toast(`${tooLarge.name} 超过 30 MB，未导入。`, "error");
    if (!clickLegacySave()) return toast("请先在旧画布中保存项目，再拖入图片。", "info");
    importing = true;
    try {
      // Saving through the legacy button is the compatibility boundary: the old
      // React store remains the single source of truth until it has persisted.
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      const projects = await invoke("list_project_summaries");
      let project = projects[0];
      if (projects.length > 1) {
        const choices = projects.slice(0, 12).map((item, index) => `${index + 1}. ${item.name}`).join("\n");
        const choice = Number(window.prompt(`选择要导入图片的项目：\n${choices}`, "1"));
        project = projects[choice - 1];
        if (!Number.isInteger(choice) || !project) return;
      }
      if (!project?.id) throw new Error("没有找到已保存的项目；请打开项目后再试");
      const accepted = window.confirm(`将 ${files.length} 张图片导入“${project.name}”并重新载入画布吗？\n\n图片会保存到 F 盘媒体库；此操作可用画布撤销。`);
      if (!accepted) return;
      const images = [];
      for (const file of files) images.push({ source: await readAsDataUrl(file), fileName: file.name });
      const point = canvasPosition(pane, event);
      await invoke("append_blank_canvas_images", { projectId: project.id, images, ...point });
      toast(`已导入 ${images.length} 张图片，正在重新载入画布。`, "success");
      window.setTimeout(() => window.location.reload(), 550);
    } catch (error) {
      toast(`图片未导入：${String(error)}`, "error");
    } finally {
      importing = false;
    }
  };
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  return () => {
    document.removeEventListener("dragover", onDragOver, true);
    document.removeEventListener("drop", onDrop, true);
  };
}
