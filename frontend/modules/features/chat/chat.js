import { invoke, safeText, toast } from "../../shared/tauri.js";

const defaultProvider = localStorage.getItem("huahai-chat-provider") || "grsai";
const defaultModel = localStorage.getItem("huahai-chat-model") || "gpt-5-mini";

function nodeContext() {
  const nodes = [...document.querySelectorAll(".react-flow__node.selected, .xyflow__node.selected")].slice(0, 8);
  if (!nodes.length) return {};
  return {
    selectedNodes: nodes.map((node) => ({
      id: node.dataset.id || node.id || "",
      type: node.dataset.type || node.className,
      text: (node.innerText || "").slice(0, 180),
      mediaReference: node.querySelector("img,video")?.getAttribute("src") || undefined,
    })),
  };
}

function extractActionPreview(content) {
  const match = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
  if (!match) return null;
  try {
    const actions = JSON.parse(match[1]);
    return Array.isArray(actions) ? JSON.stringify(actions) : null;
  } catch { return null; }
}

export function installChatPanel() {
  const panel = document.createElement("section");
  panel.id = "huahai-chat-panel";
  panel.setAttribute("aria-label", "GPT 对话");
  panel.innerHTML = `
    <div class="huahai-chat__head"><strong>GPT 对话</strong><button type="button" data-action="new">＋</button><button type="button" data-action="close">×</button></div>
    <div class="huahai-chat__settings"><input data-field="provider" aria-label="服务商 ID" value="${defaultProvider}"><input data-field="model" aria-label="模型" value="${defaultModel}"><button type="button" data-action="retry">重试</button></div>
    <div class="huahai-chat__messages" aria-live="polite"></div>
    <form class="huahai-chat__composer"><textarea data-field="message" placeholder="输入你的创作需求；默认只发送当前选中节点的文字与媒体引用。"></textarea><div class="huahai-chat__composer-actions"><button type="button" data-action="cancel">取消</button><button type="submit" data-action="send">发送</button></div><label class="huahai-chat__context"><input type="checkbox" data-field="context" checked> 发送当前选中节点摘要（不发送原图、全量画布或 API 密钥）</label></form>`;
  document.body.append(panel);
  const messages = panel.querySelector(".huahai-chat__messages");
  const messageInput = panel.querySelector('[data-field="message"]');
  let session;
  let lastRequest = 0;
  let lastUserText = "";

  const addMessage = (message, kind = message.role) => {
    const node = document.createElement("article");
    node.className = `huahai-chat__message huahai-chat__message--${kind}`;
    node.textContent = message.content || message;
    messages.append(node);
    messages.scrollTop = messages.scrollHeight;
    return node;
  };
  const loadMessages = async () => {
    messages.replaceChildren();
    if (!session) return;
    const history = await invoke("list_chat_messages", { sessionId: session.id });
    history.forEach(addMessage);
  };
  const ensureSession = async () => {
    if (session) return session;
    session = await invoke("create_chat_session", {
      projectId: null,
      title: "通用对话",
      model: panel.querySelector('[data-field="model"]').value.trim(),
    });
    return session;
  };
  const send = async (text = messageInput.value) => {
    const content = safeText(text);
    if (!content) return;
    const request = ++lastRequest;
    const provider = panel.querySelector('[data-field="provider"]').value.trim() || "grsai";
    const model = panel.querySelector('[data-field="model"]').value.trim();
    localStorage.setItem("huahai-chat-provider", provider);
    localStorage.setItem("huahai-chat-model", model);
    try {
      await ensureSession();
      addMessage({ role: "user", content });
      messageInput.value = "";
      lastUserText = content;
      const pending = addMessage("正在等待模型回复…", "status");
      const context = panel.querySelector('[data-field="context"]').checked ? nodeContext() : {};
      const reply = await invoke("send_chat_message", {
        sessionId: session.id,
        providerId: provider,
        model,
        content,
        contextJson: JSON.stringify(context),
      });
      pending.remove();
      if (request !== lastRequest) return;
      const messageNode = addMessage(reply);
      const actionsJson = extractActionPreview(reply.content);
      if (actionsJson) {
        const preview = document.createElement("div");
        preview.className = "huahai-chat__preview";
        preview.innerHTML = '<span>检测到操作草案；执行前必须确认。</span><button type="button">创建预览</button>';
        preview.querySelector("button").addEventListener("click", async () => {
          try {
            const stored = await invoke("create_agent_preview", { sessionId: session.id, projectId: null, actionsJson });
            const approved = window.confirm("预览已保存。它可能包含节点创建、连接、排列、修改或付费生成。确认后仍会逐项提示费用与影响范围。现在确认此预览吗？");
            await invoke("resolve_agent_preview", { previewId: stored.id, confirm: approved });
            toast(approved ? "操作预览已确认；请在画布中审核后应用。" : "操作预览已拒绝。", approved ? "success" : "info");
          } catch (error) { toast(`无法创建操作预览：${String(error)}`, "error"); }
        });
        messageNode.append(preview);
      }
    } catch (error) {
      if (request === lastRequest) addMessage(`对话失败：${String(error)}`, "status");
    }
  };
  panel.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); send(); });
  panel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "close") panel.classList.remove("is-open");
    if (action === "new") { session = null; messages.replaceChildren(); toast("已新建未关联项目的本地会话。", "success"); }
    if (action === "cancel") { lastRequest += 1; toast("已停止等待；服务器端未执行任何画布操作。", "info"); }
    if (action === "retry" && lastUserText) send(lastUserText);
  });
  return {
    async open() {
      panel.classList.add("is-open");
      try { await ensureSession(); await loadMessages(); } catch (error) { toast(`无法读取会话：${String(error)}`, "error"); }
      messageInput.focus();
    },
  };
}
