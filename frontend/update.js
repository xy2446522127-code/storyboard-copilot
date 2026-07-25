(() => {
  const invoke = (command, arguments_ = {}) =>
    window.__TAURI_INTERNALS__?.invoke(command, arguments_);

  const notify = (message, tone = 'default') => {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:64px', 'z-index:2147483647',
      'max-width:340px', 'padding:10px 14px', 'border-radius:10px',
      'color:#fff', 'font:13px/1.45 system-ui,"Microsoft YaHei",sans-serif',
      `background:${tone === 'error' ? '#b42318' : '#1f2937'}`,
      'box-shadow:0 8px 24px rgba(0,0,0,.3)'
    ].join(';');
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 4400);
  };

  const createButton = () => {
    if (!window.__TAURI_INTERNALS__ || document.getElementById('huahai-update-button')) return;
    const button = document.createElement('button');
    button.id = 'huahai-update-button';
    button.type = 'button';
    button.textContent = '检查更新';
    button.title = '检查花海画布更新';
    button.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647',
      'border:1px solid rgba(255,255,255,.22)', 'border-radius:999px',
      'padding:8px 12px', 'background:#172033', 'color:#fff',
      'font:13px/1 system-ui,"Microsoft YaHei",sans-serif', 'cursor:pointer',
      'box-shadow:0 5px 18px rgba(0,0,0,.28)'
    ].join(';');

    const check = async ({ interactive }) => {
      if (button.dataset.busy === 'true') return;
      button.dataset.busy = 'true';
      button.disabled = true;
      const before = button.textContent;
      button.textContent = '正在检查…';
      try {
        const update = await invoke('check_for_update');
        if (!update) {
          button.textContent = '检查更新';
          if (interactive) notify('花海画布已是最新版本。');
          return;
        }

        button.textContent = `发现 v${update.version}`;
        button.style.background = '#0f766e';
        if (!interactive) return;

        const notes = (update.notes || '本次版本包含功能优化与问题修复。').slice(0, 1200);
        const approved = window.confirm(
          `发现花海画布 v${update.version}。\n\n${notes}\n\n安装会先验证签名，并在 Windows 安装窗口中显示进度。请确认当前重要内容已保存。现在更新吗？`
        );
        if (!approved) return;

        button.textContent = '正在下载安装…';
        notify('正在下载并验证更新，完成后程序会自动退出并安装。');
        await invoke('install_available_update');
      } catch (error) {
        button.textContent = before;
        notify(`更新服务暂不可用：${String(error)}`, 'error');
      } finally {
        button.dataset.busy = 'false';
        button.disabled = false;
      }
    };

    button.addEventListener('click', () => check({ interactive: true }));
    document.body.append(button);
    window.setTimeout(() => check({ interactive: false }), 3500);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createButton, { once: true });
  } else {
    createButton();
  }
})();
