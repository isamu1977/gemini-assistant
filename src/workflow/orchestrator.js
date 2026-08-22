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
    "clearing-composer",
    "preparing-image-mode",
    "preparing-attachments",
    "preparing-prompt",
    "ready",
    "waiting-for-uploads",
    "preflight",
    "sending",
    "submitted",
    "waiting-for-generation",
    "generating",
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
      executionId: null,
      preparationSessionId: null,
      preparationSession: null,
      allAttachmentsSettledAt: null,
      readyAt: null,
      generateClickedAt: null,
      baselineCapturedAt: null,
      sendCommandDispatchedAt: null,
      sendClickedAt: null,
      sendButton: null,
      submissionAcknowledgedAt: null,
      submissionEvidence: null,
      generationStartedAt: null,
      generationStartEvidence: null,
      generationCompletedAt: null,
      generationCompletionEvidence: null,
      result: null,
      lastGenerateTrace: [],
    };

    let currentTask = null; // Promise that resolves the in-flight phase.
    // PART 5: Synchronous atomic claim for generation submission.
    // Must be tested and set BEFORE the first await in generateTask.
    // Resets on reset() so a new preparation cycle starts fresh.
    let generationSubmissionClaimed = false;

    function log(level, message, info) {
      try {
        onLog(level, message, info);
      } catch (_) {
        /* ignore */
      }
    }

    function recordGenerateTrace(step, data = {}) {
      const entry = {
        step,
        timestamp: new Date().toISOString(),
        ...data,
      };
      state.lastGenerateTrace.push(entry);
      if (state.lastGenerateTrace.length > 50) state.lastGenerateTrace.shift();
      log("generate", `[generate] ${step}`, data);
    }

    function transition(nextPhase, info) {
      // Allow terminals even when cancelled, so the UI never freezes.
      const isTerminal = nextPhase === "complete" || nextPhase === "error" || nextPhase === "cancelled";
      if (state.cancelled && !isTerminal && nextPhase !== "cancelled") {
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
      state.executionId = null;
      state.preparationSessionId = "prep-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      state.preparationSession = null;
      state.allAttachmentsSettledAt = null;
      state.readyAt = null;
      state.generateClickedAt = null;
      state.baselineCapturedAt = null;
      state.sendCommandDispatchedAt = null;
      state.sendClickedAt = null;
      state.sendButton = null;
      state.submissionAcknowledgedAt = null;
      state.submissionEvidence = null;
      state.generationStartedAt = null;
      state.generationStartEvidence = null;
      state.generationCompletedAt = null;
      state.generationCompletionEvidence = null;
      state.result = null;
      state.lastGenerateTrace = [];
      currentTask = null;
      // Reset the synchronous generation claim so a new preparation can generate.
      generationSubmissionClaimed = false;
      transition("idle", { taskId: state.taskId, preparationSessionId: state.preparationSessionId });
    }

    function cancel() {
      state.cancelled = true;
      try {
        sendToTab({
          type: "GEMINI_ASSISTANT_CANCEL_EXECUTION",
          reason: "user-cancelled",
          executionId: state.executionId,
        }).catch(() => {});
      } catch (_) {}
      transition("cancelled", { phase: state.phase });
      log("warn", "Operation cancelled by user.", { phase: state.phase });
    }

    function isActive() {
      // Defensive: if a phase is reported as active but the orchestrator
      // has already produced a result, treat it as idle. This prevents the
      // side panel from staying stuck if the final `transition("complete")`
      // is somehow skipped (e.g. cancelled-mid-transition, exception
      // swallowed, etc.).
      if (state.result && state.phase === "generating") {
        return false;
      }
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
          executionId: state.executionId,
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

        let arrayBuffer = null;
        let sha256 = "";
        try {
          if (ref.fileObj && typeof ref.fileObj.arrayBuffer === "function") {
            arrayBuffer = await ref.fileObj.arrayBuffer();
            const assetsLib = globalThis.GeminiAssistantAssets || (typeof require === "function" ? require("../lib/assets.js") : null);
            if (assetsLib && typeof assetsLib.computeSha256 === "function") {
              sha256 = await assetsLib.computeSha256(arrayBuffer);
            }
          }
        } catch (_) {}

        const realSize = arrayBuffer ? arrayBuffer.byteLength : ref.fileSize;

        let res;
        try {
          res = await sendToTab({
            type: "GEMINI_ASSISTANT_ATTACH_WITH_MENU",
            file: ref.fileObj,
            arrayBuffer,
            byteArray: arrayBuffer ? Array.from(new Uint8Array(arrayBuffer)) : undefined,
            fileName: ref.fileName,
            fileType: ref.fileType,
            fileSize: realSize,
            sha256,
            lastModified: ref.fileObj?.lastModified,
            executionId: state.executionId,
          });
        } catch (e) {
          res = { ok: false, error: e?.message ?? String(e) };
        }

        const entry = {
          taskId: state.taskId,
          preparationSessionId: state.preparationSessionId,
          assetId: ref.id,
          label: ref.label,
          fileName: ref.fileName,
          ok: !!(res && res.ok),
          chipVisibleAt: res?.chipVisibleAt ?? Date.now(),
          uploadCompleteAt: res?.uploadCompleteAt ?? Date.now(),
          error: res?.error ?? null,
          elapsedMs: res?.elapsedMs ?? null,
          confirmedAt: Date.now(),
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
      state.allAttachmentsSettledAt = Date.now();
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
          executionId: state.executionId,
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
      state.readyAt = Date.now();
      state.preparationSession = {
        id: state.preparationSessionId,
        taskId: state.taskId,
        preparedAt: state.readyAt,
        confirmedReferenceIds: (state.attachments || []).filter((a) => a && a.ok).map((a) => a.assetId),
        promptFingerprint: state.promptInserted?.length ?? null,
      };
      transition("ready", { preparationSessionId: state.preparationSessionId });
    }

    /**
     * Re-verify preflight conditions immediately before Send / Ready transition.
     * Uses Primary Evidence (individual confirmations in current preparation session)
     * and treats live DOM recount discrepancy as non-blocking warning.
     */
    async function preflight(expected) {
      transition("preflight");
      const checks = [];

      // 1. Same task
      const taskMatch = !!state.taskId && state.taskId === expected.taskId;
      checks.push({
        name: "taskId matches",
        ok: taskMatch,
      });

      // 2. Query live composer state
      let composer = null;
      try {
        composer = await sendToTab({
          type: "GEMINI_ASSISTANT_COMPOSER_STATE",
        });
      } catch (e) {
        composer = { ok: false, error: e?.message ?? String(e) };
      }

      const expectedRefCount = Array.isArray(expected.resolvedRefs) ? expected.resolvedRefs.length : 0;
      let actualCount = composer?.attachmentCount ?? 0;

      // 3. Primary Attachment Verification (Session-isolated individual confirmations)
      const confirmedRefsInSession = (state.attachments || []).filter(
        (a) =>
          a &&
          a.ok &&
          a.preparationSessionId === state.preparationSessionId &&
          a.taskId === state.taskId,
      );

      const allConfirmedInSession =
        expectedRefCount === 0 ||
        (confirmedRefsInSession.length === expectedRefCount &&
          (expected.resolvedRefs || []).every((r) => {
            const targetId = r?.id || r?.assetId;
            return confirmedRefsInSession.some((c) => (c.assetId || c.id) === targetId);
          }));

      let attachOk = false;
      let attachMsg = "";
      let isWarning = false;

      if (allConfirmedInSession) {
        attachOk = true;
        if (actualCount === expectedRefCount) {
          attachMsg = `Attachments verified (${expectedRefCount} / ${expectedRefCount})`;
        } else {
          isWarning = true;
          attachMsg = `Attachments confirmed (${expectedRefCount} / ${expectedRefCount}) [Live recount: ${actualCount}]`;
        }
      } else {
        attachOk = false;
        attachMsg = `Expected ${expectedRefCount} attachment(s), confirmed ${confirmedRefsInSession.length}. Missing attachment(s).`;
      }

      checks.push({
        name: attachMsg,
        ok: attachOk,
        warning: isWarning,
        detail: {
          expected: expectedRefCount,
          actual: actualCount,
          confirmed: confirmedRefsInSession.length,
          allConfirmedInSession,
        },
      });

      // 4. Prompt verification
      const expectedText = expected.prompt || "";
      const actualText = composer?.promptText !== undefined ? composer.promptText : "";

      let promptMatch = false;
      if (composer?.promptText !== undefined && expectedText.length > 0 && actualText.length > 0) {
        const projectLibScope = typeof globalScope !== "undefined" ? globalScope?.GeminiAssistantProject : null;
        if (projectLibScope && typeof projectLibScope.verifyPromptContent === "function") {
          promptMatch = projectLibScope.verifyPromptContent(expectedText, actualText).ok;
        } else {
          const normExp = expectedText.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
          const normAct = actualText.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
          promptMatch = normExp === normAct || normExp.replace(/\n{3,}/g, "\n\n") === normAct.replace(/\n{3,}/g, "\n\n");
        }
      } else if (state.promptInserted && state.promptInserted.ok) {
        promptMatch = true;
      } else {
        const expectedLen = expected.promptLength ?? expectedText.length;
        const actualLen = composer?.promptLength ?? 0;
        promptMatch = actualLen === expectedLen || (actualLen > 0 && Math.abs(actualLen - expectedLen) <= 60);
      }

      checks.push({
        name: "prompt present and verified",
        ok: promptMatch,
        detail: {
          expectedLength: expected.promptLength ?? expectedText.length,
          actualLength: composer?.promptLength ?? state.promptInserted?.length ?? null,
          contentMatch: promptMatch,
        },
      });

      // 5. Image Generation mode
      const imageModeOk = (composer && composer.imageModeActive) || (state.imageMode && state.imageMode.ok);
      checks.push({
        name: "Image Generation mode active",
        ok: !!imageModeOk,
        detail: { imageModeActive: !!imageModeOk },
      });

      // 6. Send button available
      let sendBtn = null;
      try {
        sendBtn = await sendToTab({
          type: "GEMINI_ASSISTANT_FIND_SEND_BUTTON",
        });
        if (sendBtn && sendBtn.ok && sendBtn.disabled) {
          const btnStart = Date.now();
          while (Date.now() - btnStart < 600) {
            await sleep(150);
            const recheck = await sendToTab({ type: "GEMINI_ASSISTANT_FIND_SEND_BUTTON" });
            if (recheck && recheck.ok && !recheck.disabled) {
              sendBtn = recheck;
              break;
            }
          }
        }
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
      state.sendCommandDispatchedAt = Date.now();
      try {
        const res = await sendToTab({
          type: "GEMINI_ASSISTANT_SEND_COMPOSER",
          executionId: state.executionId,
        });
        state.send = {
          ok: !!(res && res.ok),
          error: res?.error ?? null,
          evidence: res?.evidence ?? null,
          sendButtonFound: res?.sendButtonFound ?? null,
          sendButtonDisabled: res?.sendButtonDisabled ?? null,
          sendButtonLabel: res?.sendButtonLabel ?? null,
          sendClickAttemptedAt: res?.sendClickAttemptedAt ?? null,
          sendClickedAt: res?.sendClickedAt ?? Date.now(),
        };
        state.sendClickedAt = state.send.sendClickedAt;
        state.sendButton = {
          found: res?.sendButtonFound ?? true,
          disabled: res?.sendButtonDisabled ?? false,
          label: res?.sendButtonLabel ?? null,
        };
        if (!state.send.ok) {
          failWith("sending", state.send.error || "Send failed.", { send: state.send });
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
        if (res && res.ok) {
          state.baselineCapturedAt = Date.now();
        }
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
          executionId: state.executionId,
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

    async function inspectComposer(expectedPrompt, expectedRefCount) {
      try {
        return await sendToTab({
          type: "GEMINI_ASSISTANT_INSPECT_COMPOSER",
          expectedPrompt,
          expectedRefCount,
        });
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    }

    async function clearComposer() {
      try {
        return await sendToTab({
          type: "GEMINI_ASSISTANT_CLEAR_COMPOSER",
        });
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    }

    async function resetPreparation(task) {
      reset(task);
      try {
        await clearComposer();
      } catch (_) {}
      transition("idle", { taskId: task?.id ?? null, reset: true });
      return true;
    }

    /**
     * Convenience: Prepare a single task end-to-end up to but not
     * including Send, stopping at "ready" for human review.
     *
     * @param {{ taskId, prompt, resolvedRefs, projectId, forceClear?, checkComposer? }} params
     */
    async function prepareTask(params) {
      reset({ id: params?.taskId ?? null });

      if (!params || !params.taskId) {
        failWith("preparing-task", "Cannot prepare task: missing taskId.");
        return false;
      }

      state.executionId = "exec-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      try {
        const startRes = await sendToTab({
          type: "GEMINI_ASSISTANT_START_EXECUTION",
          executionId: state.executionId,
          taskId: params.taskId,
          preparationSessionId: state.preparationSessionId,
          force: true,
        });
        if (startRes && !startRes.ok && startRes.reason === "execution-already-active") {
          failWith("preparing-task", "An execution is already active in Gemini. Reset preparation or cancel first.");
          return false;
        }
      } catch (_) {}

      if (!isString(params.prompt)) {
        failWith("preparing-task", "Cannot prepare task: missing prompt string.");
        return false;
      }

      const refs = Array.isArray(params.resolvedRefs) ? params.resolvedRefs : [];
      const unresolved = refs.filter((r) => !r || r.state !== "resolved" || !r.fileObj);
      if (unresolved.length > 0) {
        const missingLabels = unresolved.map((r) => r?.label || r?.id || "unknown").join(", ");
        failWith(
          "preparing-attachments",
          `Cannot prepare task. ${refs.length - unresolved.length} / ${refs.length} references resolved. Missing: ${missingLabels}`,
          { unresolvedCount: unresolved.length, totalCount: refs.length },
        );
        return false;
      }

      if (params.forceClear === true) {
        transition("clearing-composer");
        const clearRes = await clearComposer();
        if (!clearRes || !clearRes.ok || (clearRes.attachmentCount !== undefined && clearRes.attachmentCount > 0)) {
          failWith(
            "composer-cleanup",
            `Composer cleanup failed: ${clearRes?.attachmentCount || 0} previous attachment(s) remain.`,
            { clearResult: clearRes },
          );
          return false;
        }
      } else if (params.checkComposer !== false) {
        const inspection = await inspectComposer(params.prompt, refs.length);
        if (inspection && inspection.ok && inspection.needsConfirmation) {
          failWith(
            "composer-inspection",
            "Composer contains existing manual content.",
            { inspection, needsConfirmation: true },
          );
          return false;
        }
      }

      if (await ensureImageMode()) {
        if (await attachAll(refs)) {
          if (await insertPrompt(params.prompt)) {
            const preflightOk = await preflight({
              taskId: params.taskId,
              promptLength: params.prompt.length,
              resolvedRefs: refs,
            });
            if (preflightOk) {
              markReady();
              return true;
            }
          }
        }
      }
      return false;
    }

    /**
     * One-shot detection retry: attempts to find the new result without resending.
     */
    async function retryDetection(baseline) {
      try {
        const res = await sendToTab({
          type: "GEMINI_ASSISTANT_FIND_NEW_RESULT",
          baseline: baseline || state.baseline,
        });
        if (res && res.ok && res.imageSrc) {
          state.generation = {
            ok: true,
            imageSrc: res.imageSrc,
            alt: res.alt ?? null,
            downloadControl: res.downloadControl ?? null,
            error: null,
          };
          transition("generated", { generation: state.generation });
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    }

    async function detectGenerationStart(baseline, timeoutMs) {
      try {
        const res = await sendToTab({
          type: "GEMINI_ASSISTANT_DETECT_GENERATION_START",
          baseline,
          timeoutMs,
        });
        return res;
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    }

    /**
     * Convenience: full Generate pipeline for this milestone.
     * Preflight -> Capture Baseline -> Send -> Acknowledge -> Detect Generation Start -> GENERATING IMAGE.
     */
    async function generateTask(params) {
      // PART 5 — Synchronous atomic claim. This MUST be the very first operation,
      // before any await. Even if two UI calls race in the same microtask, only
      // the first one claims; the second is rejected synchronously.
      if (generationSubmissionClaimed) {
        recordGenerateTrace("blocked", {
          reason: "generate-already-claimed",
          commandId: params?.commandId ?? null,
          phase: state.phase,
          taskId: params?.taskId,
          preparationSessionId: state.preparationSessionId,
        });
        log("warn", "Generation submission already claimed for this execution.");
        return { ok: false, reason: "generate-already-claimed" };
      }
      generationSubmissionClaimed = true;

      // Zombie-coroutine guard: capture the session ID at entry.
      // After any long await, if the session changed (new prepareTask was called),
      // the coroutine silently bails without mutating the new session's state.
      const mySessionId = state.preparationSessionId;

      state.generateClickedAt = Date.now();
      recordGenerateTrace("orchestrator-called", {
        commandId: params?.commandId ?? null,
        taskId: params?.taskId,
        currentPhase: state.phase,
        preparationSessionId: state.preparationSessionId,
        preparedSessionId: state.preparationSession?.id,
        preparedTaskId: state.preparationSession?.taskId,
      });

      // 1. Generation lock & single-shot send per execution
      if (state.sendCommandDispatchedAt) {
        recordGenerateTrace("blocked", {
          reason: "already-submitted",
          commandId: params?.commandId ?? null,
          phase: state.phase,
          taskId: params?.taskId,
          preparationSessionId: state.preparationSessionId,
        });
        log("warn", "Task already submitted for this execution.");
        return false;
      }

      if (["sending", "submitted", "waiting-for-generation", "generating", "downloading"].includes(state.phase)) {
        recordGenerateTrace("blocked", {
          reason: "generation-already-running",
          phase: state.phase,
          taskId: params?.taskId,
          preparedTaskId: state.preparationSession?.taskId,
          preparationSessionId: state.preparationSessionId,
        });
        log("warn", "Generation already in progress, ignoring duplicate call.");
        return false;
      }

      if (!params || !params.taskId) {
        recordGenerateTrace("blocked", {
          reason: "missing-task-id",
          phase: state.phase,
          taskId: params?.taskId,
          preparedTaskId: state.preparationSession?.taskId,
          preparationSessionId: state.preparationSessionId,
        });
        failWith("preflight", "Generate blocked: Missing taskId.");
        return false;
      }

      if (state.phase !== "ready" && state.phase !== "waiting-for-uploads") {
        recordGenerateTrace("blocked", {
          reason: "phase-not-ready",
          phase: state.phase,
          taskId: params.taskId,
          preparedTaskId: state.preparationSession?.taskId,
          preparationSessionId: state.preparationSessionId,
        });
        failWith("preflight", "Generate blocked: Task is not in READY TO GENERATE state.");
        return false;
      }

      if (
        !state.preparationSession ||
        state.preparationSession.id !== state.preparationSessionId ||
        state.preparationSession.taskId !== params.taskId
      ) {
        recordGenerateTrace("blocked", {
          reason: "missing-preparation-session",
          phase: state.phase,
          taskId: params.taskId,
          preparedTaskId: state.preparationSession?.taskId,
          preparationSessionId: state.preparationSessionId,
          preparedSessionId: state.preparationSession?.id,
        });
        failWith(
          "preflight",
          "Generate blocked: Preparation session is stale or does not match current task.",
        );
        return false;
      }

      // Probe live composer & send button state at click time
      let composerState = null;
      try {
        composerState = await sendToTab({ type: "GEMINI_ASSISTANT_COMPOSER_STATE" });
      } catch (_) {}

      let sendBtnState = null;
      try {
        sendBtnState = await sendToTab({ type: "GEMINI_ASSISTANT_FIND_SEND_BUTTON" });
      } catch (_) {}

      const expectedRefCount = Array.isArray(params.resolvedRefs) ? params.resolvedRefs.length : 0;
      const confirmedRefsInSession = (state.attachments || []).filter(
        (a) => a && a.ok && a.preparationSessionId === state.preparationSessionId,
      );
      const activeUploads = composerState?.pendingUploadCount ?? 0;
      const composerTextPresent = (composerState?.promptLength ?? 0) > 0 || (params.prompt || "").length > 0;
      const sendButtonFound = !!(sendBtnState && sendBtnState.ok && sendBtnState.found !== false);
      const sendButtonDisabled = !!(sendBtnState && sendBtnState.disabled);
      const imageModeActive = !!(composerState && composerState.imageModeActive) || !!(state.imageMode && state.imageMode.ok);

      recordGenerateTrace("click-state-probe", {
        expectedAttachments: expectedRefCount,
        confirmedAttachments: confirmedRefsInSession.length,
        activeUploads,
        composerTextPresent,
        sendButtonFound,
        sendButtonDisabled,
        imageModeActive,
      });

      // If activeUploads > 0, do NOT silently exit or fail! Wait bounded settlement window
      if (activeUploads > 0) {
        log("info", "Waiting for reference uploads to finish...");
        transition("waiting-for-uploads", { activeUploads });
        const settleStart = Date.now();
        const SETTLE_TIMEOUT_MS = 12000;
        let settled = false;
        while (Date.now() - settleStart < SETTLE_TIMEOUT_MS) {
          await sleep(250);
          try {
            const reProbe = await sendToTab({ type: "GEMINI_ASSISTANT_COMPOSER_STATE" });
            if (reProbe && reProbe.ok && reProbe.pendingUploadCount === 0) {
              settled = true;
              break;
            }
          } catch (_) {}
        }
        if (!settled) {
          recordGenerateTrace("blocked", {
            reason: "uploads-settle-timeout",
            activeUploads,
          });
          failWith("preflight", "Reference uploads did not finish in time.");
          return false;
        }
        transition("ready", { settled: true });
      }

      // 2. Strict preflight before clicking Send
      const passed = await preflight({
        taskId: params.taskId,
        promptLength: (params.prompt || "").length,
        prompt: params.prompt,
        resolvedRefs: params.resolvedRefs,
      });
      if (!passed) {
        recordGenerateTrace("blocked", {
          reason: "preflight-failed",
          phase: state.phase,
          taskId: params.taskId,
          preparedTaskId: state.preparationSession?.taskId,
          preparationSessionId: state.preparationSessionId,
          preflight: state.preflight,
        });
        return false;
      }
      recordGenerateTrace("preflight-passed", { taskId: params.taskId });

      // 3. Capture baseline immediately before send
      const baselineRes = await captureBaseline();
      if (!baselineRes || !baselineRes.ok) {
        recordGenerateTrace("blocked", {
          reason: "baseline-capture-failed",
          phase: state.phase,
          taskId: params.taskId,
          error: baselineRes?.error,
        });
        failWith(
          "preflight",
          baselineRes?.error || "Could not capture conversation baseline.",
        );
        return false;
      }
      const baseline = baselineRes.baseline;
      state.baseline = baseline;
      recordGenerateTrace("baseline-captured", {
        baselineCapturedAt: state.baselineCapturedAt,
        baseline,
      });

      // 4. Send (click Gemini Send exactly once)
      recordGenerateTrace("send-command-dispatched", {
        sendCommandDispatchedAt: Date.now(),
      });
      if (!(await send())) {
        recordGenerateTrace("blocked", {
          reason: "send-failed",
          phase: state.phase,
          taskId: params.taskId,
          error: state.send?.error,
        });
        return false;
      }
      recordGenerateTrace("send-clicked", {
        sendClickedAt: state.sendClickedAt,
        sendButton: state.sendButton,
      });

      // 5. Submission acknowledgement
      state.submissionAcknowledgedAt = Date.now();
      state.submissionEvidence = state.send?.evidence || "acknowledged";
      recordGenerateTrace("submission-acknowledged", {
        submissionAcknowledgedAt: state.submissionAcknowledgedAt,
        evidence: state.submissionEvidence,
      });
      transition("submitted", { evidence: state.submissionEvidence });

      // 6. Detect that image generation started
      transition("waiting-for-generation");
      const timeoutMs =
        typeof params.generationStartTimeoutMs === "number"
          ? params.generationStartTimeoutMs
          : 15000;
      const startRes = await detectGenerationStart(baseline, timeoutMs);
      if (!startRes || !startRes.ok) {
        recordGenerateTrace("blocked", {
          reason: "generation-start-timeout",
          phase: state.phase,
          taskId: params.taskId,
          error: startRes?.error,
        });
        failWith(
          "waiting-for-generation",
          startRes?.error || "Generation-start timeout: Gemini did not start image generation.",
        );
        return false;
      }

      // 7. Transition to GENERATING
      state.generationStartedAt = Date.now();
      state.generationStartEvidence = startRes.evidence;
      recordGenerateTrace("generation-started", {
        generationStartedAt: state.generationStartedAt,
        evidence: state.generationStartEvidence,
      });
      transition("generating", {
        evidence: startRes.evidence,
        startedAt: state.generationStartedAt,
      });

      // 8. Detect generation complete
      const compTimeoutMs =
        typeof params.generationTimeoutMs === "number"
          ? params.generationTimeoutMs
          : 90000;
      let compRes = null;
      try {
        compRes = await sendToTab({
          type: "GEMINI_ASSISTANT_WAIT_FOR_GENERATED_IMAGE",
          baseline,
          timeoutMs: compTimeoutMs,
          executionId: state.executionId,
        });
      } catch (e) {
        compRes = { ok: false, error: e?.message ?? String(e) };
      }

      // Zombie-coroutine guard: if a new prepareTask was called while we were
      // awaiting WAIT_FOR_GENERATED_IMAGE (which can take up to 90s), the
      // preparationSessionId will have changed. Force a terminal transition so
      // the side panel's `busy` flag is cleared even on this branch, then
      // return a SILENT bail object so the actively-generating new session can
      // keep its UI intact without overwriting it.
      if (state.preparationSessionId !== mySessionId) {
        log("warn", "generateTask: session changed during WAIT_FOR_GENERATED_IMAGE (zombie coroutine). Bailing.", {
          mySessionId,
          currentSessionId: state.preparationSessionId,
        });
        // Cancel our own coroutine so the orchestrator's state machine is
        // not stuck in `generating` forever. The active new session owns
        // the UI from this point on; we only need to release the busy
        // lock so the side panel does not freeze.
        state.cancelled = false;
        transition("complete", {
          zombie: true,
          zombieReason: "session-changed-during-wait",
          mySessionId,
          currentSessionId: state.preparationSessionId,
        });
        return { ok: false, reason: "zombie-bail", silent: true };
      }

      if (!compRes || !compRes.ok) {
        recordGenerateTrace("blocked", {
          reason: "generation-completion-timeout",
          phase: state.phase,
          taskId: params.taskId,
          error: compRes?.error,
        });
        failWith(
          "generating",
          compRes?.error || "Generation timed out before image finished loading.",
        );
        return false;
      }

      state.generationCompletedAt = Date.now();
      state.generationCompletionEvidence = compRes;
      state.result = {
        imageSrc: compRes.imageSrc,
        alt: compRes.alt,
        score: compRes.score,
        naturalWidth: compRes.naturalWidth,
        naturalHeight: compRes.naturalHeight,
        downloadControl: compRes.downloadControl,
        filename: `${params.taskId}.png`,
      };
      recordGenerateTrace("generation-completed", {
        generationCompletedAt: state.generationCompletedAt,
        evidence: state.generationCompletionEvidence,
      });
      transition("complete", {
        result: state.result,
        completedAt: state.generationCompletedAt,
      });
      try {
        await sendToTab({
          type: "GEMINI_ASSISTANT_CANCEL_EXECUTION",
          reason: "completed",
          executionId: state.executionId,
        });
      } catch (_) {}
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
      inspectComposer,
      clearComposer,
      resetPreparation,
      retryDetection,
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
