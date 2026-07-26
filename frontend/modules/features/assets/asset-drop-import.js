import { invoke, toast } from "../../shared/tauri.js";

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

function categoryFor(file) {
  if (file.type.startsWith("image/")) return "images";
  if (file.type.startsWith("video/")) return "videos";
  if (file.type.startsWith("audio/")) return "audio";
  return "documents";
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function inLegacyAssetLibrary(target) {
  const dialog = target.closest('[role="dialog"], [aria-modal="true"]');
  if (dialog && /素材库/.test(dialog.textContent || "")) return true;
  const upload = [...document.querySelectorAll("button")].find((button) => (button.textContent || "").trim() === "上传");
  return Boolean(upload && upload.closest("div")?.contains(target));
}

export function installAssetDropImport() {
  let importing = false;
  const onDragOver = (event) => {
    if (!importing && event.dataTransfer?.files?.length && inLegacyAssetLibrary(event.target)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = async (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (importing || !files.length || !inLegacyAssetLibrary(event.target)) return;
    event.preventDefault();
    if (files.some((file) => file.size > MAX_IMPORT_BYTES)) return toast("素材库拖入单个文件暂限 25 MB；大文件请使用“上传”按钮。", "info");
    importing = true;
    try {
      for (const file of files) {
        await invoke("import_asset_file", {
          input: { source: await readFile(file), fileName: file.name, category: categoryFor(file), tags: "" },
        });
      }
      toast(`已保存 ${files.length} 个文件到 F 盘素材库，正在刷新列表。`, "success");
      window.setTimeout(() => window.location.reload(), 450);
    } catch (error) {
      toast(`素材库导入失败：${String(error)}`, "error");
    } finally { importing = false; }
  };
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  return () => { document.removeEventListener("dragover", onDragOver, true); document.removeEventListener("drop", onDrop, true); };
}
