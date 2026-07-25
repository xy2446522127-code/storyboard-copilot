const oldNames = ["知瑶画布", "鐭ョ懚鐢诲竷"];
const imageSelector = 'img[src="/zy-logo.jpg"], img[src$="/zy-logo.jpg"]';

function replaceText(value) {
  if (typeof value !== "string") return value;
  return oldNames.reduce((text, oldName) => text.replaceAll(oldName, "花海画布"), value);
}

function applyBranding(root = document) {
  // Assigning document.title creates a text mutation in <title>.  This function is also
  // called by the page-wide MutationObserver, so an unconditional assignment would keep
  // scheduling itself forever and prevent WebView from painting the application.
  if (document.title !== "花海画布") document.title = "花海画布";
  if (root.nodeType === Node.TEXT_NODE) {
    root.nodeValue = replaceText(root.nodeValue);
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  textNodes.forEach((node) => { node.nodeValue = replaceText(node.nodeValue); });
  if (!root.querySelectorAll) return;
  root.querySelectorAll("[alt],[title],[aria-label]").forEach((element) => {
    ["alt", "title", "aria-label"].forEach((attribute) => {
      const value = element.getAttribute(attribute);
      const next = replaceText(value);
      if (next !== value) element.setAttribute(attribute, next);
    });
  });
  root.querySelectorAll(imageSelector).forEach((image) => {
    image.src = "/huahai-canvas.png";
    image.alt = "花海画布";
    image.classList.add("huahai-brand-icon");
  });
}

export function installBranding() {
  applyBranding();
  new MutationObserver((records) => records.forEach((record) => {
    if (record.type === "characterData") applyBranding(record.target.parentNode || document);
    record.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) applyBranding(node);
    });
  })).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}
