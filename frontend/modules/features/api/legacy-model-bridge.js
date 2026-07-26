import { invoke, toast } from "../../shared/tauri.js";

const MODEL_PLACEHOLDER = /模型名称|model\s*(名称|name)/i;

function legacyModelFields() {
  return [...document.querySelectorAll("textarea")]
    .filter((field) => MODEL_PLACEHOLDER.test(field.placeholder || ""));
}

function valueSetter(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function apiFields(field) {
  let scope = field.parentElement;
  for (let depth = 0; scope && depth < 7; depth += 1, scope = scope.parentElement) {
    const inputs = [...scope.querySelectorAll("input")];
    const baseUrl = inputs.find((input) => /^https?:\/\//i.test(input.value || ""))?.value?.trim();
    const apiKey = inputs.find((input) => input.type === "password")?.value;
    if (baseUrl && apiKey !== undefined) return { baseUrl, apiKey };
  }
  return { baseUrl: "", apiKey: "" };
}

function normalizedBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// The recovered form clears an already-saved password so the WebView cannot
// read it back. Match its URL to the native F-drive provider record instead.
async function savedProviderForBaseUrl(baseUrl) {
  const target = normalizedBaseUrl(baseUrl);
  if (!target) return null;
  const providers = await invoke("list_api_provider_settings");
  return providers.find((provider) => provider?.key_configured
    && normalizedBaseUrl(provider.base_url || provider.baseUrl) === target) || null;
}

function insertBridge(field) {
  if (field.dataset.huahaiModelBridge === "true") return;
  field.dataset.huahaiModelBridge = "true";
  const bridge = document.createElement("section");
  bridge.className = "huahai-legacy-model-bridge";
  bridge.innerHTML = `<div class="huahai-legacy-model-bridge__head"><span>从服务商选择模型</span><button type="button" data-action="fetch">拉取模型</button></div><input type="search" data-search placeholder="搜索已拉取的模型" hidden /><select data-models size="7" multiple hidden aria-label="可选择的模型"></select><div class="huahai-legacy-model-bridge__actions" hidden><button type="button" data-action="apply">使用选中模型</button><button type="button" data-action="refresh">刷新</button></div>`;
  field.insertAdjacentElement("afterend", bridge);
  const fetchButton = bridge.querySelector('[data-action="fetch"]');
  const search = bridge.querySelector("[data-search]");
  const select = bridge.querySelector("[data-models]");
  const actions = bridge.querySelector(".huahai-legacy-model-bridge__actions");
  let models = [];
  const render = () => {
    const filter = search.value.trim().toLowerCase();
    const selected = new Set(String(field.value || "").split(/[，,\n]/).map((value) => value.trim()).filter(Boolean));
    select.replaceChildren(...models.filter((model) => model.toLowerCase().includes(filter)).map((model) => {
      const option = document.createElement("option");
      option.value = model; option.textContent = model; option.selected = selected.has(model);
      return option;
    }));
  };
  const fetchModels = async () => {
    const { baseUrl, apiKey } = apiFields(field);
    if (!baseUrl) return toast("请先填写服务地址，再拉取模型。", "info");
    fetchButton.disabled = true; fetchButton.textContent = "拉取中…";
    try {
      if (apiKey) {
        models = await invoke("list_remote_models", { baseUrl, apiKey });
      } else {
        const provider = await savedProviderForBaseUrl(baseUrl);
        if (!provider) {
          return toast("未找到此地址对应的已保存密钥。请先保存连接，或仅为本次拉取填写 API Key。", "info");
        }
        models = await invoke("list_saved_provider_models", { providerId: provider.id });
      }
      if (!models.length) return toast("服务已响应，但没有返回可选择的模型。", "info");
      search.hidden = false; select.hidden = false; actions.hidden = false; render();
      toast(`已拉取 ${models.length} 个模型；勾选后点击“使用选中模型”。`, "success");
    } catch (error) {
      const detail = String(error);
      if (/\b401\b/.test(detail)) toast("拉取失败：服务拒绝了密钥（401）。请确认密钥有效且不要包含 Bearer。", "error");
      else if (/timeout|timed out|超时/i.test(detail)) toast("拉取模型超时，请检查服务地址和网络后重试。", "error");
      else toast("拉取模型失败：请检查服务地址、密钥和模型列表权限。", "error");
    } finally { fetchButton.disabled = false; fetchButton.textContent = "拉取模型"; }
  };
  bridge.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "fetch" || action === "refresh") fetchModels();
    if (action === "apply") {
      const selected = [...select.selectedOptions].map((option) => option.value);
      if (!selected.length) return toast("请先选择至少一个模型。", "info");
      valueSetter(field, selected.join(", "));
      toast(`已将 ${selected.length} 个模型写入旧版配置；保存后即可在原有节点中选择。`, "success");
    }
  });
  search.addEventListener("input", render);
}

export function installLegacyModelBridge() {
  const scan = () => legacyModelFields().forEach(insertBridge);
  scan();
  const observer = new MutationObserver(scan);
  observer.observe(document.getElementById("root"), { childList: true, subtree: true });
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
}
