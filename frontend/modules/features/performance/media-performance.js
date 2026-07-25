const MEDIA_SELECTOR = ".react-flow img, .xyflow img, .react-flow video, .xyflow video";
const LARGE_CANVAS_WARNING = 120;

export function installMediaPerformance() {
  const observed = new WeakSet();
  const videoState = new WeakMap();
  let warned = false;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const media = entry.target;
      if (!(media instanceof HTMLVideoElement)) continue;
      if (!entry.isIntersecting && !media.paused) {
        videoState.set(media, true);
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
      observer.observe(media);
    }
  };
  const scan = () => {
    const media = [...document.querySelectorAll(MEDIA_SELECTOR)];
    media.forEach(prepare);
    if (!warned && media.length >= LARGE_CANVAS_WARNING) {
      warned = true;
      window.dispatchEvent(new CustomEvent("huahai:media-load", { detail: { count: media.length } }));
    }
  };
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; scan(); }); };
  const mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(document.getElementById("root") || document.body, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => { observer.disconnect(); mutationObserver.disconnect(); });
  scan();
}
