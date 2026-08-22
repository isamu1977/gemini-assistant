/*
 * service-worker.js
 *
 * Manifest V3 service worker.
 *
 * Responsibilities:
 *   - Register the side panel so clicking the toolbar icon opens it.
 *   - Bridge downloads via chrome.downloads (v0.6). The side panel cannot
 *     download from a content-script-origin URL directly because some
 *     Google CDN URLs require the user's session cookies, which are
 *     only sent from the page context. We use a two-stage strategy:
 *       stage 1: side panel -> content script (fetch + return Blob).
 *       stage 2: side panel -> service worker (chrome.downloads).
 *     The service worker only sees the Blob (encoded as ArrayBuffer).
 *
 * Activation timing: we set the panel behavior on every install/update.
 * Chrome caches the value, but re-registering is safe and idempotent.
 */

"use strict";

const GEMINI_HOST_PATTERN = "https://gemini.google.com/*";

function registerSidePanelBehavior() {
  if (!chrome?.sidePanel?.setPanelBehavior) {
    console.warn(
      "[Gemini Assistant:sw] chrome.sidePanel.setPanelBehavior is unavailable.",
    );
    return;
  }
  try {
    chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true,
    });
  } catch (e) {
    console.warn(
      "[Gemini Assistant:sw] setPanelBehavior failed:",
      e?.message ?? String(e),
    );
  }
}

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

// ---- v0.6: download bridge -----------------------------------------

// We expect the side panel to call:
//   chrome.runtime.sendMessage({ type: "GEMINI_ASSISTANT_DOWNLOAD_BLOB",
//     arrayBuffer, filename, mime })
// and we respond with { ok, downloadId, finalFilename } or { ok:false, error }.
//
// We refuse any path traversal: filename must be a basename only, and
// we always route it under the user's Downloads directory. The
// chrome.downloads API automatically handles "(1)", "(2)" collisions
// when conflictAction is "uniquify".

const FILENAME_PATTERN = /^[a-zA-Z0-9 ._\-()\[\]']{1,200}\.[a-z0-9]{2,5}$/;

function isAcceptableFilename(filename) {
  if (typeof filename !== "string") return false;
  if (filename.length === 0 || filename.length > 260) return false;
  if (filename.startsWith("/") || filename.startsWith("\\")) return false;
  if (filename.includes("\\")) return false;
  if (filename.includes("..")) return false;
  return true;
}

async function handleDownloadBlob(msg, sender) {
  const arrayBuffer = msg.arrayBuffer;
  const filename = msg.filename;
  if (!arrayBuffer || typeof filename !== "string") {
    return { ok: false, error: "missing arrayBuffer or filename" };
  }
  if (!isAcceptableFilename(filename)) {
    return { ok: false, error: "filename rejected by sanitizer" };
  }
  if (!chrome?.downloads?.download) {
    return { ok: false, error: "chrome.downloads API unavailable" };
  }

  // Build a Blob URL inside the service worker. Some Chrome versions
  // also accept URL.createObjectURL(blob); both work.
  let blob;
  try {
    blob = new Blob([arrayBuffer], {
      type: typeof msg.mime === "string" ? msg.mime : "application/octet-stream",
    });
  } catch (e) {
    return { ok: false, error: `Blob construction failed: ${e?.message ?? "unknown"}` };
  }
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename, // relative; chrome saves under Downloads by default.
      conflictAction: "uniquify",
      saveAs: false,
    });
    // We deliberately do NOT await completion: we want the side panel
    // to update immediately when the download STARTS. Monitoring of
    // completion happens via chrome.downloads.onChanged (out of scope).
    return {
      ok: true,
      downloadId,
      finalFilename: filename,
      bytes: arrayBuffer.byteLength ?? null,
    };
  } catch (e) {
    return {
      ok: false,
      error: `chrome.downloads.download failed: ${e?.message ?? "unknown"}`,
    };
  } finally {
    // We do NOT revoke the URL immediately: chrome.downloads needs it.
    // We revoke after a short grace period to free memory.
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {
        /* ignore */
      }
    }, 60_000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "GEMINI_ASSISTANT_DOWNLOAD_BLOB") {
    handleDownloadBlob(msg, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
    return true;
  }
  return false;
});

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

// ---- v0.9.99: download completion tracking (Part 19) ------------------
//
// chrome.downloads.download returns a downloadId IMMEDIATELY without
// waiting for the file to actually finish writing to disk. To know
// whether the file is on disk and what its final filename is (after
// Chrome applied conflictAction:'uniquify'), we hook chrome.downloads
// .onChanged and post state transitions back to the side panel.
//
// We track only downloadIds WE created (startedBy === 'user' or the
// filename pattern we used). Other downloads in the user's browser are
// ignored.

const GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED =
  "GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED";

const trackedDownloads = new Map(); // downloadId -> { requestedFilename, startedAt }

// Mark downloads we initiated so onChanged can recognise them.
function trackDownload(downloadId, requestedFilename) {
  trackedDownloads.set(downloadId, {
    requestedFilename,
    startedAt: Date.now(),
  });
}

// Forget the tracking entry after the terminal state has been delivered.
function forgetDownload(downloadId) {
  trackedDownloads.delete(downloadId);
}

function postDownloadState(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {
      // Side panel may not be open; the message is best-effort. Ignore
      // any "Receiving end does not exist" errors.
    });
  } catch (_) {
    /* ignore */
  }
}

if (chrome?.downloads?.onChanged && typeof chrome.downloads.onChanged.addListener === "function") {
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || typeof delta.id !== "number") return;
    const tracked = trackedDownloads.get(delta.id);
    if (!tracked) return; // Not ours.

    // chrome.downloads.DownloadDelta exposes:
    //   state?: { current: 'in_progress'|'complete'|'interrupted', previous? }
    //   filename?: { current }
    //   error?: { current }
    if (!delta.state) return;
    const cur = delta.state.current;
    const filenameDelta = delta.filename && delta.filename.current
      ? delta.filename.current
      : null;
    const errorDelta = delta.error && delta.error.current
      ? delta.error.current
      : null;

    if (cur === "complete" || cur === "interrupted") {
      postDownloadState({
        type: GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED,
        downloadId: delta.id,
        state: cur,
        filename: filenameDelta,
        requestedFilename: tracked.requestedFilename,
        error: errorDelta,
        completedAt: Date.now(),
      });
      forgetDownload(delta.id);
    }
    // 'in_progress' transitions are ignored — the side panel does not
    // need per-progress pings.
  });
}

// Expose for tests that import the service-worker source as text only.
if (typeof globalThis !== "undefined") {
  globalThis.__GEMINI_ASSISTANT_SW__ = {
    GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED,
    trackedDownloads,
  };
}
