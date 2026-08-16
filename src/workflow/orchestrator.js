/*
 * orchestrator.js
 *
 * Workflow state machine for Gemini Assistant v0.6.
 *
 * Lives in the Side Panel (not the content script) so that the sidepanel
 * UI can subscribe to phase changes and render progress.
 *
 * The orchestrator is intentionally thin: it does not touch the DOM or
 * chrome.* itself. Instead it dispatches `chrome.tabs.sendMessage` calls
 * to the content script, which delegates to globalThis.RedSunDomAdapter.
 *
 * Phases (single linear state machine, no parallel work):
 *
 *   idle
 *     -> preparing-image-mode
 *     -> preparing-attachments       (sequential per ref)
 *     -> preparing-prompt             (insert prompt)
 *     -> ready                        (stop here for user review)
 *
 *   idle
 *     -> preparing-image-mode
 *     -> preparing-attachments
 *     -> preparing-prompt
 *     -> preflight
 *     -> sending
 *     -> waiting-for-generation
 *     -> downloading
 *     -> complete
 *
 * On any phase failure we transition to `error` and surface the message.
 * A `cancel()` flag short-circuits all pending polling. The Side Panel
 * owns the orchestrator and binds its lifecycle to the Side Panel's
 * own lifecycle; cancellation on Side Panel close is automatic.
 *
 * The orchestrator never touches the filesystem beyond what chrome.downloads
 * already does, never persists base64, and never reads or writes bytes
 * outside the File objects handed to it.
 */

(function (globalScope) {
  "use strict";

  const PHASES = Object.freeze([
    "idle",
    "preparing-image-mode",
    "preparing-attachments",
    "preparing-prompt",
    "ready",
    "preflight",
    "sending",
    "waiting-for-generation",
    "downloading",
    "complete",
    "error",
    "cancelled",
  ]);

  function isString(v) {
    return typeof v === "string";
  }

  /**
   * Build an Orchestrator. The caller provides:
   *
   *   sendToTab(message) -> Promise<response>
   *     Wraps chrome.tabs.sendMessage. The orchestrator never imports
   *     chrome. The side panel is responsible for resolving the right
   *     Gemini tab (see src/lib/messaging.js). Returning a rejection
   *     here — for any reason — short-circuits the workflow.
   *
   *   onPhaseChange(phase, info)
   *     UI hook fired on every transition. info is a small object with
   *     phase-specific fields. Phase transitions are always emitted even
   *     if nothing else changed, so the side panel can refresh.
   *
   *   onAttachmentProgress(progressInfo)
   *     Fired during Attach All for each successful/failed reference.
   *
   *   onLog(level, message, info?)
   *     Optional structured log.
   *
   * The orchestrator also exposes `.state` for read-only inspection and
   * `.cancel()` for abort.
   *
   * v0.6.1: the previous signature `sendToTab(tabId, message)` caused
   * chrome.tabs.sendMessage to be invoked with `tabId === null` because
   * the internal closure variable was never assigned, which Chrome
   * rejects with "No matching signature". The orchestrator now delegates
   * tabId resolution to the caller (via src/lib/messaging.js).
   */
  function createOrchestrator(deps) {
    if (!deps || typeof deps.sendToTab !== "function") {
      throw new Error("Orchestrator requires deps.sendToTab(message)");
    }
    const onPhaseChange =
      typeof deps.onPhaseChange === "function" ? deps.onPhaseChange : () => {};
    const onAttachmentProgress =
      typeof deps.onAttachmentProgress === "function"
        ? deps.onAttachmentProgress
        : () => {};
    const onLog = typeof deps.onLog === "function" ? deps.onLog : () => {};

    // The single messaging choke point. Defends against malformed
    // payloads and normalises the error shape so the UI can render a
    // stable message regardless of which phase failed.
    async function sendToTab(message) {
      try {
        return await deps.sendToTab(message);
      } catch (e) {
        const reason = e?.message ?? String(e);
        throw new Error(
          `Could not communicate with Gemini content script: ${reason}`,
        );
      }
    }

    const state = {
      phase: "idle",
      cancelled: false,
      taskId: null,
      startedAt: null,
      // Per-phase progress details; reset on each transition into a phase.
      imageMode: null,
      attachments: [], // [{ assetId, label, fileName, ok, error?, elapsedMs? }]
      promptInserted: null, // { ok, length, method }
      preflight: null, // { ok, checks: [...] }
      send: null, // { ok, error? }
      generation: null, // { ok, imageSrc, alt, error? }
      download: null, // { ok, downloadId, finalFilename, error? }
      error: null,
    };

    let currentTask = null; // Promise that resolves the in-flight phase.

    function log(level, message, info) {
      try {
        onLog(level, message, info);
      } catch (_) {
        /* ignore */
      }
    }

    function transition(nextPhase, info) {
      if (state.cancelled && nextPhase !== "cancelled" && nextPhase !== "error") {
        return;
      }
      const prev = state.phase;
      state.phase = nextPhase;
      try {
        onPhaseChange(nextPhase, { prev, ...(info || {}) });
      } catch (_) {
        /* ignore */
      }
      log("phase", `${prev} -> ${nextPhase}`, info || {});
    }

    function failWith(phase, error, extra) {
      state.error = { phase, error, ...(extra || {}) };
      log("error", error, { phase, ...(extra || {}) });
      transition("error", { phase, error, ...(extra || {}) });
    }

    function ensureTabId(id) {
      // Backwards-compat shim. v0.6.1 no longer needs a tabId on the
      // orchestrator (the messaging helper owns it). External code that
      // still calls this method should not crash.
      if (typeof id !== "undefined" && id !== null) return;
      // No-op.
    }

    function reset(task) {
      state.cancelled = false;
      state.taskId = task?.id ?? null;
      state.startedAt = Date.now();
      state.imageMode = null;
      state.attachments = [];
      state.promptInserted = null;
      state.preflight = null;
      state.send = null;
      state.generation = null;
      state.download = null;
      state.error = null;
      currentTask = null;
      transition("idle", { taskId: state.taskId });
    }

    function cancel() {
      state.cancelled = true;
      transition("cancelled", { phase: state.phase });
      log("warn", "Operation cancelled by user.", { phase: state.phase });
    }

    function isActive() {
      return (
        state.phase !== "idle" &&
        state.phase !== "ready" &&
        state.phase !== "complete" &&
        state.phase !== "error" &&
        state.phase !== "cancelled"
      );
    }

    async function ensureImageMode() {
      transition("preparing-image-mode");
      try {
        const res = await sendToTab({
          type: "GEMINI_ASSISTANT_ENSURE_IMAGE_MODE",
        });
        state.imageMode = {
          ok: !!(res && res.ok),
          mode: res?.mode ?? null,
          error: res?.error ?? null,
        };
        if (!state.imageMode.ok) {
          failWith(
            "preparing-image-mode",
            state.imageMode.error || "Could not enable Image Generation mode.",
          );
          return false;
        }
        return true;
      } catch (e) {
        state.imageMode = { ok: false, mode: null, error: e?.message ?? String(e) };
        failWith("preparing-image-mode", state.imageMode.error);
        return false;
      }
    }

    /**
     * Attach all references sequentially. Caller passes the resolved
     * refs (output of assetLib.resolveReferences), in order.
     *
     * On any partial failure: stops, reports counts, transitions to error.
     * Does NOT send the prompt.
     */
    async function attachAll(resolvedRefs) {
      transition("preparing-attachments");
      if (!Array.isArray(resolvedRefs)) {
        failWith("preparing-attachments", "attachAll: resolvedRefs must be an array");
        return false;
      }
      for (let i = 0; i < resolvedRefs.length; i++) {
        if (state.cancelled) {
          transition("cancelled", { phase: "preparing-attachments" });
          return false;
        }
        const ref = resolvedRefs[i];
        if (!ref || ref.state !== "resolved" || !ref.fileObj) {
          const label = ref?.label || ref?.id || `#${i}`;
          state.attachments.push({
            assetId: ref?.id ?? null,
            label,
            fileName: ref?.fileName ?? null,
            ok: false,
            error:
              ref?.state === "missing"
                ? `Missing reference: ${ref?.error || "file not found"}`
                : ref?.state === "unsupported"
                  ? `Unsupported reference: ${ref?.error || "wrong mime"}`
                  : "Reference not resolved.",
          });
          failWith(
            "preparing-attachments",
            `Reference "${label}" could not be attached: ${
              state.attachments[i].error
            }`,
            { attachedCount: i, totalCount: resolvedRefs.length },
          );
          return false;
        }
        // Live progress: "Attaching X..."
        try {
          onAttachmentProgress({
            phase: "start",
            index: i,
            total: resolvedRefs.length,
            assetId: ref.id,
            label: ref.label,
            fileName: ref.fileName,
          });
        } catch (_) {
          /* ignore */
        }

        let res;
        try {
          res = await sendToTab({
            type: "GEMINI_ASSISTANT_ATTACH_WITH_MENU",
            file: ref.fileObj,
            fileName: ref.fileName,
            fileType: ref.fileType,
            fileSize: ref.fileSize,
          });
        } catch (e) {
          res = { ok: false, error: e?.message ?? String(e) };
        }

        const entry = {
          assetId: ref.id,
          label: ref.label,
          fileName: ref.fileName,
          ok: !!(res && res.ok),
          error: res?.error ?? null,
          elapsedMs: res?.elapsedMs ?? null,
        };
        state.attachments.push(entry);
        try {
          onAttachmentProgress({
            phase: entry.ok ? "ok" : "fail",
            index: i,
            total: resolvedRefs.length,
            assetId: ref.id,
            label: ref.label,
            fileName: ref.fileName,
            error: entry.error,
            elapsedMs: entry.elapsedMs,
          });
        } catch (_) {
          /* ignore */
        }
        if (!entry.ok) {
          failWith(
            "preparing-attachments",
            `Reference "${entry.label}" failed to attach: ${entry.error || "unknown"}`,
            {
              attachedCount: i,
              totalCount: resolvedRefs.length,
              lastError: entry,
            },
          );
          return false;
        }
      }
      return true;
    }

    async function insertPrompt(promptText) {
      transition("preparing-prompt");
      if (!isString(promptText)) {
        failWith("preparing-prompt", "Prompt text missing.");
        return false;
      }
      try {
        const res = await sendToTab({
          type: "GEMINI_ASSISTANT_INSERT_PROMPT",
          text: promptText,
        });
        state.promptInserted = {
          ok: !!(res && res.ok),
          length: res?.length ?? null,
          method: res?.method ?? null,
          error: res?.error ?? null,
        };
        if (!state.promptInserted.ok) {
          failWith(
            "preparing-prompt",
            state.promptInserted.error || "Failed to insert prompt.",
          );
          return false;
        }
        return true;
      } catch (e) {
        state.promptInserted = { ok: false, length: null, method: null, error: e?.message ?? String(e) };
        failWith("preparing-prompt", state.promptInserted.error);
        return false;
      }
    }

    /**
     * Stop after Prepare Task completes. UI shows "ready" and waits
     * for the user to click Generate Task.
     */
    function markReady() {
      transition("ready");
    }

    /**
     * Re-verify preflight conditions immediately before Send.
     * The caller (orchestrator) supplies the expected refs and prompt;
     * we fetch the live composer state and compare.
     */
    async function preflight(expected) {
      transition("preflight");
      const checks = [];

      // 1. Same task
      checks.push({
        name: "taskId matches",
        ok: !!state.taskId && state.taskId === expected.taskId,
      });

      // 2. Composer state
      let composer = null;
      try {
        composer = await sendToTab({
          type: "GEMINI_ASSISTANT_COMPOSER_STATE",
        });
      } catch (e) {
        composer = { ok: false, error: e?.message ?? String(e) };
      }

      checks.push({
        name: "composer state available",
        ok: !!(composer && composer.ok),
        detail: composer?.error ?? null,
      });

      const expectedRefCount = Array.isArray(expected.resolvedRefs) ? expected.resolvedRefs.length : 0;
      checks.push({
        name: `attachments present (${expectedRefCount} expected)`,
        ok:
          !!composer &&
          composer.attachmentCount === expectedRefCount &&
          composer.pendingUploadCount === 0,
        detail: {
          expected: expectedRefCount,
          actual: composer?.attachmentCount ?? null,
          pending: composer?.pendingUploadCount ?? null,
        },
      });

      checks.push({
        name: "prompt present",
        ok: !!composer && composer.promptLength === expected.promptLength,
        detail: { expected: expected.promptLength, actual: composer?.promptLength ?? null },
      });

      checks.push({
        name: "Image Generation mode active",
        ok: !!(composer && composer.imageModeActive),
        detail: { imageModeActive: composer?.imageModeActive ?? null },
      });

      // 6. Send button enabled. We rely on the DOM adapter to check.
      let sendBtn = null;
      try {
        const r = await sendToTab({
          type: "GEMINI_ASSISTANT_FIND_SEND_BUTTON",
        });
        sendBtn = r;
      } catch (e) {
        sendBtn = { ok: false, error: e?.message ?? String(e) };
      }
      checks.push({
        name: "Send button available",
        ok: !!(sendBtn && sendBtn.ok && !sendBtn.disabled),
        detail: sendBtn?.error ?? sendBtn ?? null,
      });

      const ok = checks.every((c) => c.ok);
      state.preflight = { ok, checks };
      if (!ok) {
        const failed = checks.filter((c) => !c.ok).map((c) => c.name);
        failWith(
          "preflight",
          `Preflight failed: ${failed.join(", ")}`,
          { checks },
        );
        return false;
      }
      return true;
    }

    /**
     * Send the current composer. Single click. Caller is responsible for
     * having just run a successful preflight.
     */
    async function send() {
      transition("sending");
      try {
        const res = await sendToTab({
          type: "GEMINI_ASSISTANT_SEND_COMPOSER",
        });
        state.send = { ok: !!(res && res.ok), error: res?.error ?? null };
        if (!state.send.ok) {
          failWith("sending", state.send.error || "Send failed.");
          return false;
        }
        return true;
      } catch (e) {
        state.send = { ok: false, error: e?.message ?? String(e) };
        failWith("sending", state.send.error);
        return false;
      }
    }

    async function captureBaseline() {
      try {
        const res = await sendToTab({
          type: "GEMINI_ASSISTANT_CAPTURE_BASELINE",
        });
        return res;
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    }

    async function waitForGeneratedImage(baseline, timeoutMs) {
      transition("waiting-for-generation");
      try {
        const res = await sendToTab({
          type: "GEMINI_ASSISTANT_WAIT_FOR_GENERATED_IMAGE",
          baseline,
          timeoutMs,
        });
        state.generation = {
          ok: !!(res && res.ok),
          imageSrc: res?.imageSrc ?? null,
          alt: res?.alt ?? null,
          downloadControl: res?.downloadControl ?? null,
          error: res?.error ?? null,
        };
        if (!state.generation.ok) {
          failWith(
            "waiting-for-generation",
            state.generation.error || "Generation failed or timed out.",
          );
          return false;
        }
        return true;
      } catch (e) {
        state.generation = {
          ok: false,
          imageSrc: null,
          alt: null,
          downloadControl: null,
          error: e?.message ?? String(e),
        };
        failWith("waiting-for-generation", state.generation.error);
        return false;
      }
    }

    /**
     * Download the generated image. Caller supplies project-id and
     * basename (already sanitized by output.js).
     *
     * We use chrome.downloads via the background bridge. The orchestrator
     * does not import chrome.*.
     */
    async function download(basename, projectId, mimeOrExt) {
      transition("downloading");
      if (!state.generation || !state.generation.imageSrc) {
        failWith("downloading", "No generated image available to download.");
        return false;
      }
      try {
        const res = await deps.downloadImage({
          imageSrc: state.generation.imageSrc,
          basename,
          projectId,
          mimeOrExt,
          alt: state.generation.alt,
        });
        state.download = {
          ok: !!(res && res.ok),
          downloadId: res?.downloadId ?? null,
          finalFilename: res?.finalFilename ?? null,
          error: res?.error ?? null,
        };
        if (!state.download.ok) {
          failWith(
            "downloading",
            state.download.error || "Download failed.",
          );
          return false;
        }
        transition("complete", { download: state.download });
        return true;
      } catch (e) {
        state.download = {
          ok: false,
          downloadId: null,
          finalFilename: null,
          error: e?.message ?? String(e),
        };
        failWith("downloading", state.download.error);
        return false;
      }
    }

    /**
     * Convenience: Prepare a single task end-to-end up to but not
     * including Send.
     *
     * @param {{ taskId, prompt, resolvedRefs, projectId }} params
     */
    async function prepareTask(params) {
      reset({ id: params?.taskId ?? null });
      if (await ensureImageMode()) {
        if (await attachAll(params.resolvedRefs)) {
          if (await insertPrompt(params.prompt)) {
            markReady();
            return true;
          }
        }
      }
      return false;
    }

    /**
     * Convenience: full Generate pipeline. Caller is expected to have
     * already prepared; orchestrator still runs preflight defensively.
     */
    async function generateTask(params) {
      const baseline = await captureBaseline();
      if (!baseline || !baseline.ok) {
        failWith(
          "preflight",
          baseline?.error || "Could not capture conversation baseline.",
        );
        return false;
      }
      const passed = await preflight({
        taskId: params.taskId,
        promptLength: (params.prompt || "").length,
        resolvedRefs: params.resolvedRefs,
      });
      if (!passed) return false;
      if (!(await send())) return false;
      const timeoutMs =
        typeof params.generationTimeoutMs === "number"
          ? params.generationTimeoutMs
          : 90000;
      if (!(await waitForGeneratedImage(baseline, timeoutMs))) return false;
      if (!(await download(params.basename, params.projectId, params.mimeOrExt))) {
        return false;
      }
      return true;
    }

    return {
      state,
      PHASES,
      reset,
      cancel,
      isActive,
      // Low-level phases (composable):
      ensureImageMode,
      attachAll,
      insertPrompt,
      markReady,
      preflight,
      send,
      captureBaseline,
      waitForGeneratedImage,
      download,
      // High-level flows:
      prepareTask,
      generateTask,
      // Internal — exposed for tests:
      _transition: transition,
      _failWith: failWith,
      _deps: deps,
      _setSendToTab(fn) {
        if (typeof fn !== "function") {
          throw new Error("orchestrator: _setSendToTab expects a function");
        }
        sendToTab = async (message) => {
          try {
            return await fn(message);
          } catch (e) {
            throw new Error(
              `Could not communicate with Gemini content script: ${
                e?.message ?? String(e)
              }`,
            );
          }
        };
      },
    };
  }

  const api = Object.freeze({
    PHASES,
    createOrchestrator,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalScope.GeminiAssistantOrchestrator = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
