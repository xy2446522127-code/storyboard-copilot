# -*- coding: utf-8 -*-
"""
Jimeng (即梦) Web Video Generation via Playwright Browser Automation

Flow:
  1. Launch Chrome/Edge with remote debugging port (or connect to existing)
  2. User logs in on jimeng.jianying.com
  3. Navigate to video generation page
  4. Fill prompt, upload images, select model/duration/ratio
  5. Click generate button
  6. Intercept network response to get submit_id
  7. Poll page for video result
  8. Download video and save to output path

Communicates with Tauri app via stdout JSON protocol.
"""

import asyncio
import base64
import json
import os
import sys
import time
import signal
import shutil
import subprocess
from pathlib import Path
from typing import Optional

# ── Constants ──────────────────────────────────────────────────────────────

JIMENG_VIDEO_URL = "https://jimeng.jianying.com/ai-tool/home?type=video"
JIMENG_BASE = "https://jimeng.jianying.com"
GENERATE_ENDPOINT = "/mweb/v1/aigc_draft/generate"
ASSET_LIST_ENDPOINT = "/mweb/v1/get_asset_list"
HISTORY_ENDPOINT = "/mweb/v1/get_history_by_ids"
CREATION_AGENT_ENDPOINT = "/mweb/v1/creation_agent"

DEFAULT_CDP_PORT = 19222
POLL_INTERVAL = 3
MAX_POLL_ATTEMPTS = 300  # 15 minutes max

# This helper is launched by the desktop application, but Python, pip and
# Playwright otherwise choose the Windows profile on C:.  Keep every mutable
# helper directory under the same F: data root as the application.
DEFAULT_HUAHAI_ROOT = Path(r"F:\Huahaihuabu\花海画布-data\jimeng-runtime")

def huahai_root() -> Path:
    configured = os.environ.get("HUAHAI_JIMENG_ROOT", "").strip()
    root = Path(configured) if configured else DEFAULT_HUAHAI_ROOT
    if os.name == "nt" and not str(root).lower().startswith("f:\\"):
        root = DEFAULT_HUAHAI_ROOT
    root.mkdir(parents=True, exist_ok=True)
    return root

def huahai_dir(name: str) -> Path:
    directory = huahai_root() / name
    directory.mkdir(parents=True, exist_ok=True)
    return directory

def configure_local_runtime():
    root = huahai_root()
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(huahai_dir("playwright-browsers")))
    os.environ.setdefault("PIP_CACHE_DIR", str(huahai_dir("pip-cache")))
    os.environ.setdefault("PYTHONPYCACHEPREFIX", str(huahai_dir("pycache")))
    packages = huahai_dir("python-packages")
    if str(packages) not in sys.path:
        sys.path.insert(0, str(packages))
    return packages

PYTHON_PACKAGES = configure_local_runtime()

def install_playwright_to_f_drive():
    subprocess.check_call([
        sys.executable, "-m", "pip", "install", "--target", str(PYTHON_PACKAGES),
        "--no-warn-script-location", "playwright", "--quiet"
    ], env=os.environ.copy())
    if str(PYTHON_PACKAGES) not in sys.path:
        sys.path.insert(0, str(PYTHON_PACKAGES))

# ── JSON Protocol Helper ──────────────────────────────────────────────────

def emit(event: str, data: dict = None):
    """Emit a JSON event to stdout for the Tauri app to read."""
    msg = {"event": event}
    if data:
        msg.update(data)
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def emit_progress(stage: str, percent: int = 0, message: str = ""):
    emit("progress", {"stage": stage, "percent": percent, "message": message})

def emit_error(error: str):
    emit("error", {"error": error})

def emit_result(video_path: str, video_url: str = ""):
    emit("result", {"video_path": video_path, "video_url": video_url})

# ── Browser Finding ────────────────────────────────────────────────────────

def find_browser_exe() -> Optional[str]:
    """Find Chrome or Edge browser executable."""
    if sys.platform == "darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    else:
        candidates = [
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None

# ── CDP Port Management ───────────────────────────────────────────────────

def pick_free_port() -> int:
    """Find a free TCP port."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]

def wait_cdp_ready(port: int, timeout: float = 30) -> bool:
    """Wait for Chrome DevTools Protocol to become available."""
    import urllib.request
    import urllib.error
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            url = f"http://127.0.0.1:{port}/json/version"
            req = urllib.request.urlopen(url, timeout=2)
            data = json.loads(req.read())
            if data.get("webSocketDebuggerUrl"):
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False

# ── Login Browser ──────────────────────────────────────────────────────────

def cmd_open_login_browser(params: dict):
    """Open a browser for user to login to jimeng."""
    browser_exe = params.get("browser_exe") or find_browser_exe()
    if not browser_exe:
        emit_error("未找到Chrome或Edge浏览器，请在设置中指定浏览器路径")
        return

    port = params.get("port") or DEFAULT_CDP_PORT

    # Check if browser already running on this port
    if wait_cdp_ready(port, timeout=1):
        emit("login_browser_ready", {"port": port, "message": "浏览器已运行，CDP端口可用"})
        return

    # User data dir for persistent login
    app_data = str(huahai_dir("browser-profile"))

    cmd = [
        browser_exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={app_data}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
        f"--window-position=100,100",
        JIMENG_VIDEO_URL,
    ]

    try:
        # Launch browser as detached process
        if sys.platform == "win32":
            subprocess.Popen(cmd, creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
        else:
            subprocess.Popen(cmd, start_new_session=True)

        emit_progress("login", 0, "正在启动浏览器...")

        # Wait for CDP to become ready
        if wait_cdp_ready(port, timeout=30):
            emit("login_browser_ready", {"port": port, "message": "浏览器已启动，请在浏览器中登录即梦账号"})
        else:
            emit_error("浏览器启动超时，请检查浏览器是否正常运行")
    except Exception as e:
        emit_error(f"启动浏览器失败: {e}")

# ── Playwright Automation ──────────────────────────────────────────────────

async def _ensure_playwright():
    """Import playwright, install if needed."""
    try:
        from playwright.async_api import async_playwright
        return async_playwright
    except ImportError:
        emit_progress("install", 0, "正在安装Playwright...")
        install_playwright_to_f_drive()
        from playwright.async_api import async_playwright
        return async_playwright

async def _generate_via_playwright(params: dict):
    """Core Playwright automation for video generation."""
    async_playwright = await _ensure_playwright()

    port = params.get("port") or DEFAULT_CDP_PORT
    prompt = params.get("prompt", "")
    model = params.get("model", "seedance-2.0")
    mode = params.get("mode", "fullReference")  # Default to 全能参考 (available in all models)
    duration = params.get("duration", 5)
    aspect_ratio = params.get("aspect_ratio", "16:9")
    first_frame_path = params.get("first_frame_path")
    last_frame_path = params.get("last_frame_path")
    ref_image_paths = params.get("ref_image_paths", [])
    output_dir = params.get("output_dir", str(huahai_dir("output")))
    timeout = params.get("timeout", 900)

    os.makedirs(output_dir, exist_ok=True)

    emit_progress("connect", 5, "正在连接浏览器...")

    async with async_playwright() as p:
        # Try to connect to existing browser via CDP first
        browser = None
        try:
            browser = await p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            emit_progress("connect", 8, "已连接到已打开的浏览器")
        except Exception:
            emit_progress("connect", 6, "未找到已运行的浏览器，尝试启动新浏览器...")

        # If no existing browser, launch a new one using system Edge or Chrome
        if not browser:
            browser_exe = find_browser_exe()
            launch_kwargs = {"headless": False}

            if browser_exe:
                # Use system browser directly (no need to download Chromium)
                if "msedge" in browser_exe.lower() or "microsoft edge" in browser_exe.lower():
                    launch_kwargs["channel"] = "msedge"
                elif "chrome" in browser_exe.lower() or "google chrome" in browser_exe.lower():
                    launch_kwargs["channel"] = "chrome"
                # Set user data dir for persistent login
                # Persistent profiles are created by the explicit login command
                # above. `BrowserType.launch` does not accept user_data_dir;
                # passing it made the fallback path fail before a page opened.
                launch_kwargs["args"] = ["--no-first-run", "--disable-popup-blocking"]

            try:
                browser = await p.chromium.launch(**launch_kwargs)
                emit_progress("connect", 10, "浏览器已启动")
            except Exception as e2:
                emit_error(f"无法启动浏览器: {e2}")
                return

        # Find or create page on jimeng
        contexts = browser.contexts
        page = None
        for ctx in contexts:
            for pg in ctx.pages:
                url = pg.url
                if "jimeng.jianying.com" in url:
                    page = pg
                    break
            if page:
                break

        if not page:
            if contexts:
                page = contexts[0].pages[0] if contexts[0].pages else await contexts[0].new_page()
            else:
                ctx = await browser.new_context()
                page = await ctx.new_page()

        # Navigate to video generation page if not already there
        emit_progress("navigate", 10, "正在导航到视频生成页面...")
        try:
            await page.goto(JIMENG_VIDEO_URL, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            emit_progress("navigate", 10, f"导航超时，继续操作: {e}")

        await asyncio.sleep(2)

        # ── Network interception ──
        submit_id_holder = {"id": None}
        gen_response_holder = {"data": None}

        async def handle_response(response):
            """Intercept network responses to capture generate endpoint data."""
            url = response.url
            try:
                if GENERATE_ENDPOINT in url:
                    body = await response.text()
                    try:
                        data = json.loads(body)
                        # Extract submit_id / history_id
                        hid = (data.get("data", {}).get("history_id")
                               or data.get("data", {}).get("id")
                               or data.get("data", {}).get("aigc_task_id"))
                        if hid:
                            submit_id_holder["id"] = str(hid)
                            emit_progress("submitted", 20, f"已提交任务，ID: {hid}")
                        gen_response_holder["data"] = data
                    except json.JSONDecodeError:
                        pass
            except Exception:
                pass

        page.on("response", handle_response)

        # ── Step 1: Switch to video mode ──
        emit_progress("mode", 12, "正在确保视频生成模式...")
        await _ensure_video_mode(page)

        # ── Step 2: Select model FIRST (before mode — model determines available modes) ──
        emit_progress("model", 14, f"正在选择模型: {model}...")
        await _select_model_v3(page, model)

        # ── Step 3: Switch reference mode (AFTER model — mode list depends on model) ──
        emit_progress("mode_switch", 17, f"正在切换到 {mode} 模式...")
        await _switch_reference_mode_v3(page, mode)

        # ── Step 4: Set duration ──
        emit_progress("duration", 19, f"正在设置时长: {duration}秒...")
        await _set_duration_v3(page, str(duration))

        # ── Step 5: Set aspect ratio ──
        if aspect_ratio and aspect_ratio != "auto":
            emit_progress("ratio", 21, f"正在设置画幅比例: {aspect_ratio}...")
            await _set_aspect_ratio_v3(page, aspect_ratio)

        # ── Step 6: Upload images ──
        all_refs = []
        if first_frame_path and os.path.exists(first_frame_path):
            all_refs.append(first_frame_path)
        for rp in ref_image_paths:
            if rp and os.path.exists(rp) and rp not in all_refs:
                all_refs.append(rp)

        if all_refs:
            emit_progress("upload", 23, f"正在上传图片 ({len(all_refs)}张)...")
            await _upload_images_v3(page, mode, all_refs, first_frame_path, last_frame_path)
        elif last_frame_path and os.path.exists(last_frame_path):
            emit_progress("upload", 23, "正在上传尾帧图片...")
            await _upload_images_v3(page, mode, [], None, last_frame_path)

        # ── Step 7: Fill prompt ──
        if prompt:
            emit_progress("prompt", 26, "正在填写提示词...")
            await _fill_prompt_v3(page, prompt)

        # ── Step 8: Click generate ──
        emit_progress("generate", 30, "正在点击生成按钮...")
        clicked = await _click_generate_v3(page)
        if not clicked:
            emit_error("未找到生成按钮，请确认页面已加载完成且已登录")
            return

        # ── Wait for submit_id ──
        emit_progress("waiting", 35, "等待任务提交...")
        deadline_submit = time.time() + 60
        while not submit_id_holder["id"] and time.time() < deadline_submit:
            await asyncio.sleep(1)

        if not submit_id_holder["id"]:
            emit_error("未捕获到生成请求，可能是未登录或提示词过长")
            return

        submit_id = submit_id_holder["id"]
        emit_progress("polling", 40, f"正在等待视频生成 (任务ID: {submit_id[:12]}...)")

        # ── Poll for result ──
        video_url = None
        max_wait = time.time() + timeout
        poll_count = 0

        while time.time() < max_wait:
            await asyncio.sleep(POLL_INTERVAL)
            poll_count += 1

            # Try to get progress from page DOM
            progress = await _scrape_page_progress(page)
            pct = progress.get("percent", 0)
            status_text = progress.get("status", "")
            v_url = progress.get("video_url")

            elapsed = int(time.time() - max_wait + timeout)
            emit_progress("polling", 40 + min(pct // 2, 50),
                         f"生成中 ({status_text}) {pct}%... 已等待{elapsed}秒")

            if v_url:
                video_url = v_url
                break

            # Also try to find video in completed cards
            if pct >= 100 or status_text in ("生成完成", "已完成"):
                card_video = await _find_video_in_cards(page)
                if card_video:
                    video_url = card_video
                    break

            if status_text in ("生成失败", "审核失败", "视频未通过审核"):
                emit_error(f"视频生成失败: {status_text}")
                return

        if not video_url:
            emit_error(f"等待视频生成超时 ({timeout}秒)")
            return

        # ── Download video ──
        emit_progress("downloading", 90, "正在下载视频...")

        output_path = await _download_video(video_url, output_dir, submit_id)
        if output_path:
            emit_result(output_path, video_url)
        else:
            emit_error("视频下载失败")

# ═══════════════════════════════════════════════════════════════════════════
# V3: DOM-aware interaction helpers (2026-06-14 rewrite)
#
# Key DOM findings from live page analysis:
#   - Toolbar selects use class ".lv-select-single[class*='toolbar-select']"
#     (NOT ".toolbar-se" which was wrong in V2)
#   - Index mapping: [0]=类型(视频生成), [1]=模型, [2]=模式, [3]=时长
#   - Mode select is wrapped in .feature-select-EjlZ_c
#   - Options appear in popup as .lv-select-option after clicking trigger
#   - Trigger: .lv-select-view-selector (click to open)
#   - Current value: .lv-select-view-value
#
# Seedance 2.0 modes: 全能参考, 首尾帧, 智能多帧
# Seedance 1.x modes: 文生视频, 图生视频, 首尾帧, 全能参考 (etc.)
# Mode list changes per model — must handle missing modes gracefully
# ═══════════════════════════════════════════════════════════════════════════

MODE_LABEL_MAP = {
    "text2video":       "文生视频",
    "image2video":      "图生视频",
    "first_end_frame":  "首尾帧",
    "firstLastFrame":   "首尾帧",
    "omni_reference":   "全能参考",
    "fullReference":    "全能参考",
    "videoReference":   "视频参考",
    "smart_multiframe": "智能多帧",
    "smartMultiframe":  "智能多帧",
}

# Map our model names to the display text shown in the jimeng dropdown
MODEL_DISPLAY_MAP = {
    "seedance-2.0":          "Seedance 2.0 VIP",
    "seedance-2.0-fast":     "Seedance 2.0 Fast VIP",
    "jimeng-video-seedance-2.0":          "Seedance 2.0",
    "jimeng-video-seedance-2.0-fast":     "Seedance 2.0 Fast",
    "jimeng-video-seedance-2.0-vip":      "Seedance 2.0 VIP",
    "jimeng-video-seedance-2.0-fast-vip":  "Seedance 2.0 Fast VIP",
    "jimeng-video-seedance-2.0-mini":      "Seedance 2.0 mini",
    "jimeng-video-3.5-pro": "即梦 3.5 Pro",
    "jimeng-video-3.5":     "即梦 3.5",
    "jimeng-video-3.0-pro": "Seedance 1.5 Pro",
    "jimeng-video-3.0":     "Seedance 1.0",
    "jimeng-video-3.0-fast": "Seedance 1.0 Fast",
}

# CSS selector for toolbar selects — verified against live DOM
TOOLBAR_SELECT_SELECTOR = '.lv-select-single[class*="toolbar-select"]'

# Toolbar select indices
SELECT_TYPE    = 0  # 视频生成 / 图片生成
SELECT_MODEL   = 1  # 模型
SELECT_MODE    = 2  # 模式 (全能参考/首尾帧/智能多帧 etc.)
SELECT_DURATION = 3  # 时长


async def _click_lv_select_option(page, select_index: int, option_text: str) -> bool:
    """Click an lv-select dropdown by index, then click the option matching option_text.

    Uses the correct CSS selector: .lv-select-single[class*="toolbar-select"]
    select_index: 0=type, 1=model, 2=mode, 3=duration
    """
    try:
        # Click the dropdown trigger to open the option list
        clicked = await page.evaluate(f"""() => {{
            const selects = document.querySelectorAll('{TOOLBAR_SELECT_SELECTOR}');
            if (selects.length <= {select_index}) return false;

            const trigger = selects[{select_index}].querySelector('.lv-select-view-selector');
            if (!trigger) return false;
            trigger.click();
            return true;
        }}""")
        if not clicked:
            emit_progress("select", 0, f"未找到下拉框[{select_index}]")
            return False

        await asyncio.sleep(0.6)

        # Now click the matching option in the dropdown popup
        # Use exact match first, then fallback to includes
        selected = await page.evaluate("""(optionText) => {
            // Strategy 1: exact match on .lv-select-option text
            const allOptions = document.querySelectorAll('.lv-select-option');
            for (const opt of allOptions) {
                const text = (opt.innerText || '').split('\\n')[0].trim();
                if (text === optionText) {
                    opt.click();
                    return 'exact';
                }
            }

            // Strategy 2: includes match
            for (const opt of allOptions) {
                const text = (opt.innerText || '').split('\\n')[0].trim();
                if (text.includes(optionText) || optionText.includes(text)) {
                    opt.click();
                    return 'includes';
                }
            }

            // Strategy 3: search option-label-content elements
            const labels = document.querySelectorAll('[class*="select-option-label-content"]');
            for (const lbl of labels) {
                const text = (lbl.innerText || '').trim();
                if (text === optionText || text.includes(optionText)) {
                    lbl.click();
                    return 'label';
                }
            }

            return null;
        }""", option_text)
        await asyncio.sleep(0.3)
        return bool(selected)
    except Exception as e:
        emit_progress("select", 0, f"选择下拉选项失败: {e}")
        return False


async def _get_current_select_value(page, select_index: int) -> str:
    """Read the current value of a toolbar select by index."""
    try:
        val = await page.evaluate(f"""() => {{
            const selects = document.querySelectorAll('{TOOLBAR_SELECT_SELECTOR}');
            if (selects.length <= {select_index}) return '';
            const v = selects[{select_index}].querySelector('.lv-select-view-value');
            return v ? (v.innerText || '').trim() : '';
        }}""")
        return val or ""
    except Exception:
        return ""


async def _ensure_video_mode(page):
    """Ensure we are on the video generation page (not image)."""
    try:
        # Check if already on video page
        url = page.url
        if "type=video" in url:
            return

        # Click "视频生成" in the type switcher (select index 0)
        current_type = await _get_current_select_value(page, SELECT_TYPE)
        if "视频" in current_type:
            return

        await _click_lv_select_option(page, SELECT_TYPE, "视频生成")
        await asyncio.sleep(1)
    except Exception:
        pass


async def _switch_reference_mode_v3(page, mode: str):
    """Switch reference mode using the mode dropdown (index 2).

    Mode options vary by model:
      Seedance 2.x: 全能参考, 首尾帧, 智能多帧
      Seedance 1.x: 文生视频, 图生视频, 首尾帧, 全能参考 (etc.)

    The mode label is looked up from MODE_LABEL_MAP. If the target mode
    is not available for the current model, we fall back to the closest match.
    """
    label = MODE_LABEL_MAP.get(mode, "")

    # If mode not in map, try direct match
    if not label:
        label = mode

    # Check current mode
    current = await _get_current_select_value(page, SELECT_MODE)
    if label in (current or ""):
        return  # Already on correct mode

    # Try to select the target mode
    ok = await _click_lv_select_option(page, SELECT_MODE, label)
    if ok:
        await asyncio.sleep(1)  # Wait for UI to update after mode switch
        new_val = await _get_current_select_value(page, SELECT_MODE)
        if label in new_val:
            return

    # Fallback: if target mode not found, try alternative mappings
    fallback_map = {
        "文生视频": ["全能参考"],      # Seedance 2.x doesn't have 文生视频 → use 全能参考
        "图生视频": ["全能参考"],      # Seedance 2.x doesn't have 图生视频 → use 全能参考
        "视频参考": ["全能参考", "智能多帧"],
        "智能多帧": ["首尾帧", "全能参考"],
        "全能参考": ["首尾帧"],
        "首尾帧": ["全能参考", "智能多帧"],
    }

    for fb in fallback_map.get(label, []):
        emit_progress("mode_switch", 15, f"模式'{label}'不可用，尝试回退'{fb}'...")
        ok = await _click_lv_select_option(page, SELECT_MODE, fb)
        if ok:
            await asyncio.sleep(1)
            new_val = await _get_current_select_value(page, SELECT_MODE)
            if fb in new_val:
                emit_progress("mode_switch", 16, f"已切换到回退模式: {fb}")
                return

    emit_progress("mode_switch", 15, f"模式切换可能失败，当前: {current}, 目标: {label}")


async def _select_model_v3(page, model: str):
    """Select model using the model dropdown (index 1).

    The model display names in jimeng's dropdown include brand prefix like
    "即梦 Seedance 2.0 Fast VIP". We match by substring.
    """
    target = MODEL_DISPLAY_MAP.get(model, model)

    # Check current model
    current = await _get_current_select_value(page, SELECT_MODEL)

    # Match by substring (model dropdown values include long names)
    # e.g. target="Seedance 2.0 Fast VIP" should match "即梦 Seedance 2.0 Fast VIP"
    if target in (current or ""):
        return  # Already selected

    await _click_lv_select_option(page, SELECT_MODEL, target)
    await asyncio.sleep(1)


async def _set_duration_v3(page, duration: str):
    """Set duration using the duration dropdown (index 3).

    Duration values: 4s, 5s, 6s, ... 15s
    """
    current = await _get_current_select_value(page, SELECT_DURATION)
    target = f"{duration}s"

    if target in (current or "") or current == duration:
        return  # Already set

    ok = await _click_lv_select_option(page, SELECT_DURATION, target)
    if not ok:
        # Try without 's' suffix
        await _click_lv_select_option(page, SELECT_DURATION, duration)
    await asyncio.sleep(0.5)


async def _set_aspect_ratio_v3(page, ratio: str):
    """Click the aspect ratio button in the toolbar to cycle or select ratio."""
    try:
        # The ratio is a button (not a dropdown), find and click it
        clicked = await page.evaluate(f"""(ratioText) => {{
            // Find the ratio button
            const btns = document.querySelectorAll('button');
            for (const btn of btns) {{
                const text = (btn.innerText || '').trim();
                if (text.match(/^\\d+:\\d+$/)) {{
                    if (text === ratioText) return true; // already correct
                    btn.click();
                    return 'clicked';
                }}
            }}
            return null;
        }}""", ratio)
        if clicked == 'clicked':
            await asyncio.sleep(0.5)
            # Select target ratio from popup
            await page.evaluate(f"""(ratioText) => {{
                const options = document.querySelectorAll(
                    '.lv-select-option, [class*="select-option-label-content"], '
                    + '[class*="dropdown"] div, [class*="popper"] div'
                );
                for (const opt of options) {{
                    const text = (opt.innerText || '').trim();
                    if (text === ratioText || text.startsWith(ratioText)) {{
                        opt.click();
                        return true;
                    }}
                }}
                return false;
            }}""", ratio)
            await asyncio.sleep(0.3)
    except Exception:
        pass


async def _upload_images_v3(page, mode: str, all_refs: list, first_frame: Optional[str], last_frame: Optional[str]):
    """Upload images based on the selected mode.

    For 全能参考: upload all ref images to the reference upload area
    For 首尾帧: two separate upload areas for first/last frame
    For 图生视频: single image upload
    For 文生视频: no image upload needed
    For 智能多帧: similar to 首尾帧
    """
    try:
        if mode in ("omni_reference", "fullReference"):
            # 全能参考: upload all ref images
            # Find file input in the reference-upload area
            file_inputs = await page.query_selector_all('.reference-upload-MpsT4v input[type="file"]')
            if not file_inputs:
                # Try clicking the upload area first to activate file input
                await page.evaluate("""() => {
                    const refUpload = document.querySelector('.reference-upload-MpsT4v');
                    if (refUpload) refUpload.click();
                }""")
                await asyncio.sleep(0.5)
                file_inputs = await page.query_selector_all('.reference-upload-MpsT4v input[type="file"]')

            if not file_inputs:
                # Broader search
                file_inputs = await page.query_selector_all('input[type="file"]')

            if file_inputs and all_refs:
                valid = [p for p in all_refs if os.path.exists(p)][:12]
                if valid:
                    await file_inputs[0].set_input_files(valid)
                    emit_progress("upload", 24, f"已上传{len(valid)}张参考图片")
                    await asyncio.sleep(1)

        elif mode in ("first_end_frame", "firstLastFrame", "smart_multiframe", "smartMultiframe"):
            # 首尾帧 / 智能多帧: need separate first/last frame upload
            # Click upload areas to expose file inputs
            await page.evaluate("""() => {
                const uploadAreas = document.querySelectorAll(
                    '[class*="upload"], [class*="drop"], [class*="drag"]'
                );
                for (const area of uploadAreas) {
                    const text = (area.innerText || '').trim();
                    if (text.includes('首帧') || text.includes('上传')) {
                        area.click();
                    }
                }
            }""")
            await asyncio.sleep(0.5)

            file_inputs = await page.query_selector_all('input[type="file"]')
            if file_inputs:
                if first_frame and os.path.exists(first_frame):
                    await file_inputs[0].set_input_files(first_frame)
                    emit_progress("upload", 24, "首帧图片已上传")
                    await asyncio.sleep(0.5)
                if last_frame and os.path.exists(last_frame) and len(file_inputs) > 1:
                    await file_inputs[1].set_input_files(last_frame)
                    emit_progress("upload", 24, "尾帧图片已上传")
                    await asyncio.sleep(0.5)

        elif mode == "image2video":
            # 图生视频: single image upload
            if all_refs:
                file_inputs = await page.query_selector_all('input[type="file"]')
                if file_inputs:
                    valid = [p for p in all_refs if os.path.exists(p)][:1]
                    if valid:
                        await file_inputs[0].set_input_files(valid[0])
                        emit_progress("upload", 24, "参考图已上传")
                        await asyncio.sleep(0.5)

        # text2video: no image upload needed

    except Exception as e:
        emit_progress("upload", 23, f"上传遇到问题: {e}")


async def _fill_prompt_v3(page, prompt: str):
    """Fill the prompt in the prompt editor area.

    The prompt area is a contenteditable div inside .prompt-editor-oJ_H28.
    It is NOT inside .reference-upload-MpsT4v (that's for image uploads).
    """
    try:
        # Find and click the contenteditable prompt area
        focused = await page.evaluate("""() => {
            // Primary: prompt-editor contenteditable
            const editor = document.querySelector('.prompt-editor-oJ_H28 [contenteditable="true"]');
            if (editor) {
                editor.focus();
                editor.click();
                // Clear existing text
                editor.innerText = '';
                return 'prompt-editor';
            }

            // Fallback: any contenteditable
            const anyEditable = document.querySelector('[contenteditable="true"]');
            if (anyEditable) {
                anyEditable.focus();
                anyEditable.click();
                anyEditable.innerText = '';
                return 'any-editable';
            }

            // Fallback: textarea
            const ta = document.querySelector('textarea, [role="textbox"]');
            if (ta) {
                ta.focus();
                ta.click();
                if (ta.value !== undefined) ta.value = '';
                return 'textarea';
            }

            return null;
        }""")

        if not focused:
            emit_progress("prompt", 25, "未找到输入框")
            return

        await asyncio.sleep(0.3)

        # Use JavaScript to set text directly — avoids keyboard type garbling Chinese characters
        # keyboard.type() relies on system input method state and can corrupt CJK text
        await page.evaluate("""(text) => {
            const editor = document.querySelector('.prompt-editor-oJ_H28 [contenteditable="true"]')
                || document.querySelector('[contenteditable="true"]');
            if (editor) {
                editor.focus();
                // Set text via innerText for contenteditable div
                editor.innerText = text;
                // Dispatch input event so React/ProseMirror picks up the change
                editor.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
            // Fallback: textarea or input
            const ta = document.querySelector('textarea, [role="textbox"], input[type="text"]');
            if (ta) {
                ta.focus();
                ta.value = text;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
            return false;
        }""", prompt)
        emit_progress("prompt", 28, "提示词已填写")

    except Exception as e:
        emit_progress("prompt", 25, f"填写提示词遇到问题: {e}")


async def _click_generate_v3(page) -> bool:
    """Click the generate/submit button.

    On the jimeng toolbar, the generate button is typically on the right side
    of the toolbar. It may show:
    - A token count (like "55")
    - Text "生成" or "创作"
    - Or be a primary button with an icon

    The button is DISABLED when not logged in, so we also check for that.
    """
    try:
        clicked = await page.evaluate("""() => {
            // Strategy 1: Find the rightmost button in the toolbar area
            // The generate button is a primary button after all the selects
            const toolbar = document.querySelector('[class*="toolbar"]');
            if (toolbar) {
                const btns = toolbar.querySelectorAll('button.lv-btn-primary, button[class*="primary"]');
                for (const btn of btns) {
                    const text = (btn.innerText || '').trim();
                    // Primary button with number (tokens) or text
                    if (text.match(/^\\d+$/) || text.includes('生成') || text.includes('创作') || text === '') {
                        btn.click();
                        return text || 'primary_btn';
                    }
                }
            }

            // Strategy 2: Find the last button in toolbar (rightmost = generate)
            if (toolbar) {
                const allBtns = toolbar.querySelectorAll('button');
                for (let i = allBtns.length - 1; i >= 0; i--) {
                    const btn = allBtns[i];
                    if (btn.className.includes('primary') || btn.className.includes('generate')) {
                        btn.click();
                        return 'toolbar_btn_' + i;
                    }
                }
            }

            // Strategy 3: Search entire page for generate button
            const allBtns = document.querySelectorAll('button');
            for (const btn of allBtns) {
                const text = (btn.innerText || '').trim();
                if (text.match(/^\\d+$/) || text === '生成' || text.includes('生成视频')) {
                    btn.click();
                    return text;
                }
            }

            return null;
        }""")

        if clicked:
            await asyncio.sleep(1)
            return True

        # Last resort: try pressing Enter
        await page.keyboard.press("Enter")
        await asyncio.sleep(0.5)
        return True

    except Exception as e:
        emit_progress("generate", 30, f"点击生成失败: {e}")
        return False

async def _scrape_page_progress(page) -> dict:
    """Scrape progress info from the page DOM."""
    try:
        result = await page.evaluate("""() => {
            const info = { percent: 0, status: '', video_url: null };

            // Look for progress indicators
            const progressEls = document.querySelectorAll('[class*="progress"], [class*="Progress"]');
            for (const el of progressEls) {
                const text = (el.innerText || '').trim();
                const match = text.match(/(\\d+)%/);
                if (match) {
                    info.percent = parseInt(match[1]);
                    info.status = text;
                    break;
                }
            }

            // Look for status text
            const statusEls = document.querySelectorAll('div, span');
            const statusTexts = ['生成中', '排队中', '生成完成', '已完成', '生成失败', '审核失败',
                                 '处理中', 'processing', 'completed', 'failed'];
            for (const el of statusEls) {
                const text = (el.innerText || '').trim();
                for (const st of statusTexts) {
                    if (text.includes(st) && text.length < 30) {
                        info.status = text;
                        break;
                    }
                }
            }

            // Look for video elements in completed cards
            const videos = document.querySelectorAll('video');
            for (const v of videos) {
                const src = v.src || v.querySelector('source')?.src;
                if (src && src.startsWith('http')) {
                    info.video_url = src;
                    break;
                }
            }

            // Look for download links
            if (!info.video_url) {
                const links = document.querySelectorAll('a[href*=".mp4"], a[href*="video"]');
                for (const a of links) {
                    const href = a.href;
                    if (href && href.startsWith('http') && (href.includes('.mp4') || href.includes('video'))) {
                        info.video_url = href;
                        break;
                    }
                }
            }

            return info;
        }""")
        return result or {}
    except Exception:
        return {}

async def _find_video_in_cards(page) -> Optional[str]:
    """Find video URL in completed generation cards."""
    try:
        result = await page.evaluate("""() => {
            // Deep search for video URLs
            const all = document.querySelectorAll('video, source, a, [src]');
            for (const el of all) {
                const url = el.src || el.href || el.getAttribute('src');
                if (url && url.startsWith('http') && (url.includes('.mp4') || url.includes('video') || url.includes('vlabstatic'))) {
                    return url;
                }
            }

            // Also check for background videos
            const cards = document.querySelectorAll('[class*="card"], [class*="result"], [class*="video"]');
            for (const card of cards) {
                const video = card.querySelector('video');
                if (video) {
                    const src = video.src || video.querySelector('source')?.src;
                    if (src && src.startsWith('http')) return src;
                }
            }
            return null;
        }""")
        return result
    except Exception:
        return None

async def _download_video(video_url: str, output_dir: str, submit_id: str) -> Optional[str]:
    """Download video from URL and save to output directory."""
    import urllib.request
    try:
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"jimeng_{submit_id[:8]}_{timestamp}.mp4"
        output_path = os.path.join(output_dir, filename)

        # Handle m3u8 vs mp4
        if ".m3u8" in video_url:
            # Try to find mp4 version by replacing m3u8 with mp4
            mp4_url = video_url.replace(".m3u8", ".mp4")
            try:
                urllib.request.urlretrieve(mp4_url, output_path)
                if os.path.getsize(output_path) > 1000:
                    return output_path
            except Exception:
                pass

            # Fallback: save m3u8 and try ffmpeg remux
            m3u8_path = output_path.replace(".mp4", ".m3u8")
            urllib.request.urlretrieve(video_url, m3u8_path)

            # Try ffmpeg remux
            ffmpeg = shutil.which("ffmpeg")
            if ffmpeg:
                subprocess.run([ffmpeg, "-y", "-i", m3u8_path, "-c", "copy", output_path],
                             capture_output=True, timeout=60)
                if os.path.exists(output_path) and os.path.getsize(output_path) > 1000:
                    os.remove(m3u8_path)
                    return output_path

            # Return m3u8 path as fallback
            return m3u8_path

        # Direct mp4 download
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://jimeng.jianying.com/",
        }
        req = urllib.request.Request(video_url, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp:
            with open(output_path, "wb") as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)

        if os.path.exists(output_path) and os.path.getsize(output_path) > 1000:
            return output_path
        return None
    except Exception as e:
        emit_progress("download", 90, f"下载视频出错: {e}")
        return None

# ── HTTP API Fallback (with retry) ────────────────────────────────────────

def cmd_generate_http(params: dict):
    """HTTP API mode with retry for 502/503 errors."""
    import urllib.request
    import urllib.error

    sessionid = params.get("sessionid", "")
    if not sessionid:
        emit_error("未设置sessionid，请先登录即梦账号")
        return

    prompt = params.get("prompt", "")
    model = params.get("model", "seedance-2.0")
    mode = params.get("mode", "first_end_frame")
    duration = params.get("duration", 5)
    aspect_ratio = params.get("aspect_ratio", "16:9")
    resolution = params.get("resolution", "720p")
    first_frame_path = params.get("first_frame_path")
    last_frame_path = params.get("last_frame_path")
    ref_image_paths = params.get("ref_image_paths", [])
    output_dir = params.get("output_dir", str(huahai_dir("output")))
    timeout = params.get("timeout", 900)
    max_retries = params.get("max_retries", 3)

    os.makedirs(output_dir, exist_ok=True)

    # Model name mapping
    model_map = {
        "seedance-2.0": "dreamina_seedance_40_pro",
        "seedance-2.0-fast": "dreamina_seedance_40_fast",
        "jimeng-video-3.5-pro": "dreamina_ic_generate_video_model_vgfm_3.5_pro",
        "jimeng-video-3.5": "dreamina_ic_generate_video_model_vgfm_3.5",
    }
    actual_model = model_map.get(model, model)

    # Build payload
    payload = _build_http_payload(actual_model, prompt, mode, duration, aspect_ratio, resolution)

    # Upload images if present
    # ... (image upload logic similar to existing jimeng.rs)

    # Submit with retry
    url = f"{JIMENG_BASE}{GENERATE_ENDPOINT}"
    headers = {
        "Cookie": f"sessionid={sessionid}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://jimeng.jianying.com/ai-tool/video/generate",
        "Origin": "https://jimeng.jianying.com",
    }

    submit_id = None
    for attempt in range(max_retries + 1):
        try:
            emit_progress("submit", 10 + attempt * 5, f"正在提交任务 (第{attempt + 1}次)...")
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            resp = urllib.request.urlopen(req, timeout=60)
            body = json.loads(resp.read())

            code = body.get("code", 0)
            if code == -1 or code == 1008:
                emit_error("登录已过期，请重新登录即梦账号")
                return

            submit_id = (body.get("data", {}).get("history_id")
                        or body.get("data", {}).get("id")
                        or body.get("data", {}).get("aigc_task_id"))
            if submit_id:
                submit_id = str(submit_id)
                break
        except urllib.error.HTTPError as e:
            if e.code in (502, 503, 504):
                wait = 2 ** attempt
                emit_progress("retry", 10, f"服务器返回{e.code}，{wait}秒后重试...")
                time.sleep(wait)
                continue
            elif e.code in (401, 403):
                emit_error("登录已过期，请重新登录即梦账号")
                return
            else:
                emit_error(f"API错误 ({e.code}): {e.read().decode('utf-8', errors='replace')[:200]}")
                return
        except Exception as e:
            emit_error(f"网络错误: {e}")
            return

    if not submit_id:
        emit_error("提交任务失败，未获取到任务ID")
        return

    emit_progress("submitted", 25, f"任务已提交，ID: {submit_id[:12]}...")

    # Poll for result with retry
    poll_url = f"{JIMENG_BASE}{HISTORY_ENDPOINT}"
    poll_headers = {
        "Cookie": f"sessionid={sessionid}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
    }

    start_time = time.time()
    while time.time() - start_time < timeout:
        time.sleep(POLL_INTERVAL)

        for attempt in range(max_retries + 1):
            try:
                poll_data = json.dumps({"data": {"history_ids": [submit_id]}}).encode("utf-8")
                req = urllib.request.Request(poll_url, data=poll_data, headers=poll_headers, method="POST")
                resp = urllib.request.urlopen(req, timeout=15)
                body = json.loads(resp.read())

                items = body.get("data", {}).get("list", [])
                if items:
                    item = items[0]
                    status_code = item.get("status", 0)

                    elapsed = int(time.time() - start_time)
                    if status_code in (20, 42, 45):
                        pct = min(int((time.time() - start_time) / timeout * 100), 95)
                        emit_progress("polling", 30 + pct // 3, f"生成中... 已等待{elapsed}秒")
                    elif status_code in (10, 50):
                        # Success - find video URL
                        video_url = None
                        # Look in video_url field
                        video_url = item.get("video_url") or item.get("major_video_url")
                        if not video_url:
                            # Check outputs
                            outputs = item.get("output_list", item.get("outputs", []))
                            for out in outputs:
                                vurl = out.get("video_url") or out.get("url")
                                if vurl:
                                    video_url = vurl
                                    break
                        if not video_url:
                            # Check origin_video_url
                            video_url = item.get("origin_video_url")

                        if video_url:
                            emit_progress("downloading", 90, "正在下载视频...")
                            output_path = _download_video_sync(video_url, output_dir, submit_id)
                            if output_path:
                                emit_result(output_path, video_url)
                            else:
                                emit_error("视频下载失败")
                        else:
                            emit_error("生成完成但未找到视频URL")
                        return
                    elif status_code == 30:
                        reason = item.get("fail_reason", "生成失败")
                        emit_error(f"视频生成失败: {reason}")
                        return

                break  # Poll succeeded, no need to retry this poll
            except urllib.error.HTTPError as e:
                if e.code in (502, 503, 504) and attempt < max_retries:
                    time.sleep(2)
                    continue
                break
            except Exception:
                break

    emit_error(f"等待视频生成超时 ({timeout}秒)")

def _build_http_payload(model, prompt, mode, duration, aspect_ratio, resolution) -> dict:
    """Build the HTTP API payload for jimeng generate endpoint."""
    # Determine generate_type based on mode
    if mode == "omni_reference":
        generate_type = 2
    elif mode == "first_end_frame":
        generate_type = 1 if duration <= 5 else 1
    else:
        generate_type = 0

    # Parse ratio
    ratio_parts = aspect_ratio.split(":")
    ratio_w = int(ratio_parts[0]) if len(ratio_parts) == 2 else 16
    ratio_h = int(ratio_parts[1]) if len(ratio_parts) == 2 else 9

    # Build draft
    draft = {
        "type": "video",
        "content": prompt,
        "model": model,
        "generate_type": generate_type,
        "duration": duration,
        "ratio": f"{ratio_w}:{ratio_h}",
        "resolution": resolution,
    }

    return {
        "draft_query": json.dumps(draft, ensure_ascii=False),
        "assistant_id": 513695,
        "platform_code": "7",
        "draft_version": "3.3.9",
        "draft_min_version": "3.0.2",
        "version_code": "8.4.0",
    }

def _download_video_sync(video_url: str, output_dir: str, submit_id: str) -> Optional[str]:
    """Synchronous video download."""
    import urllib.request
    try:
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"jimeng_{submit_id[:8]}_{timestamp}.mp4"
        output_path = os.path.join(output_dir, filename)

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://jimeng.jianying.com/",
        }
        req = urllib.request.Request(video_url, headers=headers)
        with urllib.request.urlopen(req, timeout=120) as resp:
            with open(output_path, "wb") as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)

        if os.path.exists(output_path) and os.path.getsize(output_path) > 1000:
            return output_path
    except Exception:
        pass
    return None

# ── Check Environment ──────────────────────────────────────────────────────

def cmd_check_env(params: dict):
    """Check if Playwright and browser are available."""
    result = {
        "playwright_installed": False,
        "browser_found": False,
        "browser_path": None,
    }

    # Check playwright
    try:
        import playwright
        result["playwright_installed"] = True
    except ImportError:
        pass

    # Check browser
    browser = find_browser_exe()
    if browser:
        result["browser_found"] = True
        result["browser_path"] = browser

    emit("env_check", result)

# ── Install Playwright ─────────────────────────────────────────────────────

def cmd_install_playwright(params: dict):
    """Install playwright. No need to download Chromium - we use system Edge/Chrome."""
    try:
        emit_progress("install", 5, "正在安装Playwright...")
        install_playwright_to_f_drive()

        emit_progress("install", 100, "Playwright安装完成（将使用系统Edge/Chrome浏览器）")
        emit("install_complete", {"success": True})
    except Exception as e:
        emit_error(f"Playwright安装失败: {e}")

# ── Main Entry Point ───────────────────────────────────────────────────────

def main():
    """Read command from stdin and execute."""
    # Force stdin/stdout to UTF-8 on Windows (default is GBK/CP936 which corrupts CJK text)
    if sys.platform == "win32":
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    # Read all stdin as JSON
    raw = sys.stdin.read()
    try:
        cmd = json.loads(raw)
    except json.JSONDecodeError as e:
        emit_error(f"无效的JSON输入: {e}")
        return

    action = cmd.get("action", "")
    params = cmd.get("params", {})

    if action == "open_login_browser":
        cmd_open_login_browser(params)
    elif action == "generate_browser":
        # Playwright browser automation
        asyncio.run(_generate_via_playwright(params))
    elif action == "generate_http":
        # HTTP API with retry
        cmd_generate_http(params)
    elif action == "check_env":
        cmd_check_env(params)
    elif action == "install_playwright":
        cmd_install_playwright(params)
    else:
        emit_error(f"未知操作: {action}")

if __name__ == "__main__":
    main()
