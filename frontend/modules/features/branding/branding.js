export function installBranding() {
  // Do not mutate the legacy root.  Its text, attributes and node structure are
  // owned by the recovered application and must remain stable for drag/drop.
  document.title = "花海画布";
  document.documentElement.dataset.huahaiBrand = "true";
}
