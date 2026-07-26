import { invoke, safeText, toast } from "../../shared/tauri.js";

const tabs = [
  ["image", "图像模型"],
  ["chat", "对话模型"],
  ["video", "视频模型"],
  ["audio", "音频模型"],
];

const capabilityLabels = {
  image: [["negativePrompt", "负面提示词"], ["multiReference", "多参考图"], ["customSize", "自定义尺寸"], ["seed", "随机种子"], ["imageEdit", "图片编辑"]],
  chat: [["stream", "流式回复"], ["vision", "图片理解"]],
  video: [["multiReference", "多参考图"], ["firstLastFrame", "首尾帧"], ["customSize", "自定义尺寸"]],
  audio: [],
};

function splitModels(value) {
  return [...new Set(String(value || "").split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))];
}

function legacyProviderRecords() {
  try {
    const raw = JSON.parse(localStorage.getItem("storyboard-copilot-settings") || "{}");
    const state = raw.state && typeof raw.state === "object" ? raw.state : raw;
    const records = [...(Array.isArray(state.customProviders) ? state.customProviders : []), ...(Array.isArray(state.providers) ? state.providers : [])];
    const unique = new Map();
    records.forEach((provider) => {
      const id = safeText(provider?.id).replace(/[^a-zA-Z0-9_-]/g, "-");
      const baseUrl = safeText(provider?.baseUrl || provider?.base_url).replace(/\/$/, "");
      if (!id || !baseUrl || !/^https:\/\//i.test(baseUrl)) return;
      const existing = unique.get(id) || {};
      unique.set(id, {
        id,
        name: safeText(provider?.name, id),
        baseUrl,
        key: safeText(provider?.apiKey || provider?.api_key || existing.key),
        models: [...new Set([...(existing.models || []), ...(Array.isArray(provider?.models) ? provider.models : []), provider?.modelName]
          .map((model) => typeof model === "string" ? model : (model?.id || model?.name || ""))
          .filter((model) => typeof model === "string" && model.trim()))],
      });
    });
    return [...unique.values()];
  } catch {
    return [];
  }
}

function inferredModelKind(model) {
  const name = String(model || "").toLowerCase();
  if (/(video|seedance|sora|wan|kling|veo)/.test(name)) return "video";
  if (/(audio|speech|tts|voice)/.test(name)) return "audio";
  if (/(image|dall|flux|sdxl|midjourney|ideogram)/.test(name)) return "image";
  return "chat";
}

// Keep a compatible provider record for recovered node pickers. The backend F-drive
// settings remain authoritative; this mirror only preserves legacy node usability.
function syncLegacyProvider({ id, name, baseUrl, key, models, kind }) {
  try {
    const storageKey = "storyboard-copilot-settings";
    const raw = JSON.parse(localStorage.getItem(storageKey) || "{}");
    const state = raw.state && typeof raw.state === "object" ? raw.state : raw;
    const providers = Array.isArray(state.providers) ? state.providers : [];
    const customProviders = Array.isArray(state.customProviders) ? state.customProviders : [];
    const previous = customProviders.find((provider) => provider?.id === id) || {};
    // One service can provide image, chat, video and audio models. The recovered
    // provider picker only understands one flat list, so never replace earlier
    // categories when saving the current API-settings tab.
    const allModels = [...new Set([...(previous.models || []), ...models].filter(Boolean))];
    const compatible = {
      ...previous, id, name, baseUrl,
      apiKey: key || previous.apiKey || "",
      modelName: models[0] || previous.modelName || allModels[0] || "",
      models: allModels,
      capabilities: [...new Set([...(previous.capabilities || []), kind])],
      enabled: true,
    };
    state.customProviders = [...customProviders.filter((provider) => provider?.id !== id), compatible];
    state.providers = providers.map((provider) => provider?.id === id
      ? { ...provider, name, baseUrl, apiKey: key || provider.apiKey || "", modelName: compatible.modelName, enabled: true }
      : provider);
    if (raw.state) raw.state = state;
    else Object.assign(raw, state);
    localStorage.setItem(storageKey, JSON.stringify(raw));
    return true;
  } catch (error) {
    console.warn("[HuahaiCanvas] legacy provider compatibility sync failed", error);
    return false;
  }
}

export function installApiSettings() {
  const panel = document.createElement("section");
  panel.id = "huahai-api-settings";
  panel.setAttribute("aria-label", "API 设置");
  panel.innerHTML = `
    <div class="huahai-api__backdrop" data-action="close"></div>
    <div class="huahai-api__dialog" role="dialog" aria-modal="true">
      <header><div><strong>API 设置</strong><p>密钥仅保存在本机 F 盘，界面不会显示已保存的完整密钥。</p></div><button type="button" data-action="close" title="关闭">×</button></header>
      <nav class="huahai-api__tabs">${tabs.map(([id, label]) => `<button type="button" data-kind="${id}">${label}</button>`).join("")}</nav>
      <div class="huahai-api__layout">
        <aside><div class="huahai-api__provider-title">已配置服务</div><div data-providers></div></aside>
        <form data-form>
          <label>服务标识<input data-field="id" required placeholder="例如 my-api" autocomplete="off" /></label>
          <label>显示名称<input data-field="name" required placeholder="例如 我的 API 中转" /></label>
          <label>服务地址<input data-field="baseUrl" type="url" required placeholder="https://example.com/v1" /></label>
          <label>API Key<input data-field="key" type="password" placeholder="留空则保留已保存的密钥" autocomplete="new-password" /></label>
          <div class="huahai-api__model-label"><span>模型列表</span><button type="button" data-action="fetch-models">拉取模型</button></div>
          <textarea data-field="models" required rows="4" placeholder="一个或多个模型，使用逗号或换行分隔"></textarea>
          <fieldset data-capabilities><legend>模型能力</legend></fieldset>
          <div class="huahai-api__actions"><button type="button" data-action="new">新建</button><button type="button" data-action="test-connection">测试连接</button><button type="submit" class="primary">保存此分类</button></div>
        </form>
      </div>
    </div>`;
  document.body.append(panel);

  const importLegacy = document.createElement("button");
  importLegacy.type = "button";
  importLegacy.className = "huahai-api__import";
  importLegacy.dataset.action = "import-legacy";
  importLegacy.textContent = "导入旧版本机配置";
  panel.querySelector("header > div")?.append(importLegacy);
  const form = panel.querySelector("[data-form]");
  const providersNode = panel.querySelector("[data-providers]");
  const capabilityNode = panel.querySelector("[data-capabilities]");
  let kind = "image";
  let providers = [];
  let selectedProviderId = "";

  const field = (name) => form.querySelector(`[data-field="${name}"]`);
  const capabilities = () => Object.fromEntries([...capabilityNode.querySelectorAll("input")].map((input) => [input.value, input.checked]));
  const ensureProviderId = () => {
    const existing = safeText(field("id").value).replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
    if (existing) {
      field("id").value = existing;
      return existing;
    }
    const generated = `api-${Date.now().toString(36)}`;
    field("id").value = generated;
    return generated;
  };
  const modelFetchError = (error) => {
    const detail = String(error);
    if (/\b401\b/.test(detail)) return "服务端拒绝了密钥（401）。请只粘贴 API Key 本身，不要包含 Bearer、引号或额外字符；若仍失败，请在服务商后台确认该密钥有效。";
    if (/\b403\b/.test(detail)) return "服务端拒绝了模型列表权限（403）。请确认该密钥具备模型列表访问权限。";
    if (/timeout|timed out|超时/i.test(detail)) return "拉取模型超时。请检查服务地址和网络后重试。";
    return `获取模型失败：${detail}`;
  };
  const renderCapabilities = () => {
    capabilityNode.replaceChildren(...(capabilityLabels[kind] || []).map(([id, label]) => {
      const row = document.createElement("label");
      row.innerHTML = `<input type="checkbox" value="${id}" /> ${label}`;
      return row;
    }));
  };
  const selectProvider = (id) => {
    selectedProviderId = id;
    const provider = providers.find((item) => item.id === id);
    if (!provider) return;
    field("id").value = provider.id || "";
    field("name").value = provider.name || provider.id || "";
    field("baseUrl").value = provider.base_url || "";
    field("key").value = "";
    field("key").placeholder = provider.key_configured ? "已保存；留空则不修改" : "请输入 API Key";
    const catalog = (provider.model_catalog || []).find((entry) => entry.kind === kind);
    const models = catalog?.models || provider.models || [];
    field("models").value = models.map((model) => typeof model === "string" ? model : model.id).filter(Boolean).join("\n");
    const saved = new Set(Object.entries(catalog?.models?.[0]?.capabilities || {}).filter(([, enabled]) => enabled).map(([name]) => name));
    capabilityNode.querySelectorAll("input").forEach((input) => { input.checked = saved.has(input.value); });
    providersNode.querySelectorAll("button").forEach((button) => button.classList.toggle("is-active", button.dataset.provider === id));
  };
  const renderProviders = () => {
    providersNode.replaceChildren(...providers.map((provider) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.provider = provider.id;
      button.textContent = `${provider.name || provider.id}${provider.key_configured ? " · 已配置" : " · 缺少密钥"}`;
      button.addEventListener("click", () => selectProvider(provider.id));
      return button;
    }));
    if (providers.length) selectProvider(selectedProviderId || providers[0].id);
  };
  const load = async () => {
    providers = await invoke("list_api_provider_settings");
    renderProviders();
  };
  const newProvider = () => {
    selectedProviderId = "";
    form.reset();
    field("key").placeholder = "请输入 API Key";
    capabilityNode.querySelectorAll("input").forEach((input) => { input.checked = false; });
    providersNode.querySelectorAll("button").forEach((button) => button.classList.remove("is-active"));
  };
  const open = async () => {
    panel.classList.add("is-open");
    panel.querySelector(`[data-kind="${kind}"]`).classList.add("is-active");
    try { await load(); } catch (error) { toast(`无法读取 API 设置：${String(error)}`, "error"); }
  };

  panel.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "import-legacy") {
      const legacy = legacyProviderRecords().filter((provider) => provider.models.length);
      if (!legacy.length) return toast("没有发现可导入的旧版本机 API 配置。", "info");
      if (!window.confirm(`将导入 ${legacy.length} 个旧版本机服务商配置到新版 F 盘数据目录。不会联网、不会删除旧配置，也不会显示密钥。是否继续？`)) return;
      let imported = 0;
      try {
        for (const provider of legacy) {
          await invoke("register_custom_provider", { config: { id: provider.id, name: provider.name, base_url: provider.baseUrl, models: provider.models } });
          if (provider.key) await invoke("set_api_key", { provider: provider.id, key: provider.key });
          await invoke("set_base_url", { provider: provider.id, url: provider.baseUrl });
          const categorized = new Map();
          provider.models.forEach((model) => {
            const entry = categorized.get(inferredModelKind(model)) || [];
            entry.push(model);
            categorized.set(inferredModelKind(model), entry);
          });
          for (const [modelKind, models] of categorized) {
            await invoke("save_api_model_catalog", { providerId: provider.id, kind: modelKind, models: models.map((id) => ({ id, label: id, capabilities: {} })) });
          }
          imported += 1;
        }
        await load();
        toast(`已导入 ${imported} 个旧版本机服务商配置。`, "success");
      } catch (error) {
        toast(`导入旧版配置失败：${String(error)}`, "error");
      }
      return;
    }
    if (action === "close") panel.classList.remove("is-open");
    if (action === "new") newProvider();
    if (action === "fetch-models") {
      const baseUrl = safeText(field("baseUrl").value);
      const key = field("key").value;
      if (!baseUrl) return toast("请先填写服务地址，再拉取模型。", "info");
      if (!key && !selectedProviderId) return toast("新服务需要先填写本次 API Key，再拉取模型。", "info");
      const savedProvider = providers.find((provider) => provider.id === selectedProviderId);
      if (!key && savedProvider && baseUrl.replace(/\/$/, "") !== String(savedProvider.base_url || "").replace(/\/$/, "")) {
        return toast("服务地址已修改；请先保存，或填写本次 API Key 后再拉取模型。", "info");
      }
      const button = event.target.closest('[data-action="fetch-models"]');
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      const originalLabel = button.textContent;
      button.textContent = "拉取中…";
      try {
        const models = key
          ? await invoke("list_remote_models", { baseUrl, apiKey: key })
          : await invoke("list_saved_provider_models", { providerId: selectedProviderId });
        field("models").value = models.join("\n");
        if (!selectedProviderId && !safeText(field("id").value)) ensureProviderId();
        toast(`已获取 ${models.length} 个模型。`, "success");
      } catch (error) { toast(modelFetchError(error), "error"); }
      finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = originalLabel;
      }
    }
    if (action === "test-connection") {
      const providerId = safeText(field("id").value);
      if (!providerId || !selectedProviderId || providerId !== selectedProviderId) {
        return toast("请先保存此服务和密钥，再测试连接。", "info");
      }
      try {
        const count = await invoke("test_api_provider_connection", { providerId });
        toast(count ? `连接成功，服务返回 ${count} 个模型。` : "连接成功；服务未返回模型列表。", "success");
      } catch (error) { toast(`连接测试失败：${String(error)}`, "error"); }
    }
  });
  panel.querySelector(".huahai-api__tabs").addEventListener("click", (event) => {
    const next = event.target.closest("[data-kind]")?.dataset.kind;
    if (!next || next === kind) return;
    kind = next;
    panel.querySelectorAll("[data-kind]").forEach((button) => button.classList.toggle("is-active", button.dataset.kind === kind));
    renderCapabilities();
    if (selectedProviderId) selectProvider(selectedProviderId); else newProvider();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = ensureProviderId();
    const name = safeText(field("name").value, id);
    const baseUrl = safeText(field("baseUrl").value).replace(/\/$/, "");
    const models = splitModels(field("models").value);
    if (!id || !name || !baseUrl || !models.length) return toast("请填写服务、地址和至少一个模型。", "error");
    try {
      await invoke("register_custom_provider", { config: { id, name, base_url: baseUrl, models } });
      if (field("key").value) await invoke("set_api_key", { provider: id, key: field("key").value });
      await invoke("set_base_url", { provider: id, url: baseUrl });
      const caps = capabilities();
      await invoke("save_api_model_catalog", { providerId: id, kind, models: models.map((model) => ({ id: model, label: model, capabilities: caps })) });
      syncLegacyProvider({ id, name, baseUrl, key: field("key").value, models, kind });
      selectedProviderId = id;
      await load();
      toast(`${tabs.find(([entry]) => entry === kind)?.[1]}已保存。`, "success");
    } catch (error) { toast(`保存 API 设置失败：${String(error)}`, "error"); }
  });
  renderCapabilities();
  return { open };
}
