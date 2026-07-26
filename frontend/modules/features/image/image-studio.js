import { invoke, safeText, toast } from "../../shared/tauri.js";

const maxReferenceBytes = 10 * 1024 * 1024;

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function dimensionsForRatio(value) {
  return ({ "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024", "3:4": "1024x1365", "4:3": "1365x1024", "9:16": "1024x1792", "16:9": "1792x1024" })[value] || "1024x1024";
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
          <label>正向提示词<textarea data-field="prompt" required placeholder="描述你想生成或编辑的画面…"></textarea></label>
          <label data-negative>负面提示词<textarea data-field="negative" placeholder="不希望出现的内容（模型支持时生效）"></textarea></label>
          <div class="huahai-image__references"><div><span>参考图</span><small>最多 4 张；每张不超过 10 MB</small></div><div data-ref-list></div><input data-field="files" type="file" accept="image/*" multiple hidden /><button type="button" data-action="pick-refs">添加参考图</button></div>
          <div class="huahai-image__grid"><label>模型<select data-field="model"></select></label><label>比例<select data-field="ratio"><option>1:1</option><option>2:3</option><option>3:2</option><option>3:4</option><option>4:3</option><option>9:16</option><option>16:9</option></select></label><label data-size>分辨率<select data-field="resolution"><option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option><option value="custom">自定义</option></select></label><label data-count>数量<select data-field="count"><option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="4">4 张</option></select></label><label data-seed>随机种子<input data-field="seed" type="number" placeholder="留空随机" /></label></div>
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

  const field = (name) => form.querySelector(`[data-field="${name}"]`);
  const selectedModel = () => models.find((model) => `${model.providerId}::${model.id}` === modelsNode.value);
  const supports = (capability) => Boolean(selectedModel()?.capabilities?.[capability]);
  const renderRefs = () => {
    refsNode.replaceChildren(...refs.map((ref, index) => {
      const item = document.createElement("div");
      item.className = "huahai-image__ref";
      item.innerHTML = `<img src="${ref.preview}" alt="参考图 ${index + 1}" /><button type="button" data-remove-ref="${index}" title="移除">×</button>`;
      return item;
    }));
  };
  const renderCapabilities = () => {
    const hasModel = Boolean(selectedModel());
    panel.querySelector("[data-negative]").hidden = hasModel && !supports("negativePrompt");
    panel.querySelector("[data-size]").hidden = hasModel && !supports("customSize");
    panel.querySelector("[data-seed]").hidden = hasModel && !supports("seed");
    panel.querySelector("[data-model-hint]").textContent = !hasModel ? "请先在 API 设置配置图像模型" : (supports("multiReference") ? "支持多参考图" : "此模型仅支持第一张参考图");
  };
  const renderModels = async () => {
    models = await invoke("list_configured_models", { kind: "image" });
    modelsNode.replaceChildren(...models.map((model) => {
      const option = document.createElement("option");
      option.value = `${model.providerId}::${model.id}`;
      option.textContent = `${model.providerName} · ${model.label || model.id}`;
      return option;
    }));
    if (!models.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "请先配置图像模型"; modelsNode.append(option); }
    renderCapabilities();
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
        actions.append(asset); card.append(actions);
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
  const poll = async (job) => {
    try {
      const latest = await invoke("get_generate_image_job", { jobId: job.id });
      job.status = latest.status; job.result = latest.result; job.error = latest.error; renderJobs();
      if (latest.status === "pending") window.setTimeout(() => poll(job), 2200);
    } catch (error) { job.status = "failed"; job.error = String(error); renderJobs(); }
  };
  const submit = async () => {
    const model = selectedModel();
    const prompt = safeText(field("prompt").value);
    if (!model) { toast("请先在 API 设置配置图像模型。", "info"); return openApiSettings?.(); }
    if (!prompt) return toast("请输入正向提示词。", "error");
    if (refs.length > 1 && !supports("multiReference")) {
      if (!window.confirm("该模型不支持多参考图。继续将只发送第一张参考图吗？")) return;
    }
    const count = Number(field("count").value || 1);
    if (!window.confirm(`将使用 ${model.label || model.id} 生成 ${count} 张图片。该请求可能产生费用，是否继续？`)) return;
    const job = { id: "", status: "pending", prompt, modelLabel: model.label || model.id, result: "", error: "" };
    jobs.unshift(job); renderJobs();
    try {
      const references = (supports("multiReference") ? refs : refs.slice(0, 1)).map((ref) => ({ image_url: ref.dataUrl }));
      const payload = { provider_id: model.providerId, model: model.id, prompt, negative_prompt: supports("negativePrompt") ? safeText(field("negative").value) : undefined, size: field("resolution").value === "custom" ? dimensionsForRatio(field("ratio").value) : dimensionsForRatio(field("ratio").value), quality: field("resolution").value, n: count, seed: supports("seed") && field("seed").value ? Number(field("seed").value) : undefined, reference_images: references };
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
    if (remove !== undefined) { URL.revokeObjectURL(refs[Number(remove)]?.preview); refs.splice(Number(remove), 1); renderRefs(); }
    if (action === "close") panel.classList.remove("is-open");
    if (action === "pick-refs") filesNode.click();
    if (action === "clear") { form.reset(); refs.forEach((ref) => URL.revokeObjectURL(ref.preview)); refs = []; renderRefs(); }
    if (action === "clear-results") { jobs = []; renderJobs(); }
  });
  filesNode.addEventListener("change", () => addFiles(filesNode.files));
  modelsNode.addEventListener("change", renderCapabilities);
  form.addEventListener("dragover", (event) => { if ([...event.dataTransfer?.items || []].some((item) => item.kind === "file")) event.preventDefault(); });
  form.addEventListener("drop", (event) => { if (event.dataTransfer?.files?.length) { event.preventDefault(); addFiles(event.dataTransfer.files); } });
  form.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
  return { open: async () => { panel.classList.add("is-open"); try { await renderModels(); } catch (error) { toast(`无法读取图像模型：${String(error)}`, "error"); } } };
}
