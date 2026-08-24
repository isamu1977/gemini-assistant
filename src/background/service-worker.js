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
 *   - Download claim interception via chrome.downloads.onDeterminingFilename (v0.9.103)
 *   - Download state change tracking via chrome.downloads.onChanged (v0.9.99)
 *
 * Activation timing: we set the panel behavior on every install/update.
 * Chrome caches the value, but re-registering is safe and idempotent.
 */

"use strict";

const GEMINI_HOST_PATTERN = "https://gemini.google.com/*";
const FILENAME_PATTERN = /^[a-zA-Z0-9 ._\-()\[\]']{1,200}\.[a-z0-9]{2,5}$/;

const GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED =
  "GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED";
const GEMINI_ASSISTANT_ARM_DOWNLOAD = "GEMINI_ASSISTANT_ARM_DOWNLOAD";
const GEMINI_ASSISTANT_GET_DOWNLOAD_TRACE = "GEMINI_ASSISTANT_GET_DOWNLOAD_TRACE";
const GEMINI_ASSISTANT_DOWNLOAD_TRACE_RESPONSE =
  "GEMINI_ASSISTANT_DOWNLOAD_TRACE_RESPONSE";
const GEMINI_ASSISTANT_DOWNLOAD_PROBE = "GEMINI_ASSISTANT_DOWNLOAD_PROBE";

const CLAIM_WINDOW_MS = 25_000; // 15-30s per spec; pick the upper-middle.

// Declare all state and diagnostic counters at top-level before any listeners
// to avoid Temporal Dead Zone (TDZ) ReferenceErrors on service worker startup.
let downloadsOnCreatedRegistrationCount = 0;
let downloadsOnChangedRegistrationCount = 0;
let downloadsOnDeterminingFilenameRegistrationCount = 0;

let serviceWorkerRuntimeId = 0;
try {
  serviceWorkerRuntimeId = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : "sw-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
} catch (_) {
  serviceWorkerRuntimeId = "sw-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

const expectedDownloadClaims = new Map();
const trackedDownloads = new Map(); // downloadId -> { requestedFilename, startedAt, executionId, taskId }
const downloadTrace = []; // SW-side mirror of the download trace
const downloadHistory = []; // [{ executionId, taskId, downloadId, filename, requestedFilename, finalState, completedAt }]

function nowMs() {
  return Date.now();
}

function appendDownloadTrace(step, data = {}) {
  const entry = {
    step,
    timestamp: new Date().toISOString(),
    ...data,
  };
  downloadTrace.push(entry);
  if (downloadTrace.length > 200) {
    downloadTrace.splice(0, downloadTrace.length - 200);
  }
  try {
    console.log(`[Gemini Assistant:sw download-trace] ${step}`, entry);
  } catch (_) {
    /* ignore */
  }
}

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
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
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
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {
        /* ignore */
      }
    }, 60_000);
  }
}

// Mark downloads we initiated so onChanged can recognise them.
function trackDownload(downloadId, requestedFilename, executionId, taskId) {
  trackedDownloads.set(downloadId, {
    requestedFilename,
    startedAt: Date.now(),
    executionId: executionId || null,
    taskId: taskId || null,
  });
}

function forgetDownload(downloadId) {
  trackedDownloads.delete(downloadId);
}

function postDownloadState(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {
      // Side panel may not be open; ignore receiving end does not exist errors.
    });
  } catch (_) {
    /* ignore */
  }
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
  // First pass: match by executionId if the side panel pre-bound a downloadId.
  for (const [execId, claim] of expectedDownloadClaims) {
    if (claim.downloadId === download.id) {
      return { execId, claim };
    }
  }
  // Second pass: match by filename if desiredFilename ends with same filename.
  for (const [execId, claim] of expectedDownloadClaims) {
    if (
      download.filename &&
      download.filename.endsWith(claim.desiredFilename.split("/").pop())
    ) {
      claim.downloadId = download.id;
      return { execId, claim };
    }
  }
  // Third pass: first active claim.
  for (const [execId, claim] of expectedDownloadClaims) {
    claim.downloadId = download.id;
    return { execId, claim };
  }
  return null;
}

function isGeminiOriginatedDownload(download) {
  if (!download) return false;
  const url = download.url || "";
  const referrer = download.referrer || "";
  const combined = `${url}\n${referrer}`;
  return /gemini\.google\.com|lh[0-9]*\.googleusercontent\.com|gstatic\.com/.test(
    combined,
  );
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
    appendDownloadTrace("service-worker-download-claim-received", {
      result: "rejected",
      reason: "missing-params",
      executionId: executionId || null,
      taskId: taskId || null,
    });
    return { ok: false, error: "missing executionId/taskId/desiredFilename" };
  }
  const claim = setExpectedClaim({ executionId, taskId, desiredFilename });
  appendDownloadTrace("service-worker-download-claim-received", {
    result: "accepted",
    executionId,
    taskId,
    desiredFilename,
    activeClaimCount: expectedDownloadClaims.size,
  });
  return { ok: true, claim };
}

// Register listeners
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

// chrome.downloads.onCreated: D8 & D9
if (
  chrome?.downloads?.onCreated &&
  typeof chrome.downloads.onCreated.addListener === "function"
) {
  downloadsOnCreatedRegistrationCount++;
  chrome.downloads.onCreated.addListener((download) => {
    if (!download || typeof download.id !== "number") return;
    const matched = findActiveClaimForDownload(download);
    if (matched) {
      trackedDownloads.set(download.id, {
        requestedFilename: matched.claim.desiredFilename,
        startedAt: nowMs(),
        executionId: matched.execId,
        taskId: matched.claim.taskId || null,
      });
      appendDownloadTrace("chrome.downloads.onCreated-fired", {
        downloadId: download.id,
        executionId: matched.execId,
        taskId: matched.claim.taskId || null,
        url: (download.url || "").slice(0, 256),
        suggestedFilename: download.filename || null,
        matched: true,
      });
      appendDownloadTrace("chrome-download-matched-to-claim", {
        downloadId: download.id,
        executionId: matched.execId,
        taskId: matched.claim.taskId || null,
        desiredFilename: matched.claim.desiredFilename,
      });
      // Inform the side panel right away that a downloadId has been acquired
      postDownloadState({
        type: GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED,
        downloadId: download.id,
        state: "in_progress",
        filename: download.filename || matched.claim.desiredFilename,
        requestedFilename: matched.claim.desiredFilename,
        executionId: matched.execId,
        taskId: matched.claim.taskId || null,
      });
    } else {
      appendDownloadTrace("chrome.downloads.onCreated-fired", {
        downloadId: download.id,
        executionId: null,
        taskId: null,
        url: (download.url || "").slice(0, 256),
        suggestedFilename: download.filename || null,
        matched: false,
        note: "no-active-claim",
      });
    }
  });
}

// chrome.downloads.onDeterminingFilename: D10
if (
  chrome?.downloads?.onDeterminingFilename &&
  typeof chrome.downloads.onDeterminingFilename.addListener === "function"
) {
  downloadsOnDeterminingFilenameRegistrationCount++;
  chrome.downloads.onDeterminingFilename.addListener((download, suggest) => {
    if (!download || typeof suggest !== "function") return;
    pruneExpiredClaims();

    appendDownloadTrace("chrome.downloads.onDeterminingFilename-fired", {
      downloadId: download.id,
      geminiOriginated: isGeminiOriginatedDownload(download),
      activeClaimCount: expectedDownloadClaims.size,
      historyCount: downloadHistory.length,
      url: (download.url || "").slice(0, 256),
    });

    let matched = null;
    for (const [execId, claim] of expectedDownloadClaims) {
      if (claim.downloadId === download.id) {
        matched = { execId, claim };
        break;
      }
    }
    if (!matched) {
      if (!isGeminiOriginatedDownload(download)) return;
      matched = findActiveClaimForDownload(download);
      if (!matched) {
        appendDownloadTrace("filename-suggested", {
          result: "no-claim",
          downloadId: download.id,
        });
        return;
      }
    }

    if (!isGeminiOriginatedDownload(download)) {
      appendDownloadTrace("filename-suggested", {
        result: "not-gemini",
        downloadId: download.id,
      });
      return;
    }

    appendDownloadTrace("filename-suggested", {
      result: "ok",
      downloadId: download.id,
      executionId: matched.execId,
      taskId: matched.claim.taskId || null,
      filename: matched.claim.desiredFilename,
    });

    suggest({
      filename: matched.claim.desiredFilename,
      conflictAction: "uniquify",
    });
  });
}

// chrome.downloads.onChanged: D11 & D12
if (chrome?.downloads?.onChanged && typeof chrome.downloads.onChanged.addListener === "function") {
  downloadsOnChangedRegistrationCount++;
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || typeof delta.id !== "number") return;
    const tracked = trackedDownloads.get(delta.id);
    if (!tracked) return;

    if (!delta.state) return;
    const cur = delta.state.current;
    const filenameDelta = delta.filename && delta.filename.current
      ? delta.filename.current
      : null;
    const errorDelta = delta.error && delta.error.current
      ? delta.error.current
      : null;

    appendDownloadTrace("chrome.downloads.onChanged-fired", {
      downloadId: delta.id,
      state: cur,
      filename: filenameDelta,
      error: errorDelta,
      executionId: tracked.executionId || null,
      taskId: tracked.taskId || null,
    });

    if (cur === "complete" || cur === "interrupted") {
      const archivedClaim = tracked.executionId
        ? expectedDownloadClaims.get(tracked.executionId)
        : null;
      if (tracked.executionId) {
        expectedDownloadClaims.delete(tracked.executionId);
      }
      downloadHistory.push({
        executionId: tracked.executionId || null,
        taskId: tracked.taskId || null,
        downloadId: delta.id,
        filename: filenameDelta || (archivedClaim && archivedClaim.desiredFilename) || null,
        requestedFilename: tracked.requestedFilename || null,
        finalState: cur,
        completedAt: Date.now(),
      });

      if (cur === "complete") {
        appendDownloadTrace("chrome-download-complete", {
          downloadId: delta.id,
          filename: filenameDelta || (archivedClaim && archivedClaim.desiredFilename) || null,
          requestedFilename: tracked.requestedFilename,
          executionId: tracked.executionId || null,
          taskId: tracked.taskId || null,
          completedAt: Date.now(),
        });
      } else {
        appendDownloadTrace("chrome-download-interrupted", {
          downloadId: delta.id,
          error: errorDelta || "download-interrupted",
          executionId: tracked.executionId || null,
          taskId: tracked.taskId || null,
        });
      }

      appendDownloadTrace("claim-cleared", {
        reason: cur,
        executionId: tracked.executionId || null,
        taskId: tracked.taskId || null,
        downloadId: delta.id,
        filename: filenameDelta || null,
        previousClaim: archivedClaim
          ? {
              executionId: tracked.executionId,
              taskId: archivedClaim.taskId,
              desiredFilename: archivedClaim.desiredFilename,
            }
          : null,
      });

      postDownloadState({
        type: GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED,
        downloadId: delta.id,
        state: cur,
        filename: filenameDelta || (archivedClaim && archivedClaim.desiredFilename) || null,
        requestedFilename: tracked.requestedFilename,
        error: errorDelta,
        completedAt: Date.now(),
        executionId: tracked.executionId || null,
        taskId: tracked.taskId || null,
      });
      forgetDownload(delta.id);
    } else if (cur === "in_progress") {
      appendDownloadTrace("chrome-download-in-progress", {
        downloadId: delta.id,
        executionId: tracked.executionId || null,
        taskId: tracked.taskId || null,
      });
      postDownloadState({
        type: GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED,
        downloadId: delta.id,
        state: "in_progress",
        filename: filenameDelta,
        requestedFilename: tracked.requestedFilename,
        executionId: tracked.executionId || null,
        taskId: tracked.taskId || null,
      });
    }
  });
}

// Messaging handler
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "GEMINI_ASSISTANT_DOWNLOAD_BLOB") {
      handleDownloadBlob(msg, sender)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }
    if (msg.type === GEMINI_ASSISTANT_ARM_DOWNLOAD) {
      const r = handleArmDownload(msg);
      sendResponse(r);
      return true;
    }
    if (msg.type === GEMINI_ASSISTANT_GET_DOWNLOAD_TRACE) {
      const last = downloadTrace.slice(-50);
      try {
        chrome.runtime.sendMessage({
          type: GEMINI_ASSISTANT_DOWNLOAD_TRACE_RESPONSE,
          ok: true,
          trace: last,
          traceLength: downloadTrace.length,
          registrationCounts: {
            downloadsOnCreatedRegistrationCount,
            downloadsOnChangedRegistrationCount,
            downloadsOnDeterminingFilenameRegistrationCount,
          },
          serviceWorkerRuntimeId,
        }).catch(() => {});
      } catch (_) {}
      sendResponse({
        ok: true,
        traceLength: downloadTrace.length,
        registrationCounts: {
          downloadsOnCreatedRegistrationCount,
          downloadsOnChangedRegistrationCount,
          downloadsOnDeterminingFilenameRegistrationCount,
        },
        serviceWorkerRuntimeId,
      });
      return true;
    }
    if (msg.type === GEMINI_ASSISTANT_DOWNLOAD_PROBE) {
      const lastStep =
        downloadTrace.length > 0
          ? downloadTrace[downloadTrace.length - 1].step
          : null;
      sendResponse({
        ok: true,
        traceLength: downloadTrace.length,
        lastStep,
        registrationCounts: {
          downloadsOnCreatedRegistrationCount,
          downloadsOnChangedRegistrationCount,
          downloadsOnDeterminingFilenameRegistrationCount,
        },
        serviceWorkerRuntimeId,
      });
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
    GEMINI_ASSISTANT_GET_DOWNLOAD_TRACE,
    GEMINI_ASSISTANT_DOWNLOAD_TRACE_RESPONSE,
    GEMINI_ASSISTANT_DOWNLOAD_PROBE,
    trackedDownloads,
    expectedDownloadClaims,
    downloadHistory,
    downloadTrace,
    CLAIM_WINDOW_MS,
    isGeminiOriginatedDownload,
    getRegistrationCounts: () => ({
      downloadsOnCreatedRegistrationCount,
      downloadsOnChangedRegistrationCount,
      downloadsOnDeterminingFilenameRegistrationCount,
    }),
    getServiceWorkerRuntimeId: () => serviceWorkerRuntimeId,
  };
}
