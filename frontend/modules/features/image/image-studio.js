import { invoke, safeText, toast } from "../../shared/tauri.js";

const maxReferenceBytes = 10 * 1024 * 1024;
const presetsStorageKey = "huahai-image-presets-v1";

function loadPresets() {
  try {
    const stored = JSON.parse(localStorage.getItem(presetsStorageKey) || "[]");
    return Array.isArray(stored) ? stored.filter((preset) => preset && typeof preset.name === "string").slice(0, 30) : [];
  } catch { return []; }
}

function savePresets(presets) {
  localStorage.setItem(presetsStorageKey, JSON.stringify(presets.slice(0, 30)));
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function dimensionsForRatio(value, resolution = "1k") {
  const scale = ({ "1k": 1, "2k": 1.5, "4k": 2 })[resolution] || 1;
  const base = ({ "1:1": [1024, 1024], "2:3": [1024, 1536], "3:2": [1536, 1024], "3:4": [1024, 1365], "4:3": [1365, 1024], "9:16": [1024, 1792], "16:9": [1792, 1024] })[value] || [1024, 1024];
  return `${Math.round(base[0] * scale / 64) * 64}x${Math.round(base[1] * scale / 64) * 64}`;
}

export function installImageStudio({ openApiSettings } = {}) {
  const panel = document.createElement("section");
  panel.id = "huahai-image-studio";
  panel.innerHTML = `
    <div class="huahai-image__backdrop" data-action="close"></div>
    <div class="huahai-image__dialog" role="dialog" aria-modal="true" aria-label="在线生图">
      <header><div><strong>在线生图</strong><span data-model-hint>从 API 设置选择模型</span></div><button type="button" data-action="close">×</button></header>
      <div class="huahai-image__body">
        <form data-form>
          <div class="huahai-image__presets"><select data-field="preset" aria-label="提示词预设"></select><button type="button" data-action="apply-preset">应用</button><button type="button" data-action="save-preset">存为预设</button><button type="button" data-action="delete-preset">删除</button></div>
          <label>正向提示词<textarea data-field="prompt" required placeholder="描述你想生成或编辑的画面…"></textarea></label>
          <label data-negative>负面提示词<textarea data-field="negative" placeholder="不希望出现的内容（模型支持时生效）"></textarea></label>
          <div class="huahai-image__references"><div><span>参考图</span><small>最多 4 张；每张不超过 10 MB</small></div><div data-ref-list></div><input data-field="files" type="file" accept="image/*" multiple hidden /><button type="button" data-action="pick-refs">添加参考图</button></div>
          <div class="huahai-image__grid"><label>模型<select data-field="model"></select></label><label>比例<select data-field="ratio"><option>1:1</option><option>2:3</option><option>3:2</option><option>3:4</option><option>4:3</option><option>9:16</option><option>16:9</option></select></label><label data-size>分辨率<select data-field="resolution"><option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option><option value="custom">自定义</option></select></label><label data-custom-width hidden>宽度（256–4096，64 的倍数）<input data-field="custom-width" type="number" min="256" max="4096" step="64" value="1024" /></label><label data-custom-height hidden>高度（256–4096，64 的倍数）<input data-field="custom-height" type="number" min="256" max="4096" step="64" value="1024" /></label><label data-count>数量<select data-field="count"><option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="4">4 张</option></select></label><label data-seed>随机种子<input data-field="seed" type="number" placeholder="留空随机" /></label></div>
          <div class="huahai-image__actions"><button type="button" data-action="clear">清空</button><button class="primary" type="submit">生成图片</button></div>
        </form>
        <aside><div class="huahai-image__jobs-head"><strong>任务与结果</strong><button type="button" data-action="clear-results">清空显示</button></div><div data-jobs><p>创建任务后，状态和结果会显示在这里。</p></div></aside>
      </div>
    </div>`;
  document.body.append(panel);
  const form = panel.querySelector("[data-form]");
  const modelsNode = panel.querySelector('[data-field="model"]');
  const refsNode = panel.querySelector("[data-ref-list]");
  const filesNode = panel.querySelector('[data-field="files"]');
  const jobsNode = panel.querySelector("[data-jobs]");
  let models = [];
  let refs = [];
  let jobs = [];
  let presets = loadPresets();

  const field = (name) => form.querySelector(`[data-field="${name}"]`);
  const selectedModel = () => models.find((model) => `${model.providerId}::${model.id}` === modelsNode.value);
  const supports = (capability) => Boolean(selectedModel()?.capabilities?.[capability]);
  const renderRefs = () => {
    refsNode.replaceChildren(...refs.map((ref, index) => {
      const item = document.createElement("div");
      item.className = "huahai-image__ref";
      item.innerHTML = `<img src="${ref.preview}" alt="参考图 ${index + 1}" /><div class="huahai-image__ref-actions"><button type="button" data-move-ref="${index}" data-direction="previous" title="前移" ${index === 0 ? "disabled" : ""}>←</button><button type="button" data-move-ref="${index}" data-direction="next" title="后移" ${index === refs.length - 1 ? "disabled" : ""}>→</button><button type="button" data-remove-ref="${index}" title="移除">×</button></div>`;
      return item;
    }));
  };
  const renderPresets = () => {
    const select = field("preset");
    select.replaceChildren(new Option("选择提示词预设…", ""), ...presets.map((preset) => new Option(preset.name, preset.id)));
  };
  const applyPreset = () => {
    const preset = presets.find((item) => item.id === field("preset").value);
    if (!preset) return toast("请选择要应用的预设。", "info");
    field("prompt").value = preset.prompt || "";
    field("negative").value = preset.negative || "";
    for (const name of ["ratio", "resolution", "count", "seed"]) {
      if (preset[name] !== undefined && field(name)) field(name).value = preset[name];
    }
    toast(`已应用预设“${preset.name}”。`, "success");
  };
  const savePreset = () => {
    const prompt = safeText(field("prompt").value);
    if (!prompt) return toast("先填写正向提示词，再保存预设。", "info");
    const name = safeText(window.prompt("预设名称（不保存参考图和密钥）：", ""));
    if (!name) return;
    const id = crypto.randomUUID?.() || `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const preset = { id, name: name.slice(0, 60), prompt, negative: safeText(field("negative").value), ratio: field("ratio").value, resolution: field("resolution").value, count: field("count").value, seed: field("seed").value };
    presets = [preset, ...presets.filter((item) => item.name !== preset.name)].slice(0, 30);
    savePresets(presets); renderPresets(); field("preset").value = preset.id;
    toast("提示词预设已保存。", "success");
  };
  const deletePreset = () => {
    const id = field("preset").value;
    const preset = presets.find((item) => item.id === id);
    if (!preset) return toast("请选择要删除的预设。", "info");
    if (!window.confirm(`删除预设“${preset.name}”？这不会影响已经生成的结果。`)) return;
    presets = presets.filter((item) => item.id !== id); savePresets(presets); renderPresets();
  };
  const renderCapabilities = () => {
    const hasModel = Boolean(selectedModel());
    panel.querySelector("[data-negative]").hidden = hasModel && !supports("negativePrompt");
    panel.querySelector("[data-size]").hidden = hasModel && !supports("customSize");
    panel.querySelector("[data-seed]").hidden = hasModel && !supports("seed");
    if (hasModel && !supports("customSize") && field("resolution").value === "custom") field("resolution").value = "1k";
    const custom = field("resolution").value === "custom" && (!hasModel || supports("customSize"));
    panel.querySelector("[data-custom-width]").hidden = !custom;
    panel.querySelector("[data-custom-height]").hidden = !custom;
    panel.querySelector("[data-model-hint]").textContent = !hasModel ? "请先在 API 设置配置图像模型" : (supports("multiReference") ? "支持多参考图" : "此模型仅支持第一张参考图");
  };
  const renderModels = async () => {
    renderPresets();
    models = await invoke("list_configured_models", { kind: "image" });
    modelsNode.replaceChildren(...models.map((model) => {
      const option = document.createElement("option");
      option.value = `${model.providerId}::${model.id}`;
      option.textContent = `${model.providerName} · ${model.label || model.id}`;
      return option;
    }));
    if (!models.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "请先配置图像模型"; modelsNode.append(option); }
    renderCapabilities();
    await loadJobs();
  };
  const renderJobs = () => {
    jobsNode.replaceChildren(...jobs.map((job) => {
      const card = document.createElement("article");
      card.className = `huahai-image__job is-${job.status}`;
      card.innerHTML = `<div><strong>${job.status === "succeeded" ? "已完成" : job.status === "failed" ? "失败" : "生成中"}</strong><span>${job.modelLabel}</span></div><p>${job.error || job.prompt}</p>`;
      if (job.result) {
        const image = document.createElement("img"); image.src = job.result; image.alt = "生成结果"; image.addEventListener("click", () => window.open(job.result, "_blank")); card.append(image);
        const actions = document.createElement("div"); actions.className = "huahai-image__job-actions";
        const asset = document.createElement("button"); asset.type = "button"; asset.textContent = "加入素材库"; asset.addEventListener("click", () => saveToAssets(job));
        const canvas = document.createElement("button"); canvas.type = "button"; canvas.textContent = "加入项目画布"; canvas.addEventListener("click", () => addToCanvas(job));
        actions.append(asset, canvas); card.append(actions);
      }
      return card;
    }));
  };
  const saveToAssets = async (job) => {
    try {
      const path = await invoke("persist_image_source", { source: job.result });
      await invoke("add_asset", { name: `生图-${new Date().toLocaleString("zh-CN")}`, category: "在线生图", tags: "", filePath: path, sourceType: "online-image", sourceNodeId: null });
      toast("已保存到素材库。", "success");
    } catch (error) { toast(`保存素材失败：${String(error)}`, "error"); }
  };
  const addToCanvas = async (job) => {
    try {
      const projects = await invoke("list_project_summaries");
      if (!projects.length) throw new Error("请先在旧版项目管理中创建并保存项目。");
      const choices = projects.slice(0, 12).map((project, index) => `${index + 1}. ${project.name}`).join("\n");
      const choice = Number(window.prompt(`选择要加入的项目画布：\n${choices}`, "1"));
      const project = projects[choice - 1];
      if (!Number.isInteger(choice) || !project) return;
      await invoke("append_image_source_to_canvas", {
        projectId: project.id,
        source: job.result,
        fileName: `在线生图-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
      });
      toast(`已加入“${project.name}”画布；可在画布中撤销。`, "success");
    } catch (error) { toast(`加入画布失败：${String(error)}`, "error"); }
  };
  const poll = async (job) => {
    try {
      const latest = await invoke("get_generate_image_job", { jobId: job.id });
      job.status = latest.status; job.result = latest.result; job.error = latest.error; renderJobs();
      if (latest.status === "pending") window.setTimeout(() => poll(job), 2200);
    } catch (error) { job.status = "failed"; job.error = String(error); renderJobs(); }
  };
  const loadJobs = async () => {
    const stored = await invoke("list_generate_image_jobs");
    jobs = stored.map((job) => ({ id: job.jobId, status: job.status, prompt: "已保存的生成任务", modelLabel: job.providerId, result: job.result || "", error: job.error || "" }));
    renderJobs();
    jobs.filter((job) => job.status === "pending").forEach((job) => poll(job));
  };
  const submit = async () => {
    const model = selectedModel();
    const prompt = safeText(field("prompt").value);
    if (!model) { toast("请先在 API 设置配置图像模型。", "info"); return openApiSettings?.(); }
    if (!prompt) return toast("请输入正向提示词。", "error");
    if (refs.length > 1 && !supports("multiReference")) {
      if (!window.confirm("该模型不支持多参考图。继续将只发送第一张参考图吗？")) return;
    }
    const resolution = field("resolution").value;
    let size = dimensionsForRatio(field("ratio").value, resolution);
    if (resolution === "custom") {
      const width = Number(field("custom-width").value);
      const height = Number(field("custom-height").value);
      if (![width, height].every((value) => Number.isInteger(value) && value >= 256 && value <= 4096 && value % 64 === 0)) {
        return toast("自定义宽高须在 256–4096 之间，且为 64 的倍数。", "error");
      }
      size = `${width}x${height}`;
    }
    const count = Number(field("count").value || 1);
    if (!window.confirm(`将使用 ${model.label || model.id} 生成 ${count} 张图片。该请求可能产生费用，是否继续？`)) return;
    const job = { id: "", status: "pending", prompt, modelLabel: model.label || model.id, result: "", error: "" };
    jobs.unshift(job); renderJobs();
    try {
      const references = (supports("multiReference") ? refs : refs.slice(0, 1)).map((ref) => ({ image_url: ref.dataUrl }));
      const payload = { provider_id: model.providerId, model: model.id, prompt, negative_prompt: supports("negativePrompt") ? safeText(field("negative").value) : undefined, size, quality: resolution === "custom" ? undefined : resolution, n: count, seed: supports("seed") && field("seed").value ? Number(field("seed").value) : undefined, reference_images: references };
      job.id = await invoke("submit_generate_image_job", { payload: JSON.stringify(payload) });
      await poll(job);
    } catch (error) { job.status = "failed"; job.error = String(error); renderJobs(); }
  };
  const addFiles = async (files) => {
    for (const file of [...files]) {
      if (refs.length >= 4) break;
      if (!file.type.startsWith("image/")) { toast(`${file.name} 不是图片。`, "error"); continue; }
      if (file.size > maxReferenceBytes) { toast(`${file.name} 超过 10 MB。`, "error"); continue; }
      refs.push({ preview: URL.createObjectURL(file), dataUrl: await readFile(file), name: file.name });
    }
    renderRefs();
  };
  panel.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const remove = event.target.closest("[data-remove-ref]")?.dataset.removeRef;
    const move = event.target.closest("[data-move-ref]");
    if (remove !== undefined) { URL.revokeObjectURL(refs[Number(remove)]?.preview); refs.splice(Number(remove), 1); renderRefs(); }
    if (move) {
      const index = Number(move.dataset.moveRef);
      const target = move.dataset.direction === "previous" ? index - 1 : index + 1;
      if (Number.isInteger(index) && refs[target]) { [refs[index], refs[target]] = [refs[target], refs[index]]; renderRefs(); }
    }
    if (action === "close") panel.classList.remove("is-open");
    if (action === "pick-refs") filesNode.click();
    if (action === "clear") { form.reset(); refs.forEach((ref) => URL.revokeObjectURL(ref.preview)); refs = []; renderRefs(); }
    if (action === "clear-results") { jobs = []; renderJobs(); }
    if (action === "apply-preset") applyPreset();
    if (action === "save-preset") savePreset();
    if (action === "delete-preset") deletePreset();
  });
  filesNode.addEventListener("change", () => addFiles(filesNode.files));
  modelsNode.addEventListener("change", renderCapabilities);
  field("resolution").addEventListener("change", renderCapabilities);
  form.addEventListener("dragover", (event) => { if ([...event.dataTransfer?.items || []].some((item) => item.kind === "file")) event.preventDefault(); });
  form.addEventListener("drop", (event) => { if (event.dataTransfer?.files?.length) { event.preventDefault(); addFiles(event.dataTransfer.files); } });
  form.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
  return { open: async () => { panel.classList.add("is-open"); try { await renderModels(); } catch (error) { toast(`无法读取图像模型：${String(error)}`, "error"); } } };
}
