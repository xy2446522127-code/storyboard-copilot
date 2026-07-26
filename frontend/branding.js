(() => {
  // The recovered React application owns its DOM.  Branding must never watch or
  // rewrite it at runtime: doing so can invalidate React event targets on canvas nodes.
  const applyDocumentBranding = () => {
    document.title = "花海画布";
    document.documentElement.dataset.huahaiBrand = "true";
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyDocumentBranding, { once: true });
  } else {
    applyDocumentBranding();
  }
})();
