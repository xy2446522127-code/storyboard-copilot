import { invoke, safeText, selectedFlowNodeIds, toast } from "../../shared/tauri.js";

function nodeContext() {
  const nodes = [...document.querySelectorAll(".react-flow__node.selected, .xyflow__node.selected")].slice(0, 8);
  return nodes.length ? {
    selectedNodes: nodes.map((node) => ({
      id: node.dataset.id || node.id || "",
      type: node.dataset.type || node.className,
      text: (node.innerText || "").slice(0, 180),
      mediaReference: node.querySelector("img,video")?.getAttribute("src")?.replace(/^data:.*$/, "[本地媒体已隐藏]") || undefined,
    })),
  } : {};
}

function extractActionPreview(content) {
  const match = String(content).match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
  if (!match) return null;
  try { return Array.isArray(JSON.parse(match[1])) ? match[1] : null; } catch { return null; }
}

export function installChatPanel({ openApiSettings } = {}) {
  const panel = document.createElement("section");
  panel.id = "huahai-chat-panel";
  panel.setAttribute("aria-label", "创作助手");
  panel.innerHTML = `
    <div class="huahai-chat__head"><strong>创作助手</strong><span data-scope>通用会话</span><button type="button" data-action="new" title="新建会话">＋</button><button type="button" data-action="close" title="关闭">×</button></div>
    <div class="huahai-chat__body">
      <aside class="huahai-chat__sessions"><div><span>会话</span><button type="button" data-action="refresh" title="刷新">↻</button></div><div data-sessions></div></aside>
      <main class="huahai-chat__main">
        <div class="huahai-chat__settings"><select data-field="model" aria-label="对话模型"></select><button type="button" data-action="system">系统提示词</button><button type="button" data-action="retry">重试</button></div>
        <div class="huahai-chat__system" hidden><textarea data-field="system" placeholder="系统提示词仅用于当前会话，不会保存 API Key 或本地路径。"></textarea></div>
        <div class="huahai-chat__messages" aria-live="polite"></div>
        <form class="huahai-chat__composer"><textarea data-field="message" placeholder="输入创作需求；默认只发送当前选中节点摘要，不发送原图或全量画布。"></textarea><div class="huahai-chat__composer-actions"><button type="button" data-action="cancel" disabled>停止</button><button type="submit" data-action="send">发送</button></div><label class="huahai-chat__context"><input type="checkbox" data-field="context" checked> 发送当前选中节点摘要</label></form>
      </main>
    </div>`;
  document.body.append(panel);
  const messages = panel.querySelector(".huahai-chat__messages");
  const sessionsNode = panel.querySelector("[data-sessions]");
  const modelNode = panel.querySelector('[data-field="model"]');
  const messageInput = panel.querySelector('[data-field="message"]');
  let session = null;
  let projectId = null;
  let inFlight = false;
  let lastUserText = "";

  const addMessage = (message, kind = message.role) => {
    const node = document.createElement("article");
    node.className = `huahai-chat__message huahai-chat__message--${kind}`;
    node.textContent = message.content || message;
    messages.append(node);
    messages.scrollTop = messages.scrollHeight;
    return node;
  };
  const renderSessions = (items) => {
    sessionsNode.replaceChildren(...items.map((item) => {
      const row = document.createElement("div");
      row.className = "huahai-chat__session";
      row.classList.toggle("is-active", item.id === session?.id);
      row.innerHTML = `<button type="button" data-session="${item.id}" title="${item.title}">${item.title}</button><button type="button" data-rename="${item.id}" title="重命名">⋯</button>`;
      return row;
    }));
  };
  const loadModels = async () => {
    const models = await invoke("list_configured_models", { kind: "chat" });
    modelNode.replaceChildren(...models.map((model) => {
      const option = document.createElement("option");
      option.value = `${model.providerId}::${model.id}`;
      option.textContent = `${model.providerName} · ${model.label || model.id}`;
      return option;
    }));
    if (!models.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "请先在 API 设置配置对话模型";
      modelNode.append(option);
    }
  };
  const loadSessions = async () => renderSessions(await invoke("list_chat_sessions", { projectId }));
  const loadMessages = async () => {
    messages.replaceChildren();
    if (!session) return;
    (await invoke("list_chat_messages", { sessionId: session.id })).forEach((message) => addMessage(message));
  };
  const ensureSession = async () => {
    if (session) return session;
    const [providerId, model] = String(modelNode.value).split("::");
    session = await invoke("create_chat_session", { projectId, title: projectId ? "项目创作对话" : "新对话", model: model || "", providerId: providerId || "" });
    await loadSessions();
    return session;
  };
  const setBusy = (value) => {
    inFlight = value;
    panel.querySelector('[data-action="send"]').disabled = value;
    panel.querySelector('[data-action="cancel"]').disabled = !value;
  };
  const send = async (text = messageInput.value) => {
    const content = safeText(text);
    if (!content || inFlight) return;
    const [providerId, model] = String(modelNode.value).split("::");
    if (!providerId || !model) {
      toast("请先在 API 设置中配置可用的对话模型。", "info");
      return openApiSettings?.();
    }
    setBusy(true);
    try {
      await ensureSession();
      addMessage({ role: "user", content });
      messageInput.value = "";
      lastUserText = content;
      const pending = addMessage("正在等待模型回复…", "status");
      const context = panel.querySelector('[data-field="context"]').checked ? nodeContext() : {};
      const reply = await invoke("send_chat_message", { sessionId: session.id, providerId, model, content, contextJson: JSON.stringify({ ...context, systemPrompt: safeText(panel.querySelector('[data-field="system"]').value) }) });
      pending.remove();
      const messageNode = addMessage(reply);
      const actionsJson = extractActionPreview(reply.content);
      if (actionsJson) {
        const preview = document.createElement("div");
        preview.className = "huahai-chat__preview";
        preview.innerHTML = '<span>检测到画布操作建议；执行前必须确认。</span><button type="button">创建预览</button>';
        preview.querySelector("button").addEventListener("click", async () => {
          try {
            const stored = await invoke("create_agent_preview", { sessionId: session.id, projectId, actionsJson });
            const approved = window.confirm("操作预览已保存。确认后仍会显示影响范围和费用提示；是否确认？");
            await invoke("resolve_agent_preview", { previewId: stored.id, confirm: approved });
            toast(approved ? "操作预览已确认；请在画布中审核后应用。" : "操作预览已拒绝。", approved ? "success" : "info");
          } catch (error) { toast(`无法创建操作预览：${String(error)}`, "error"); }
        });
        messageNode.append(preview);
      }
      await loadSessions();
    } catch (error) { addMessage(`对话失败：${String(error)}`, "status"); }
    finally { setBusy(false); }
  };
  panel.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const sessionId = event.target.closest("[data-session]")?.dataset.session;
    const renameId = event.target.closest("[data-rename]")?.dataset.rename;
    if (sessionId) { session = (await invoke("list_chat_sessions", { projectId })).find((item) => item.id === sessionId) || null; await loadMessages(); await loadSessions(); }
    if (renameId) {
      const item = (await invoke("list_chat_sessions", { projectId })).find((entry) => entry.id === renameId);
      const title = window.prompt("会话名称", item?.title || "");
      if (title === null) return;
      if (!title.trim()) return toast("会话名称不能为空。", "error");
      await invoke("rename_chat_session", { sessionId: renameId, title }); await loadSessions();
    }
    if (action === "close") panel.classList.remove("is-open");
    if (action === "new") { session = null; messages.replaceChildren(); await ensureSession(); }
    if (action === "refresh") { await loadModels(); await loadSessions(); }
    if (action === "retry" && lastUserText) send(lastUserText);
    if (action === "cancel" && inFlight) toast("当前版本正在接入流式取消；本次请求会完成但不会执行任何画布操作。", "info");
    if (action === "system") { const box = panel.querySelector(".huahai-chat__system"); box.hidden = !box.hidden; }
  });
  panel.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); send(); });
  return {
    async open() {
      panel.classList.add("is-open");
      try {
        projectId = await invoke("find_project_for_canvas_selection", { nodeIds: selectedFlowNodeIds() });
        panel.querySelector("[data-scope]").textContent = projectId ? "当前项目会话" : "通用会话";
        session = null;
        await loadModels(); await loadSessions();
      } catch (error) { toast(`无法打开创作助手：${String(error)}`, "error"); }
      messageInput.focus();
    },
  };
}
