(() => {
  // The recovered legacy bundle contains a retired provider default. New 花海画布
  // installations must never contact it. Users can still configure any supported
  // OpenAI-compatible provider explicitly in API settings.
  const retiredHost = ["zhi", "yaoai", ".cc"].join("");
  const isRetired = (input) => {
    try {
      const url = new URL(typeof input === "string" ? input : input?.url, location.href);
      return url.hostname.toLowerCase() === retiredHost;
    } catch { return false; }
  };
  const rejected = () => Promise.reject(new Error("The retired provider is disabled. Configure a Huahai-compatible provider in API settings."));
  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) window.fetch = (input, init) => isRetired(input) ? rejected() : originalFetch(input, init);
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isRetired(url)) throw new Error("The retired provider is disabled.");
    return originalOpen.call(this, method, url, ...rest);
  };
})();
