import { invoke, toast } from "../../shared/tauri.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff", "image/avif"]);
const MAX_FILE_BYTES = 30 * 1024 * 1024;
// Data URLs are roughly one third larger than their files. Keep a batch below a
// predictable transfer budget so the optional compatibility plug-in cannot
// freeze the recovered canvas while serializing a huge message to Tauri.
const MAX_BATCH_BYTES = 60 * 1024 * 1024;
const LEGACY_SAVE_TIMEOUT_MS = 4_000;
const LEGACY_SAVE_POLL_MS = 120;

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

function fileCategory(file) {
  if (file.type.startsWith("video/")) return "videos";
  if (file.type.startsWith("audio/")) return "audio";
  if (/\.(txt|md|csv|json|pdf|docx)$/i.test(file.name)) return "documents";
  return "";
}

function droppedFileReferences(files) {
  const seen = new Set();
  return files.filter((file) => {
    const category = fileCategory(file);
    const identity = `${file.name}::${file.size}::${file.lastModified}`;
    if (!category || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function savedProjectAfterLegacySave() {
  // The recovered application does not expose an active-project API.  Its save
  // operation does, however, update exactly one project's timestamp.  Remember
  // the timestamps before saving so a blank-canvas drop can target that project
  // deterministically instead of asking the user to guess from a project list.
  const before = await invoke("list_project_summaries");
  const beforeUpdatedAt = new Map(before.map((project) => [project.id, project.updatedAt]));
  if (!clickLegacySave()) return null;
  // The old React store does not give plugins a save-complete event.  Poll the
  // F-drive project store for a bounded time instead of assuming 700 ms is
  // enough.  Only a unique changed project is safe to import into: choosing
  // the most recently listed project would put a user's images in the wrong
  // storyboard when a slow save or a concurrent update occurs.
  const deadline = Date.now() + LEGACY_SAVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, LEGACY_SAVE_POLL_MS));
    const after = await invoke("list_project_summaries");
    const changed = after.filter((project) => beforeUpdatedAt.get(project.id) !== project.updatedAt);
    if (changed.length === 1) return changed[0];
    if (changed.length > 1) return null;
  }
  return null;
}

export function installBlankCanvasImageDrop() {
  let importing = false;
  const onDragOver = (event) => {
    if (importing || !canvasPane(event.target) || ![...event.dataTransfer.files || []].length) return;
    // We only claim an image drop over blank canvas.  Existing upload nodes keep
    // their original drag/drop handlers and retain full ownership of the event.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = async (event) => {
    const pane = canvasPane(event.target);
    const allFiles = [...(event.dataTransfer?.files || [])];
    const files = droppedImages(event.dataTransfer);
    const references = droppedFileReferences(allFiles);
    if (importing || !pane || !allFiles.length) return;
    event.preventDefault();
    if (!files.length && !references.length) return toast("空白画布支持图片、视频、音频和常见文档。", "error");
    if (files.length + references.length !== allFiles.length) toast("已跳过不支持或重复的文件。", "info");
    if (files.length + references.length > 20) return toast("一次最多拖入 20 个文件。", "error");
    const tooLarge = [...files, ...references].find((file) => file.size > MAX_FILE_BYTES);
    if (tooLarge) return toast(`${tooLarge.name} 超过 30 MB，未导入。`, "error");
    const totalBytes = [...files, ...references].reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_BATCH_BYTES) return toast("本次图片总量超过 60 MB。请分批拖入，避免画布卡顿。", "error");
    importing = true;
    try {
      // Saving through the legacy button is the compatibility boundary: the old
      // React store remains the single source of truth until it has persisted.
      const project = await savedProjectAfterLegacySave();
      if (!project) return toast("请先在旧画布中保存项目，再拖入图片。", "info");
      if (!project?.id) throw new Error("没有找到已保存的项目；请打开项目后再试");
      const accepted = window.confirm(`将 ${files.length} 张图片和 ${references.length} 个文件导入“${project.name}”并重新载入画布吗？\n\n文件会保存到 F 盘媒体库；此操作可用画布撤销。`);
      if (!accepted) return;
      const images = [];
      for (const file of files) images.push({ source: await readAsDataUrl(file), fileName: file.name });
      const point = canvasPosition(pane, event);
      if (images.length) await invoke("append_blank_canvas_images", { projectId: project.id, images, ...point });
      if (references.length) {
        const imported = [];
        for (const file of references) imported.push({ source: await readAsDataUrl(file), fileName: file.name, category: fileCategory(file) });
        await invoke("append_blank_canvas_file_references", { projectId: project.id, files: imported, ...point });
      }
      toast(`已导入 ${images.length} 张图片和 ${references.length} 个文件，正在重新载入画布。`, "success");
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
