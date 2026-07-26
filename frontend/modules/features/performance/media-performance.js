const MEDIA_SELECTOR = ".react-flow img, .xyflow img, .react-flow video, .xyflow video";
const LARGE_CANVAS_WARNING = 500;
const MAX_ACTIVE_VIDEOS = 4;

export function installMediaPerformance() {
  const observed = new WeakSet();
  const activeVideos = new Map();
  let warned = false;
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
      // Deliberately do not autoplay again: resuming a user-paused video is surprising.
    }
  }, { rootMargin: "180px" });

  const prepare = (media) => {
    if (observed.has(media)) return;
    observed.add(media);
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
  const scan = () => {
    const media = [...document.querySelectorAll(MEDIA_SELECTOR)];
    media.forEach(prepare);
    const videos = media.filter((item) => item instanceof HTMLVideoElement).length;
    if (!warned && (media.length >= LARGE_CANVAS_WARNING || videos >= 50)) {
      warned = true;
      window.dispatchEvent(new CustomEvent("huahai:media-load", { detail: { count: media.length, videos, recommendation: "媒体较多：仅可见图片会延迟解码，最多同时播放 4 个视频。" } }));
    }
  };
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; scan(); }); };
  const mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(document.getElementById("root") || document.body, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => { activeVideos.clear(); observer.disconnect(); mutationObserver.disconnect(); });
  scan();
}
