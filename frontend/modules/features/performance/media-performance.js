import { toast } from "../../shared/tauri.js";

const MEDIA_SELECTOR = ".react-flow img, .xyflow img, .react-flow video, .xyflow video";
const LARGE_CANVAS_WARNING = 500;
const MAX_ACTIVE_VIDEOS = 4;

export function installMediaPerformance() {
  const observed = new WeakSet();
  const activeVideos = new Map();
  let warned = false;
  let lastVideoLimitNotice = 0;
  let mediaCount = 0;
  let videoCount = 0;

  const onLargeCanvas = (event) => {
    const { count = 0, videos = 0 } = event.detail || {};
    toast(`当前画布有 ${count} 个媒体节点（含 ${videos} 个视频）。已启用懒加载与离屏暂停；建议关闭不需要的预览。`, "info");
  };
  const onVideoLimit = () => {
    const now = Date.now();
    if (now - lastVideoLimitNotice < 8000) return;
    lastVideoLimitNotice = now;
    toast(`为避免卡顿，同时播放的视频已限制为 ${MAX_ACTIVE_VIDEOS} 个。`, "info");
  };
  window.addEventListener("huahai:media-load", onLargeCanvas);
  window.addEventListener("huahai:media-limit", onVideoLimit);

  const pauseOldestVideo = () => {
    while (activeVideos.size > MAX_ACTIVE_VIDEOS) {
      const oldest = [...activeVideos.entries()].sort((left, right) => left[1] - right[1])[0]?.[0];
      if (!oldest) return;
      activeVideos.delete(oldest);
      oldest.pause();
      window.dispatchEvent(new CustomEvent("huahai:media-limit", { detail: { limit: MAX_ACTIVE_VIDEOS } }));
    }
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const media = entry.target;
      if (!(media instanceof HTMLVideoElement)) continue;
      if (!entry.isIntersecting && !media.paused) {
        activeVideos.delete(media);
        media.pause();
      }
      // Do not autoplay when a video returns to view: this respects a user pause.
    }
  }, { rootMargin: "180px" });

  const prepare = (media) => {
    if (observed.has(media)) return;
    observed.add(media);
    mediaCount += 1;
    if (media instanceof HTMLVideoElement) videoCount += 1;
    media.classList.add("huahai-media-optimized");
    if (media instanceof HTMLImageElement) {
      media.loading = "lazy";
      media.decoding = "async";
      if ("fetchPriority" in media) media.fetchPriority = "low";
    }
    if (media instanceof HTMLVideoElement) {
      media.preload = "metadata";
      media.playsInline = true;
      media.addEventListener("play", () => {
        activeVideos.set(media, Date.now());
        pauseOldestVideo();
      });
      media.addEventListener("pause", () => activeVideos.delete(media));
      media.addEventListener("ended", () => activeVideos.delete(media));
      observer.observe(media);
    }
  };
  const reportLargeCanvas = () => {
    if (warned || (mediaCount < LARGE_CANVAS_WARNING && videoCount < 50)) return;
    warned = true;
    window.dispatchEvent(new CustomEvent("huahai:media-load", {
      detail: { count: mediaCount, videos: videoCount, recommendation: "媒体较多：仅可见图片会延迟解码，最多同时播放 4 个视频。" },
    }));
  };
  const scan = (media = document.querySelectorAll(MEDIA_SELECTOR)) => {
    media.forEach(prepare);
    reportLargeCanvas();
  };
  const mediaInAddedNodes = (nodes) => {
    const media = [];
    nodes.forEach((node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(MEDIA_SELECTOR)) media.push(node);
      media.push(...node.querySelectorAll(MEDIA_SELECTOR));
    });
    return media;
  };

  // The first pass sees the already-mounted legacy canvas.  Afterwards, inspect
  // only newly inserted media; a legacy React state update must not rescan 500+
  // thumbnails on every animation frame.
  let frame = 0;
  let pendingMedia = new Set();
  const schedule = (nodes) => {
    mediaInAddedNodes(nodes).forEach((media) => pendingMedia.add(media));
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const additions = pendingMedia;
      pendingMedia = new Set();
      if (additions.size) scan(additions);
    });
  };
  const mutationObserver = new MutationObserver((records) => {
    schedule(records.flatMap((record) => [...record.addedNodes]));
  });
  mutationObserver.observe(document.getElementById("root") || document.body, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => {
    activeVideos.clear();
    observer.disconnect();
    mutationObserver.disconnect();
    window.removeEventListener("huahai:media-load", onLargeCanvas);
    window.removeEventListener("huahai:media-limit", onVideoLimit);
  });
  scan();
}
