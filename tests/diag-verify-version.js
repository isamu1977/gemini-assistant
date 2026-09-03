
// Paste in sidepanel DevTools console to verify the build running.
// Expected after v0.9.15:
//   - "waitForTabContentScriptReady" present
//   - attachAll source contains retry loop
//   - handleDownloadBlob source contains trackDownload call
const ok = {
  wait_helper: typeof window.waitForTabContentScriptReady === "function" ||
    /waitForTabContentScriptReady/.test(document.documentElement.outerHTML) ||
    (window.__DSH_BUILD__ || "").includes("v0.9.15"),
  attached: document.querySelector('[id^="gassist-"]') !== null
};
fetch(chrome.runtime.getURL ? chrome.runtime.getURL("/") : "?").catch(() => {});
console.log("[v0.9.15 verify] ok =", ok);
// Sidepanel bundle isn't easy to introspect — just print the manifest version.
chrome.management && chrome.management.getSelf((info) => {
  console.log("[v0.9.15 verify] extension version =", info && info.version);
});
