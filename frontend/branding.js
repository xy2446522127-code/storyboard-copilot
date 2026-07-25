(() => {
  const oldName = '知瑶画布';
  const newName = '花海画布';
  const attributes = ['alt', 'title', 'aria-label'];

  const replace = (value) => typeof value === 'string' ? value.replaceAll(oldName, newName) : value;

  const translate = (root = document) => {
    if (document.title.includes(oldName)) document.title = replace(document.title);
    if (root.nodeType === Node.TEXT_NODE) {
      const translated = replace(root.nodeValue);
      if (translated !== root.nodeValue) root.nodeValue = translated;
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const translated = replace(node.nodeValue);
      if (translated !== node.nodeValue) node.nodeValue = translated;
    }
    if (root.querySelectorAll) {
      for (const element of root.querySelectorAll('[alt],[title],[aria-label]')) {
        for (const attribute of attributes) {
          const value = element.getAttribute(attribute);
          const translated = replace(value);
          if (translated !== value) element.setAttribute(attribute, translated);
        }
      }
    }
  };

  const start = () => {
    translate();
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') translate(record.target.parentNode || document);
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) translate(node);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
