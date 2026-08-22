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

  // Idempotent initialization: If runtime already exists, tear it down cleanly first
  if (globalThis.__GEMINI_ASSISTANT_RUNTIME__) {
    try {
      globalThis.__GEMINI_ASSISTANT_RUNTIME__.destroy();
    } catch (_) {}
  }

  globalThis.__GEMINI_ASSISTANT_RUNTIME_INIT_COUNT__ =
    (globalThis.__GEMINI_ASSISTANT_RUNTIME_INIT_COUNT__ || 0) + 1;

  const runtimeId = "runtime-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const initializedAt = Date.now();

  let activeExecution = null;
  const activeObservers = new Set();
  const activeTimers = new Set();

  function cleanupActiveExecution(reason = "cleanup") {
    if (activeExecution) {
      if (activeExecution.abortController) {
        try {
          activeExecution.abortController.abort(reason);
        } catch (_) {}
      }
      activeExecution = null;
    }
    for (const obs of activeObservers) {
      try {
        obs.disconnect();
      } catch (_) {}
    }
    activeObservers.clear();

    for (const timerId of activeTimers) {
      try {
        clearTimeout(timerId);
        clearInterval(timerId);
      } catch (_) {}
    }
    activeTimers.clear();
  }

  async function computeSha256(buffer) {
    if (!buffer) return "";
    try {
      if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
        const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (_) {}
    let hash = 2166136261;
    const view = new Uint8Array(buffer);
    for (let i = 0; i < view.length; i++) {
      hash ^= view[i];
      hash = Math.imul(hash, 16777619);
    }
    return "fnv:" + (hash >>> 0).toString(16);
  }

  async function resolveFilePayload(msg) {
    if (!msg || typeof msg !== "object") {
      return { ok: false, error: "Invalid message payload" };
    }

    // 1. Direct File instance (Structured Clone)
    if (typeof File !== "undefined" && msg.file instanceof File) {
      if (typeof msg.fileSize === "number" && msg.fileSize > 0 && msg.file.size !== msg.fileSize) {
        return {
          ok: false,
          error: `File transport integrity failed: size mismatch (expected ${msg.fileSize}, received ${msg.file.size})`,
        };
      }
      if (msg.file.size === 0) {
        return { ok: false, error: "Invalid file payload: file is empty (0 bytes)" };
      }
      return { ok: true, file: msg.file, method: "structured_clone_file" };
    }

    // 2. Binary payload (ArrayBuffer, TypedArray or lossless byte array)
    let buf = null;
    if (
      msg.arrayBuffer instanceof ArrayBuffer ||
      (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(msg.arrayBuffer))
    ) {
      buf = msg.arrayBuffer instanceof ArrayBuffer ? msg.arrayBuffer : msg.arrayBuffer.buffer;
    } else if (Array.isArray(msg.byteArray) && msg.byteArray.length > 0) {
      buf = new Uint8Array(msg.byteArray).buffer;
    }

    if (buf) {
      const receivedSize = buf.byteLength;
      if (receivedSize === 0) {
        return { ok: false, error: "Invalid file payload: empty binary payload (0 bytes)" };
      }

      // Check size invariant
      if (typeof msg.fileSize === "number" && msg.fileSize > 0 && receivedSize !== msg.fileSize) {
        return {
          ok: false,
          error: `File transport integrity failed: size mismatch (expected ${msg.fileSize}, received ${receivedSize})`,
        };
      }

      // Check SHA-256 hash invariant if provided
      if (typeof msg.sha256 === "string" && msg.sha256.length > 0) {
        const receivedHash = await computeSha256(buf);
        if (receivedHash !== msg.sha256) {
          return {
            ok: false,
            error: `File transport integrity failed: hash mismatch (expected ${msg.sha256}, received ${receivedHash})`,
          };
        }
      }

      const fileName =
        typeof msg.fileName === "string" && msg.fileName.length > 0
          ? msg.fileName
          : (msg.file && typeof msg.file.name === "string" ? msg.file.name : "image.png");
      const fileType =
        typeof msg.fileType === "string" && msg.fileType.length > 0
          ? msg.fileType
          : (msg.file && typeof msg.file.type === "string" ? msg.file.type : "image/png");
      const lastModified = msg.lastModified || (msg.file && msg.file.lastModified) || Date.now();

      if (typeof File === "undefined") {
        return {
          ok: true,
          file: {
            name: fileName,
            type: fileType,
            size: receivedSize,
            arrayBuffer: async () => buf,
          },
          method: "reconstructed_arraybuffer",
        };
      }

      try {
        const file = new File([buf], fileName, { type: fileType, lastModified });
        return { ok: true, file, sha256: msg.sha256, method: "reconstructed_file" };
      } catch (e) {
        return { ok: false, error: `Could not reconstruct File: ${e?.message ?? String(e)}` };
      }
    }

    // 3. Fallback: Reject metadata-only fake File
    if (msg.file && typeof msg.file === "object" && typeof msg.file.name === "string") {
      return {
        ok: false,
        error: "Invalid file payload: metadata-only object received without verified image bytes",
      };
    }

    return { ok: false, error: "Invalid file payload: no file data found" };
  }

  function handleMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg !== "object") {
      sendResponse({ ok: false, error: "invalid message" });
      return false;
    }

    // Handle runtime status & execution lifecycle messages
    if (msg.type === "GEMINI_ASSISTANT_GET_RUNTIME_STATUS") {
      sendResponse({
        ok: true,
        runtimeId,
        initializedAt,
        runtimeInitializedCount: globalThis.__GEMINI_ASSISTANT_RUNTIME_INIT_COUNT__ || 1,
        messageHandlerRegistrationCount: 1,
        activeMutationObserverCount: activeObservers.size,
        activeTimerCount: activeTimers.size,
        activeExecution: activeExecution ? {
          executionId: activeExecution.executionId,
          taskId: activeExecution.taskId,
          preparationSessionId: activeExecution.preparationSessionId,
          phase: activeExecution.phase,
          startedAt: activeExecution.startedAt,
        } : null,
        activeExecutionId: activeExecution?.executionId ?? null,
        activeTaskId: activeExecution?.taskId ?? null,
        phase: activeExecution?.phase ?? "idle",
      });
      return false;
    }

    if (msg.type === "GEMINI_ASSISTANT_START_EXECUTION") {
      if (
        activeExecution &&
        activeExecution.phase !== "complete" &&
        activeExecution.phase !== "cancelled" &&
        activeExecution.phase !== "error"
      ) {
        if (msg.force) {
          cleanupActiveExecution("forced-new-execution");
        } else if (activeExecution.executionId !== msg.executionId) {
          sendResponse({
            ok: false,
            reason: "execution-already-active",
            activeExecution: {
              executionId: activeExecution.executionId,
              taskId: activeExecution.taskId,
              phase: activeExecution.phase,
              startedAt: activeExecution.startedAt,
            },
          });
          return false;
        }
      }
      activeExecution = {
        executionId: msg.executionId || ("exec-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
        taskId: msg.taskId || null,
        preparationSessionId: msg.preparationSessionId || null,
        phase: "preparing",
        startedAt: Date.now(),
        abortController: new AbortController(),
      };
      sendResponse({ ok: true, executionId: activeExecution.executionId });
      return false;
    }

    if (msg.type === "GEMINI_ASSISTANT_CANCEL_EXECUTION") {
      cleanupActiveExecution(msg.reason || "cancelled");
      sendResponse({ ok: true });
      return false;
    }

    // Stale execution rejection
    if (
      msg.executionId &&
      activeExecution &&
      activeExecution.executionId &&
      activeExecution.executionId !== msg.executionId
    ) {
      sendResponse({
        ok: false,
        reason: "stale-execution",
        activeExecutionId: activeExecution.executionId,
        messageExecutionId: msg.executionId,
      });
      return false;
    }

    switch (msg.type) {
      case "GEMINI_ASSISTANT_PING": {
        const adapter = globalThis.RedSunDomAdapter;
        let selfTestSafe = null;
        if (adapter && typeof adapter.selfTest === "function") {
          try {
            selfTestSafe = adapter.selfTest();
          } catch (e) {
            log("PING selfTest probe error:", e?.message ?? String(e));
            selfTestSafe = { error: e?.message ?? String(e) };
          }
        }
        sendResponse({
          ok: true,
          url: typeof location !== "undefined" ? location.href : "",
          ready: !!adapter,
          selfTest: selfTestSafe,
        });
        return false;
      }

      case "GEMINI_ASSISTANT_PROBE": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.selfTest !== "function") {
          sendResponse({ ok: false, error: "adapter selfTest unavailable" });
          return false;
        }
        try {
          sendResponse({ ok: true, probe: adapter.selfTest() });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_TRANSPORT_TEST": {
        resolveFilePayload(msg)
          .then((resolved) => {
            if (!resolved.ok || !resolved.file) {
              sendResponse({ ok: false, error: resolved.error || "Invalid file payload" });
              return;
            }
            const file = resolved.file;
            sendResponse({
              ok: true,
              isFileInstance: typeof File !== "undefined" && file instanceof File,
              fileName: file.name,
              fileType: file.type,
              fileSize: file.size,
            });
          })
          .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
        return true;
      }

      case "GEMINI_ASSISTANT_DISCOVER_UPLOADS": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.discoverUploadMechanisms !== "function") {
          sendResponse({ ok: false, error: "adapter does not support discoverUploadMechanisms" });
          return false;
        }
        try {
          const discovery = adapter.discoverUploadMechanisms();
          sendResponse({ ok: true, discovery });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_TEST_SINGLE_ATTACH": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.testSingleImageAttachment !== "function") {
          sendResponse({ ok: false, error: "adapter does not support testSingleImageAttachment" });
          return false;
        }
        resolveFilePayload(msg)
          .then((resolved) => {
            if (!resolved.ok || !resolved.file) {
              sendResponse({
                ok: false,
                failedStage: "FILE_TRANSPORT_INTEGRITY",
                reason: resolved.error || "Invalid file payload",
              });
              return;
            }
            adapter
              .testSingleImageAttachment(resolved.file, msg.options)
              .then((result) => sendResponse(result))
              .catch((e) =>
                sendResponse({ ok: false, error: e?.message ?? String(e) })
              );
          })
          .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
        return true;
      }

      case "GEMINI_ASSISTANT_TEST_A_BUNDLED": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.attachFileWithMenu !== "function") {
          sendResponse({ ok: false, error: "adapter not loaded or attachFileWithMenu missing" });
          return false;
        }

        (async () => {
          try {
            const assetUrl = chrome.runtime.getURL("assets/attachment-test.png");
            const fetchRes = await fetch(assetUrl);
            if (!fetchRes.ok) {
              sendResponse({ ok: false, error: `Could not fetch bundled asset: ${fetchRes.statusText}` });
              return;
            }
            const blob = await fetchRes.blob();
            const buffer = await blob.arrayBuffer();
            const sha256 = await computeSha256(buffer);
            const file = new File([blob], "attachment-test.png", { type: "image/png" });

            const diagnostics = {
              source: "extension-bundled (assets/attachment-test.png)",
              constructor: file.constructor.name,
              isFileInstance: file instanceof File,
              name: file.name,
              type: file.type,
              size: file.size,
              sha256,
            };

            log("[Test A] Bundled PNG loaded:", diagnostics);

            // Execute attachment
            const attachRes = await adapter.attachFileWithMenu(file, { timeoutMs: 8000 });

            sendResponse({
              ok: !!(attachRes && attachRes.ok),
              test: "TEST_A_BUNDLED",
              fileDiagnostics: diagnostics,
              attachmentResult: attachRes,
            });
          } catch (e) {
            sendResponse({ ok: false, test: "TEST_A_BUNDLED", error: e?.message ?? String(e) });
          }
        })();
        return true;
      }

      case "GEMINI_ASSISTANT_TEST_B_SYNTHETIC": {
        (async () => {
          try {
            const rawFile = msg.file;
            const rawArrayBuffer = msg.arrayBuffer;
            const rawByteArray = msg.byteArray;

            const resolved = await resolveFilePayload(msg);
            let sha256After = "";
            let sizeAfter = 0;
            if (resolved.ok && resolved.file) {
              sizeAfter = resolved.file.size;
              if (typeof resolved.file.arrayBuffer === "function") {
                const buf = await resolved.file.arrayBuffer();
                sha256After = await computeSha256(buf);
              }
            }

            const report = {
              ok: resolved.ok && sizeAfter === msg.fileSize && (msg.sha256 ? sha256After === msg.sha256 : true),
              test: "TEST_B_SYNTHETIC",
              rawReceived: {
                fileConstructor: rawFile ? rawFile.constructor.name : null,
                isFileInstance: typeof File !== "undefined" && rawFile instanceof File,
                arrayBufferConstructor: rawArrayBuffer ? rawArrayBuffer.constructor.name : null,
                isArrayBufferInstance: typeof ArrayBuffer !== "undefined" && rawArrayBuffer instanceof ArrayBuffer,
                hasByteArray: Array.isArray(rawByteArray),
                byteArrayLength: Array.isArray(rawByteArray) ? rawByteArray.length : 0,
              },
              reconstructed: {
                constructor: resolved.file ? resolved.file.constructor.name : null,
                isFileInstance: typeof File !== "undefined" && resolved.file instanceof File,
                name: resolved.file?.name ?? null,
                type: resolved.file?.type ?? null,
                size: sizeAfter,
                sha256: sha256After,
              },
              comparison: {
                expectedSize: msg.fileSize,
                receivedSize: sizeAfter,
                sizeMatch: msg.fileSize === sizeAfter,
                expectedHash: msg.sha256 ?? null,
                receivedHash: sha256After,
                hashMatch: msg.sha256 ? msg.sha256 === sha256After : true,
              },
              resolvedMethod: resolved.method,
              error: resolved.error || null,
            };

            sendResponse(report);
          } catch (e) {
            sendResponse({ ok: false, test: "TEST_B_SYNTHETIC", error: e?.message ?? String(e) });
          }
        })();
        return true;
      }

      case "GEMINI_ASSISTANT_TEST_C_PROJECT": {
        (async () => {
          try {
            const resolved = await resolveFilePayload(msg);
            let sha256After = "";
            let sizeAfter = 0;
            if (resolved.ok && resolved.file) {
              sizeAfter = resolved.file.size;
              if (typeof resolved.file.arrayBuffer === "function") {
                const buf = await resolved.file.arrayBuffer();
                sha256After = await computeSha256(buf);
              }
            }

            const report = {
              ok: resolved.ok && sizeAfter === msg.fileSize && (msg.sha256 ? sha256After === msg.sha256 : true),
              test: "TEST_C_PROJECT",
              fileName: msg.fileName,
              expectedSize: msg.fileSize,
              receivedSize: sizeAfter,
              sizeMatch: msg.fileSize === sizeAfter,
              expectedHash: msg.sha256 ?? null,
              receivedHash: sha256After,
              hashMatch: msg.sha256 ? msg.sha256 === sha256After : true,
              resolvedMethod: resolved.method,
              error: resolved.error || null,
            };

            sendResponse(report);
          } catch (e) {
            sendResponse({ ok: false, test: "TEST_C_PROJECT", error: e?.message ?? String(e) });
          }
        })();
        return true;
      }

      case "GEMINI_ASSISTANT_INSERT_PROMPT": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        const insertFn = typeof adapter.setComposerText === "function"
          ? adapter.setComposerText
          : adapter.insertPromptIntoGemini;
        if (typeof insertFn !== "function") {
          sendResponse({ ok: false, error: "adapter does not support setComposerText" });
          return false;
        }
        insertFn(msg.text ?? "")
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
        resolveFilePayload(msg)
          .then((resolved) => {
            if (!resolved.ok || !resolved.file) {
              sendResponse({ ok: false, error: resolved.error || "Invalid file payload" });
              return;
            }
            adapter
              .attachFileToGemini(resolved.file)
              .then((result) => sendResponse(result))
              .catch((e) =>
                sendResponse({ ok: false, error: e?.message ?? String(e) })
              );
          })
          .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
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
        resolveFilePayload(msg)
          .then((resolved) => {
            if (!resolved.ok || !resolved.file) {
              sendResponse({ ok: false, error: resolved.error || "Invalid file payload" });
              return;
            }
            const opts =
              msg.options && typeof msg.options === "object"
                ? msg.options
                : undefined;
            adapter
              .attachFileWithMenu(resolved.file, opts)
              .then((result) => sendResponse(result))
              .catch((e) =>
                sendResponse({ ok: false, error: e?.message ?? String(e) })
              );
          })
          .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
        return true;
      }

      case "GEMINI_ASSISTANT_COMPOSER_STATE": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        try {
          const area = document.querySelector("input-area-v2") || (typeof adapter.findPromptInputArea === "function" ? adapter.findPromptInputArea() : null);
          const attachments = typeof adapter.countComposerAttachments === "function"
            ? adapter.countComposerAttachments(area)
            : (area && typeof area.querySelectorAll === "function" ? area.querySelectorAll("gem-media-attachment").length : 0);
          const pendingUploads = typeof adapter.countActiveUploads === "function"
            ? adapter.countActiveUploads(area)
            : 0;
          const readFn = typeof adapter.readComposerText === "function"
            ? adapter.readComposerText
            : adapter.getComposerText;
          const promptText = typeof readFn === "function"
            ? readFn()
            : (document.querySelector('[role="textbox"]') || adapter.findPromptInput?.())?.innerText || "";
          const promptLength = promptText.length;
          const imageProbe =
            typeof adapter.imageModeProbe === "function"
              ? adapter.imageModeProbe()
              : null;
          sendResponse({
            ok: true,
            attachmentCount: attachments,
            pendingUploadCount: pendingUploads,
            promptLength,
            promptText,
            imageModeActive: !!(imageProbe && imageProbe.imageModeActive),
            composerClean: attachments === 0 && pendingUploads === 0 && promptLength === 0,
          });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_INSPECT_COMPOSER": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.inspectComposerContent !== "function") {
          sendResponse({ ok: false, error: "adapter does not support inspectComposerContent" });
          return false;
        }
        try {
          const inspection = adapter.inspectComposerContent(msg.expectedPrompt, msg.expectedRefCount);
          sendResponse(inspection);
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_CLEAR_COMPOSER": {
        const adapter = globalThis.RedSunDomAdapter;
        const clearFn = typeof adapter?.clearComposer === "function"
          ? adapter.clearComposer
          : adapter?.clearComposerContent;
        if (typeof clearFn !== "function") {
          sendResponse({ ok: false, error: "adapter does not support clearComposer" });
          return false;
        }
        clearFn()
          .then((res) => sendResponse(res))
          .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
        return true;
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
        resolveFilePayload(msg)
          .then((resolved) => {
            if (!resolved.ok || !resolved.file) {
              sendResponse({ ok: false, error: resolved.error || "Invalid file payload" });
              return;
            }
            adapter
              .runAttachTrace(resolved.file)
              .then((result) => sendResponse({ ok: true, trace: result }))
              .catch((e) =>
                sendResponse({ ok: false, error: e?.message ?? String(e) })
              );
          })
          .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
        return true;
      }

      case "GEMINI_ASSISTANT_ATTACH_STRATEGY_A": {
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
        resolveFilePayload(msg)
          .then((resolved) => {
            if (!resolved.ok || !resolved.file) {
              sendResponse({ ok: false, error: resolved.error || "Invalid file payload" });
              return;
            }
            adapter
              .runAttachStrategyA(resolved.file)
              .then((result) => sendResponse({ ok: true, trace: result }))
              .catch((e) =>
                sendResponse({ ok: false, error: e?.message ?? String(e) })
              );
          })
          .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
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

      case "GEMINI_ASSISTANT_CLICK_SEND_BUTTON":
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

      case "GEMINI_ASSISTANT_DETECT_GENERATION_START": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.detectGenerationStart !== "function") {
          sendResponse({ ok: false, error: "adapter does not support detectGenerationStart" });
          return false;
        }
        const baseline = msg.baseline || null;
        const timeoutMs =
          typeof msg.timeoutMs === "number" && msg.timeoutMs > 0
            ? msg.timeoutMs
            : 15000;
        adapter
          .detectGenerationStart(baseline, timeoutMs)
          .then((result) => sendResponse(result))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
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

      case "GEMINI_ASSISTANT_FIND_NEW_RESULT": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter || typeof adapter.findNewGeneratedResult !== "function") {
          sendResponse({ ok: false, error: "adapter missing" });
          return false;
        }
        try {
          const res = adapter.findNewGeneratedResult(msg.baseline || null);
          sendResponse(res);
        } catch (e) {
          sendResponse({ ok: false, error: e?.message ?? String(e) });
        }
        return false;
      }

      case "GEMINI_ASSISTANT_FETCH_IMAGE": {
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
              arrayBuffer: ab,
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

  const runtime = {
    runtimeId,
    initializedAt,
    destroy() {
      cleanupActiveExecution("runtime-destroyed");
      chrome.runtime.onMessage.removeListener(handleMessage);
    },
  };
  globalThis.__GEMINI_ASSISTANT_RUNTIME__ = runtime;
  chrome.runtime.onMessage.addListener(handleMessage);

  log("content script loaded, runtimeId:", runtimeId);
})();
