(() => {
  const root = document.getElementById("root");
  let started = false;

  const report = (message) => {
    // The recovered application must remain usable even if a new modular feature fails.
    // Keep diagnostics out of its layout and never replace the legacy root.
    const notice = document.createElement("button");
    notice.type = "button";
    notice.textContent = "花海画布扩展未加载：点击查看原因";
    notice.title = String(message);
    notice.style.cssText = "position:fixed;right:18px;bottom:58px;z-index:2147483646;padding:7px 10px;border:1px solid #8d3b3b;border-radius:9px;background:#4b2020;color:#fff;cursor:pointer";
    notice.addEventListener("click", () => window.alert(`扩展功能未加载：\n${String(message)}`));
    document.body.append(notice);
  };

  const stylesheet = (href) => new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = resolve;
    link.onerror = () => reject(new Error(`无法加载样式：${href}`));
    document.head.append(link);
  });

  const start = async () => {
    if (started) return;
    started = true;
    try {
      await Promise.all([
        "/modules/styles/tokens.css",
        "/modules/styles/shell.css",
        "/modules/features/sidebar/sidebar.css",
        "/modules/features/api/api-settings.css",
        "/modules/features/api/legacy-model-bridge.css",
        "/modules/features/image/image-studio.css",
        "/modules/features/chat/chat.css",
        "/modules/features/canvas/batch-tools.css",
        "/modules/features/announcements/announcements.css",
        "/modules/features/performance/media-performance.css",
        "/modules/features/update/update.css",
      ].map(stylesheet));
      await import("/modules/app-shell.js");
    } catch (error) {
      report(error);
    }
  };

  // The legacy bundle owns #root.  Wait until it has rendered (or a bounded fallback)
  // before loading optional modules, so a module error can never blank the application.
  const ready = () => root && root.childElementCount > 0;
  if (ready()) {
    window.setTimeout(start, 300);
  } else if (root) {
    const observer = new MutationObserver(() => {
      if (ready()) {
        observer.disconnect();
        window.setTimeout(start, 300);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    window.setTimeout(() => {
      observer.disconnect();
      start();
    }, 2500);
  }
})();
