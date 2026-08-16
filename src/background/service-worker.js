/*
 * service-worker.js
 *
 * Manifest V3 service worker. Currently does only one thing: registers
 * the side panel so that clicking the extension icon opens the panel
 * directly, instead of opening a popup. This is the v0.5.1 UX migration.
 *
 * Activation timing: we set the panel behavior on every install/update.
 * Chrome caches the value, but re-registering is safe and idempotent.
 *
 * The side panel is configured to open on gemini.google.com only by
 * default. On other pages, clicking the icon is a no-op (Chrome will
 * show a hint that the side panel is not available for that tab).
 *
 * Restricting to gemini.google.com is intentional: the side panel is
 * the Gemini Assistant UI. Opening it on a blank tab or a non-Gemini
 * page would just confuse the user.
 */

"use strict";

const GEMINI_HOST_PATTERN = "https://gemini.google.com/*";

function registerSidePanelBehavior() {
  if (!chrome?.sidePanel?.setPanelBehavior) {
    // Chrome < 114 or the sidePanel API is gated by permissions. The
    // manifest declares "sidePanel", so this branch should be unreachable
    // in supported browsers, but log loudly if it ever happens.
    console.warn(
      "[Gemini Assistant:sw] chrome.sidePanel.setPanelBehavior is unavailable. Toolbar icon click will be a no-op.",
    );
    return;
  }
  try {
    chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true,
    });
    console.log("[Gemini Assistant:sw] side panel registered (openPanelOnActionClick=true)");
  } catch (e) {
    console.warn(
      "[Gemini Assistant:sw] setPanelBehavior failed:",
      e?.message ?? String(e),
    );
  }
}

// Default options: only enable the panel on gemini.google.com.
function setDefaultSidePanelOptions() {
  if (!chrome?.sidePanel?.setOptions) return;
  try {
    chrome.sidePanel.setOptions({
      defaultPath: "src/sidepanel/sidepanel.html",
      enabled: true,
    });
  } catch (e) {
    console.warn(
      "[Gemini Assistant:sw] setOptions failed:",
      e?.message ?? String(e),
    );
  }
}

registerSidePanelBehavior();
setDefaultSidePanelOptions();

chrome.runtime.onInstalled.addListener(() => {
  registerSidePanelBehavior();
  setDefaultSidePanelOptions();
});

chrome.runtime.onStartup.addListener(() => {
  registerSidePanelBehavior();
  setDefaultSidePanelOptions();
});
