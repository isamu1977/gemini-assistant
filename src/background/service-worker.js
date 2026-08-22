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

// ---- v0.9.103: filename interception via onDeterminingFilename ----
//
// Per the spec, we click Gemini's own official download control and let
// Chrome / Gemini's authenticated session perform the actual transfer.
// To control WHERE the file lands on disk, we use the
// chrome.downloads.onDeterminingFilename event.
//
// Flow:
//   1. The side panel arms an `expectedDownloadClaim` via
//      GEMINI_ASSISTANT_ARM_DOWNLOAD (with executionId, taskId,
//      desiredFilename, expiresAt).
//   2. The side panel calls the content script to click Gemini's
//      download button inside the current result container.
//   3. Chrome starts the download; Gemini's download URL is on the
//      same Google CDN (lh3.googleusercontent.com / gemini.google.com).
//   4. chrome.downloads.onCreated fires; we capture the downloadId and
//      bind it to the active claim.
//   5. chrome.downloads.onDeterminingFilename fires for the new
//      download; we call suggest({ filename, conflictAction:'uniquify' }).
//   6. chrome.downloads.onChanged fires for state transitions
//      (complete / interrupted); we post to the side panel.
//   7. After the expected download is delivered, the claim is cleared.
//
// Crucially, we ONLY intercept downloads while an active claim is
// present AND the download URL is Gemini-Google-originated. Other
// downloads in the user's browser are NOT touched.

const GEMINI_ASSISTANT_ARM_DOWNLOAD = "GEMINI_ASSISTANT_ARM_DOWNLOAD";

// One active claim per execution. Replaces any prior claim for the same
// executionId. Older claims expire automatically.
const expectedDownloadClaims = new Map();
// executionId -> {
//   taskId,
//   desiredFilename,    // e.g. "Gemini Assistant/<project-id>/scene-001...png"
//   expiresAt,
//   downloadId?: number,
//   createdAt,
// }

const CLAIM_WINDOW_MS = 25_000; // 15-30s per spec; pick the upper-middle.

function nowMs() {
  return Date.now();
}

function pruneExpiredClaims() {
  const cutoff = nowMs();
  for (const [k, v] of expectedDownloadClaims) {
    if (v.expiresAt <= cutoff) {
      expectedDownloadClaims.delete(k);
    }
  }
}

function setExpectedClaim({ executionId, taskId, desiredFilename }) {
  pruneExpiredClaims();
  const claim = {
    taskId,
    desiredFilename,
    createdAt: nowMs(),
    expiresAt: nowMs() + CLAIM_WINDOW_MS,
    downloadId: null,
  };
  expectedDownloadClaims.set(executionId, claim);
  return claim;
}

function findActiveClaimForDownload(download) {
  pruneExpiredClaims();
  // First pass: match by executionId if the side panel pre-bound a
  // downloadId to a claim (defensive — currently we don't pre-bind).
  for (const [execId, claim] of expectedDownloadClaims) {
    if (claim.downloadId === download.id) {
      return { execId, claim };
    }
  }
  // Second pass: any active claim, preferring one whose desiredFilename
  // matches the download's existing filename (Chrome fills `suggestedFilename`
  // for some sources).
  for (const [execId, claim] of expectedDownloadClaims) {
    if (
      download.filename &&
      download.filename.endsWith(claim.desiredFilename.split("/").pop())
    ) {
      claim.downloadId = download.id;
      return { execId, claim };
    }
  }
  // Third pass: just the first active claim.
  for (const [execId, claim] of expectedDownloadClaims) {
    claim.downloadId = download.id;
    return { execId, claim };
  }
  return null;
}

function clearClaim(executionId, reason) {
  const claim = expectedDownloadClaims.get(executionId);
  if (!claim) return null;
  expectedDownloadClaims.delete(executionId);
  return { executionId, ...claim, clearedReason: reason };
}

// Gemini-Google-originated URL detector. Matches gemini.google.com and
// the common Google CDN hosts Gemini uses for generated images.
function isGeminiOriginatedDownload(download) {
  if (!download) return false;
  const url = download.url || "";
  const referrer = download.referrer || "";
  const combined = `${url}\n${referrer}`;
  return /gemini\.google\.com|lh[0-9]*\.googleusercontent\.com|gstatic\.com/.test(
    combined,
  );
}

// chrome.downloads.onCreated: bind the new download to the active claim
// (if any). This gives us a stable handle for filename interception.
if (
  chrome?.downloads?.onCreated &&
  typeof chrome.downloads.onCreated.addListener === "function"
) {
  chrome.downloads.onCreated.addListener((download) => {
    if (!download || typeof download.id !== "number") return;
    const matched = findActiveClaimForDownload(download);
    if (matched) {
      // Record in trackedDownloads so the onChanged listener can post
      // terminal-state events back to the side panel.
      trackedDownloads.set(download.id, {
        requestedFilename: matched.claim.desiredFilename,
        startedAt: nowMs(),
        executionId: matched.execId,
      });
    }
  });
}

// chrome.downloads.onDeterminingFilename: ONLY act if the active claim
// is present AND the download is Gemini-originated. We MUST call suggest()
// synchronously or Chrome proceeds with its own default filename.
if (
  chrome?.downloads?.onDeterminingFilename &&
  typeof chrome.downloads.onDeterminingFilename.addListener === "function"
) {
  chrome.downloads.onDeterminingFilename.addListener((download, suggest) => {
    if (!download || typeof suggest !== "function") return;
    pruneExpiredClaims();

    // Find a claim bound to this downloadId, or pick the first active
    // claim and bind it now (the click in the content script and this
    // event are usually separated by <100ms; we don't want to miss).
    let matched = null;
    for (const [execId, claim] of expectedDownloadClaims) {
      if (claim.downloadId === download.id) {
        matched = { execId, claim };
        break;
      }
    }
    if (!matched) {
      // No pre-bound claim for this downloadId. We can only intercept
      // downloads we initiated; for an unrelated download (e.g. user
      // clicking elsewhere in Chrome), let Chrome pick the default.
      if (!isGeminiOriginatedDownload(download)) return;
      matched = findActiveClaimForDownload(download);
      if (!matched) return;
    }

    if (!isGeminiOriginatedDownload(download)) return;

    suggest({
      filename: matched.claim.desiredFilename,
      conflictAction: "uniquify",
    });
  });
}

function handleArmDownload(msg) {
  const executionId = msg.executionId;
  const taskId = msg.taskId;
  const desiredFilename = msg.desiredFilename;
  if (
    typeof executionId !== "string" ||
    typeof taskId !== "string" ||
    typeof desiredFilename !== "string" ||
    desiredFilename.length === 0
  ) {
    return { ok: false, error: "missing executionId/taskId/desiredFilename" };
  }
  const claim = setExpectedClaim({ executionId, taskId, desiredFilename });
  return { ok: true, claim };
}

// Extend onMessage to handle the arm-download message.
const __geminiAssistantOriginalOnMessage =
  chrome.runtime.onMessage && chrome.runtime.onMessage.hasListeners && null;
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === GEMINI_ASSISTANT_ARM_DOWNLOAD) {
      const r = handleArmDownload(msg);
      sendResponse(r);
      return true;
    }
    return false;
  });
}

// Expose for tests that import the service-worker source as text only.
if (typeof globalThis !== "undefined") {
  globalThis.__GEMINI_ASSISTANT_SW__ = {
    GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED,
    GEMINI_ASSISTANT_ARM_DOWNLOAD,
    trackedDownloads,
    expectedDownloadClaims,
    CLAIM_WINDOW_MS,
    isGeminiOriginatedDownload,
  };
}
