/*
 * content.js
 *
 * Bridges the extension side panel (formerly popup) to the Gemini DOM
 * via geminiDomAdapter. The adapter is loaded BEFORE this script (see
 * manifest.json order), so globalThis.RedSunDomAdapter is already
 * available.
 *
 * Message protocol (side panel -> content):
 *   { type: "GEMINI_ASSISTANT_PING" }
 *     -> { ok: true, url, selfTest }
 *   { type: "GEMINI_ASSISTANT_INSERT_PROMPT", text: string }
 *     -> { ok: true, length } | { ok: false, error }
 *   { type: "GEMINI_ASSISTANT_ATTACH", file: File, fileName?, fileType?, fileSize? }
 *     -> { ok: true, method, fileName, fileType, fileSize } | { ok: false, error, diagnostics, requiresActivation? }
 *   { type: "GEMINI_ASSISTANT_ATTACH_PROBE" }
 *     -> { ok: true, probe, activated? } | { ok: false, error }
 *   { type: "GEMINI_ASSISTANT_ATTACH_ACTIVATE" }
 *     -> { ok, reason, message, probeBefore, probeAfter }
 *
 * The File in ATTACH is structured-cloneable (it is a Blob), so it
 * crosses the chrome.tabs.sendMessage boundary without base64. The
 * adapter does all the DOM work; this script does not touch the page.
 */

(function () {
  "use strict";

  const LOG_PREFIX = "[Gemini Assistant:content]";

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function handleMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg !== "object") {
      sendResponse({ ok: false, error: "invalid message" });
      return false;
    }

    switch (msg.type) {
      case "GEMINI_ASSISTANT_PING": {
        const adapter = globalThis.RedSunDomAdapter;
        sendResponse({
          ok: true,
          url: location.href,
          ready: !!adapter,
          selfTest: adapter ? adapter.selfTest() : null,
        });
        return false;
      }

      case "GEMINI_ASSISTANT_INSERT_PROMPT": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        // insertPromptIntoGemini is async; keep the message channel open.
        adapter
          .insertPromptIntoGemini(msg.text ?? "")
          .then((result) => sendResponse(result))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      case "GEMINI_ASSISTANT_ATTACH": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        if (!adapter.attachFileToGemini) {
          sendResponse({ ok: false, error: "adapter does not support attachment" });
          return false;
        }
        const file = msg.file;
        if (!file || typeof file !== "object" || typeof file.name !== "string") {
          sendResponse({ ok: false, error: "Invalid file payload" });
          return false;
        }
        // attachFileToGemini is async; keep the message channel open.
        adapter
          .attachFileToGemini(file)
          .then((result) => sendResponse(result))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      case "GEMINI_ASSISTANT_ATTACH_WITH_MENU": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.attachFileWithMenu !== "function") {
          sendResponse({
            ok: false,
            error: "adapter does not support attachFileWithMenu",
          });
          return false;
        }
        const file = msg.file;
        if (!file || typeof file !== "object" || typeof file.name !== "string") {
          sendResponse({ ok: false, error: "Invalid file payload" });
          return false;
        }
        const opts =
          msg.options && typeof msg.options === "object"
            ? msg.options
            : undefined;
        adapter
          .attachFileWithMenu(file, opts)
          .then((result) => sendResponse(result))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      case "GEMINI_ASSISTANT_COMPOSER_STATE": {
        // Returns the current state of the composer: attachment count,
        // upload-pending flag, prompt length, etc. Used by preflight.
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        try {
          const area = document.querySelector("input-area-v2");
          const attachments = area
            ? area.querySelectorAll("gem-media-attachment").length
            : 0;
          // Pending uploads: any progressbar inside the attachments.
          const pendingUploads = area
            ? area.querySelectorAll(
                'gem-media-attachment [role="progressbar"], gem-media-attachment mat-progress-spinner',
              ).length
            : 0;
          // Textbox + prompt length
          const tb =
            document.querySelector('[role="textbox"]') || adapter.findPromptInput?.();
          let promptLength = 0;
          if (tb) {
            const txt = (tb.innerText || "").replace(/\u00a0/g, " ");
            promptLength = txt.length;
          }
          // Image mode (lazy)
          const imageProbe =
            typeof adapter.imageModeProbe === "function"
              ? adapter.imageModeProbe()
              : null;
          sendResponse({
            ok: true,
            attachmentCount: attachments,
            pendingUploadCount: pendingUploads,
            promptLength,
            imageModeActive: !!(imageProbe && imageProbe.imageModeActive),
            composerClean: attachments === 0 && pendingUploads === 0 && promptLength === 0,
          });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_ATTACH_PROBE": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        if (typeof adapter.attachmentProbe !== "function") {
          sendResponse({ ok: false, error: "adapter does not support probe" });
          return false;
        }
        try {
          const probe = adapter.attachmentProbe();
          sendResponse({ ok: true, probe });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_ATTACH_ACTIVATE": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        if (typeof adapter.activateAttachmentFlow !== "function") {
          sendResponse({ ok: false, error: "adapter does not support activate" });
          return false;
        }
        adapter
          .activateAttachmentFlow()
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      case "GEMINI_ASSISTANT_ATTACH_TRACE": {
        // v0.6.2: structured trace of one attach operation.
        // Side panel receives the full trace (steps array) so it can
        // render "Failed at: <step>" and a step-by-step expander.
        // This message is intentionally read-only: the trace stops at
        // upload-action-detected and does NOT modify Gemini state.
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        if (typeof adapter.runAttachTrace !== "function") {
          sendResponse({
            ok: false,
            error: "adapter does not support runAttachTrace",
          });
          return false;
        }
        const file = msg.file;
        if (!file || typeof file !== "object" || typeof file.name !== "string") {
          sendResponse({ ok: false, error: "Invalid file payload" });
          return false;
        }
        adapter
          .runAttachTrace(file)
          .then((result) => sendResponse({ ok: true, trace: result }))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      case "GEMINI_ASSISTANT_ATTACH_STRATEGY_A": {
        // v0.6.2: opt-in injection attempt. Returns full trace; ok is
        // false (and failedAt set) if any step failed.
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        if (typeof adapter.runAttachStrategyA !== "function") {
          sendResponse({
            ok: false,
            error: "adapter does not support runAttachStrategyA",
          });
          return false;
        }
        const file = msg.file;
        if (!file || typeof file !== "object" || typeof file.name !== "string") {
          sendResponse({ ok: false, error: "Invalid file payload" });
          return false;
        }
        adapter
          .runAttachStrategyA(file)
          .then((result) => sendResponse({ ok: true, trace: result }))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      case "GEMINI_ASSISTANT_IMAGE_MODE_PROBE": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.imageModeProbe !== "function") {
          sendResponse({ ok: false, error: "adapter does not support image mode probe" });
          return false;
        }
        try {
          sendResponse({ ok: true, probe: adapter.imageModeProbe() });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_ENSURE_IMAGE_MODE": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.ensureImageGenerationMode !== "function") {
          sendResponse({ ok: false, error: "adapter does not support ensureImageGenerationMode" });
          return false;
        }
        adapter
          .ensureImageGenerationMode()
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      case "GEMINI_ASSISTANT_SEND_COMPOSER": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.sendCurrentComposer !== "function") {
          sendResponse({ ok: false, error: "adapter does not support sendCurrentComposer" });
          return false;
        }
        adapter
          .sendCurrentComposer()
          .then((result) => sendResponse(result))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      case "GEMINI_ASSISTANT_FIND_SEND_BUTTON": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.findSendButtonDiagnostic !== "function") {
          sendResponse({ ok: false, found: false });
          return false;
        }
        try {
          sendResponse({ ok: true, ...adapter.findSendButtonDiagnostic() });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_CAPTURE_BASELINE": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.captureConversationBaseline !== "function") {
          sendResponse({ ok: false, error: "adapter missing" });
          return false;
        }
        try {
          sendResponse({
            ok: true,
            baseline: adapter.captureConversationBaseline(),
          });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_WAIT_FOR_GENERATED_IMAGE": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.waitForNewGeneratedImage !== "function") {
          sendResponse({ ok: false, error: "adapter missing" });
          return false;
        }
        const baseline = msg.baseline || null;
        const timeoutMs =
          typeof msg.timeoutMs === "number" && msg.timeoutMs > 0
            ? msg.timeoutMs
            : 90000;
        adapter
          .waitForNewGeneratedImage(baseline, timeoutMs)
          .then((result) => sendResponse(result))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      case "GEMINI_ASSISTANT_FETCH_IMAGE": {
        // Fetch the image URL from the page context (where session
        // cookies live) and return the bytes as ArrayBuffer.
        const url = msg.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          sendResponse({ ok: false, error: "invalid url" });
          return false;
        }
        fetch(url, { credentials: "include" })
          .then(async (resp) => {
            if (!resp.ok) {
              sendResponse({
                ok: false,
                error: `HTTP ${resp.status} ${resp.statusText}`,
              });
              return;
            }
            const mime = resp.headers.get("content-type") || "";
            const ab = await resp.arrayBuffer();
            sendResponse({
              ok: true,
              arrayBuffer: ab, // structured-cloned across contexts
              mime,
              contentLength: ab.byteLength,
              finalUrl: resp.url || url,
            });
          })
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) }),
          );
        return true;
      }

      default:
        sendResponse({ ok: false, error: `unknown type: ${msg.type}` });
        return false;
    }
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  log("content script loaded");
})();
