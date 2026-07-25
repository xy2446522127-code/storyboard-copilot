(() => {
  const replacements = [
    ["知瑶画布", "花海画布"],
    ["鐭ョ懚鐢诲竷", "花海画布"],
    ["知瑶", "花海"],
    ["zhiyao", "huahai"],
  ];
  const attributes = ["alt", "title", "aria-label", "placeholder"];
  const imageSelector = 'img[src="/zy-logo.jpg"], img[src$="/zy-logo.jpg"]';

  const replace = (value) => {
    if (typeof value !== "string") return value;
    return replacements.reduce((text, [from, to]) => text.replaceAll(from, to), value);
  };
  const translate = (root = document) => {
    const title = replace(document.title);
    if (title !== document.title) document.title = title;
    if (root.nodeType === Node.TEXT_NODE) {
      const next = replace(root.nodeValue);
      if (next !== root.nodeValue) root.nodeValue = next;
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const next = replace(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    });
    root.querySelectorAll?.("[alt],[title],[aria-label],[placeholder]").forEach((element) => {
      attributes.forEach((attribute) => {
        const current = element.getAttribute(attribute);
        const next = replace(current);
        if (next !== current) element.setAttribute(attribute, next);
      });
    });
    root.querySelectorAll?.(imageSelector).forEach((image) => {
      image.src = "/huahai-canvas.png";
      image.alt = "花海画布";
    });
  };
  const start = () => {
    translate();
    new MutationObserver((records) => records.forEach((record) => {
      if (record.type === "characterData") translate(record.target.parentNode || document);
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) translate(node);
      });
    })).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();
