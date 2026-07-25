const replacements = [
  ["知瑶画布", "花海画布"],
  ["鐭ョ懚鐢诲竷", "花海画布"],
  ["知瑶", "花海"],
  ["zhiyao", "huahai"],
];
const imageSelector = 'img[src="/zy-logo.jpg"], img[src$="/zy-logo.jpg"]';

function replaceText(value) {
  if (typeof value !== "string") return value;
  return replacements.reduce((text, [from, to]) => text.replaceAll(from, to), value);
}

function applyBranding(root = document) {
  const nextTitle = replaceText(document.title) || "花海画布";
  if (document.title !== nextTitle) document.title = nextTitle;
  if (root.nodeType === Node.TEXT_NODE) {
    const next = replaceText(root.nodeValue);
    if (next !== root.nodeValue) root.nodeValue = next;
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  textNodes.forEach((node) => {
    const next = replaceText(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  });
  root.querySelectorAll?.("[alt],[title],[aria-label],[placeholder]").forEach((element) => {
    ["alt", "title", "aria-label", "placeholder"].forEach((attribute) => {
      const value = element.getAttribute(attribute);
      const next = replaceText(value);
      if (next !== value) element.setAttribute(attribute, next);
    });
  });
  root.querySelectorAll?.(imageSelector).forEach((image) => {
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
