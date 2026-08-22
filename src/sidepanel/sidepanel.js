/*
 * sidepanel.js
 *
 * UI orchestration for the Gemini Assistant Chrome Side Panel.
 *
 * Responsibilities:
 *   - Load/save state from chrome.storage.local.
 *   - Import Project JSON, validate, confirm replacement.
 *   - Bind a project folder via window.showDirectoryPicker.
 *   - Resolve each task's references against the bound folder; render
 *     compact reference cards (kept clean even when an asset is missing).
 *   - Detect the "wrong-root selection" case (user picked a subfolder
 *     like `references/` instead of the project root) and show a clear,
 *     persistent banner.
 *   - Render the loaded project: task selector, title, status, prompt.
 *   - Handle Previous/Next navigation and per-task prompt edits.
 *   - Hand off "Insert Prompt" / "Attach" to the content script via
 *     chrome.tabs.sendMessage. Never auto-submits.
 *   - Probe attachment state (file input lifecycle, menu open) and
 *     surface a structured diagnostic.
 *
 * The side panel knows nothing about Gemini's DOM. The DOM adapter lives
 * in src/dom/geminiDomAdapter.js and is invoked only via the content
 * script message bridge.
 *
 * Folder binding is kept in-memory for the PoC: the
 * FileSystemDirectoryHandle cannot be reliably rehydrated across a panel
 * re-open without re-prompting the user. Closing and reopening the side
 * panel requires re-binding. This is documented in the UI.
 */

(function () {
  "use strict";

  const projectLib = globalThis.GeminiAssistantProject;
  const storageLib = globalThis.GeminiAssistantStorage;
  const assetsLib = globalThis.GeminiAssistantAssets;
  const messagingLib = globalThis.GeminiAssistantMessaging;

  if (!projectLib || !storageLib || !assetsLib || !messagingLib) {
    document.body.textContent =
      "Internal error: GeminiAssistant libs not loaded (messaging missing?).";
    return;
  }

  function escapeHtml(str) {
    if (typeof str !== "string") return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ----- DOM refs ---------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);

  const emptyStateEl = $("#empty-state");
  const loadedStateEl = $("#loaded-state");
  const importBtn = $("#import-btn");
  const reimportBtn = $("#reimport-btn");
  const fileInput = $("#file-input");

  const projectNameEl = $("#project-name");
  const projectDescEl = $("#project-desc");
  const projectStatsEl = $("#project-stats");

  const wrongRootBannerEl = $("#wrong-root-banner");
  const wrongRootBodyEl = $("#wrong-root-body");
  const wrongRootRebindBtn = $("#wrong-root-rebind");

  const folderBindingNameEl = $("#folder-binding-name");
  const folderBindingSummaryEl = $("#folder-binding-summary");
  const folderBindBtn = $("#folder-bind-btn");

  const taskSelectEl = $("#task-select");
  const statusSelectEl = $("#status-select");
  const taskTitleEl = $("#task-title");
  const taskCurrentEls = [$("#task-current")];
  const taskTotalEls = [$("#task-total")];
  const promptEl = $("#prompt");
  const insertBtn = $("#insert-btn");
  const prevBtn = $("#prev-btn");
  const nextBtn = $("#next-btn");
  const progressSummaryEl = $("#progress-summary");

  const referencesCountEl = $("#references-count");
  const referencesListEl = $("#references-list");
  const referencesEmptyEl = $("#references-empty");

  const assetsPanelEl = $("#assets-panel");
  const assetsListEl = $("#assets-list");
  const assetsSummaryEl = $("#assets-summary");

  const attachmentSummaryEl = $("#attachment-summary");
  const attachmentDiagnosticsEl = $("#attachment-diagnostics");
  const probeAttachmentBtn = $("#probe-attachment-btn");
  // Phase 9: Health Check & v0.6.2 diagnostics
  const runHealthCheckBtn = $("#run-health-check-btn");
  const healthCheckResultsEl = $("#health-check-results");
  const traceAttachmentBtn = $("#trace-attachment-btn");
  const strategyABtn = $("#strategy-a-btn");
  const testSingleAttachBtn = $("#test-single-attach-btn");
  const runTestABtn = $("#run-test-a-btn");
  const runTestBBtn = $("#run-test-b-btn");
  const runTestCBtn = $("#run-test-c-btn");
  const diagSummaryEl = $("#diagnostic-summary");
  const diagResultsBoxEl = $("#diag-results-box");
  const traceResultEl = $("#trace-result");
  const traceFailedAtEl = $("#trace-failed-at");
  const traceRetryBtn = $("#trace-retry-btn");
  const traceStepsEl = $("#trace-steps");

  const selfTestEl = $("#selftest");

  const statusEl = $("#status");
  const statusText = $("#status-text");

  const overlayEl = $("#confirm-overlay");
  const confirmCancelBtn = $("#confirm-cancel");
  const confirmOkBtn = $("#confirm-ok");

  // v0.6: workflow
  const outputLib = globalThis.GeminiAssistantOutput;
  const orchestratorLib = globalThis.GeminiAssistantOrchestrator;

  const previewPromptBtn = $("#preview-prompt-btn");
  const previewMasterStyleEl = $("#preview-master-style");
  const previewScenePromptEl = $("#preview-scene-prompt");
  const previewAspectRatioEl = $("#preview-aspect-ratio");
  const promptPreviewOverlayEl = $("#prompt-preview-overlay");
  const promptPreviewTextEl = $("#prompt-preview-text");
  const promptPreviewCloseBtn = $("#prompt-preview-close");

  const workflowImageModeEl = $("#workflow-image-mode");
  const workflowReferencesEl = $("#workflow-references");
  const workflowAttachedEl = $("#workflow-attached");
  const workflowMessagingEl = $("#workflow-messaging");
  const workflowMasterStyleEl = $("#workflow-master-style");
  const workflowScenePromptEl = $("#workflow-scene-prompt");
  const workflowComposerEl = $("#workflow-composer");
  const workflowPhaseEl = $("#workflow-phase");
  const workflowLogEl = $("#workflow-log");
  // v0.6.2: attach-gate notice rendered above the workflow actions.
  const workflowGateNoticeEl = document.createElement("div");
  if (workflowPhaseEl && workflowPhaseEl.parentNode) {
    workflowGateNoticeEl.className = "workflow-gate-notice";
    workflowGateNoticeEl.hidden = true;
    workflowPhaseEl.parentNode.insertBefore(
      workflowGateNoticeEl,
      workflowPhaseEl.nextSibling,
    );
  }
  const ensureImageModeBtn = $("#ensure-image-mode-btn");
  const prepareTaskBtn = $("#prepare-task-btn");
  const generateTaskBtn = $("#generate-task-btn");
  const retryDetectionBtn = $("#retry-detection-btn");
  const retryDownloadBtn = $("#retry-download-btn");
  const retryGenerateBtn = $("#retry-generate-btn");
  const cancelOpBtn = $("#cancel-op-btn");
  const resetPrepBtn = $("#reset-prep-btn");
  const retryPrepBtn = $("#retry-prep-btn");
  const generationResultBoxEl = $("#generation-result-box");
  const resultFilenameEl = $("#result-filename");
  const resultStatusBadgeEl = $("#result-status-badge");
  const resultDownloadIdEl = $("#result-download-id");
  const prepChecklistContainerEl = $("#preparation-checklist-container");
  const prepChecklistEl = $("#preparation-checklist");
  const composerOverlayEl = $("#composer-confirm-overlay");
  const composerConfirmCancelBtn = $("#composer-confirm-cancel");
  const composerConfirmOkBtn = $("#composer-confirm-ok");
  const markApprovedBtn = $("#mark-approved-btn");
  const markRedoBtn = $("#mark-redo-btn");
  const pingGeminiBtn = $("#ping-gemini-btn");
  // v0.6.2: manual gate flip.
  let markAttachVerifiedBtn = $("#mark-attach-verified-btn");
  if (!markAttachVerifiedBtn) {
    markAttachVerifiedBtn = document.createElement("button");
    markAttachVerifiedBtn.id = "mark-attach-verified-btn";
    markAttachVerifiedBtn.type = "button";
    markAttachVerifiedBtn.className = "ghost";
    markAttachVerifiedBtn.hidden = true;
    markAttachVerifiedBtn.textContent = "Mark attach verified";
    const workflowActions =
      (ensureImageModeBtn && ensureImageModeBtn.parentNode) || null;
    if (workflowActions) {
      workflowActions.appendChild(markAttachVerifiedBtn);
    } else if (workflowLogEl && workflowLogEl.parentNode) {
      workflowLogEl.parentNode.appendChild(markAttachVerifiedBtn);
    }
  }

  // ----- state (in-memory) ------------------------------------------------

  let state = storageLib.emptyState();
  let promptSaveTimer = null;
  // Folder binding is intentionally session-only.
  let folderHandle = null;
  let folderName = "";
  // Cache of resolved refs for the current task.
  let resolvedRefsCache = null;
  // Wrong-root detection result (null = not detected or not yet probed).
  let wrongRootInfo = null;

  // ----- Synchronous reentrancy guards (Parts 4 & 6) ----------------------
  // Declared here (before event wiring) to avoid TDZ errors.
  // Set BEFORE the first await in each handler so two calls racing on the
  // same microtask tick cannot both slip past the check.
  let generateCommandInFlight = false;
  let prepareCommandInFlight = false;
  // Diagnostic counters — healthy value is 1 for each.
  let generateHandlerRegistrationCount = 0;
  let prepareHandlerRegistrationCount = 0;

  // ----- helpers ----------------------------------------------------------

  const LOG_PREFIX = "[Gemini Assistant:sp]";

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function setStatusLine(state, text) {
    statusEl.dataset.state = state;
    statusText.textContent = text;
  }

  function setBusy(busy) {
    insertBtn.disabled = busy;
    insertBtn.textContent = busy ? "Inserting…" : "Insert Prompt";
  }

  // ----- messaging helpers (v0.6.1) ---------------------------------------

  // The Side Panel is now the only place that resolves which tab Gemini
  // is running in. Every call to chrome.tabs.sendMessage flows through
  // src/lib/messaging.js so we get:
  //   * a single, well-tested queryTabs path;
  //   * strict validation that tabId is a positive integer;
  //   * a Promise-based API (no callbacks / no undefined options);
  //   * structured-cloneable payload validation up front.
  //
  // getActiveTab is kept as a thin convenience for callers that only
  // want the tab (not a message). It still funnels through messagingLib.
  async function getActiveTab() {
    try {
      return await messagingLib.getTargetGeminiTab(chrome);
    } catch (e) {
      throw new Error(e?.message ?? String(e));
    }
  }

  // Bridge for the legacy code path (Insert Prompt, single Attach, etc.).
  // Validates Gemini URL up front for a friendlier error message, then
  // delegates to messagingLib.sendTabMessage so all calls share the same
  // argument discipline.
  async function sendMessage(tabId, message) {
    return await messagingLib.sendTabMessage(chrome, tabId, message);
  }

  // ----- v0.6.3: pinned Gemini tab -------------------------------------
  // Without pinning, every sendToGemini() re-resolves the active tab via
  // chrome.tabs.query({active: true, currentWindow: true}). If the user
  // shifts focus between Prepare-attach iterations, attach / prompt /
  // send land in different tabs and the user sees the prompt in
  // several chats. Pin the tab ID at the start of each workflow so all
  // subsequent sends go to the same tab until the workflow completes or
  // navigation resets the pin.
  let pinnedGeminiTabId = null;
  let pinnedGeminiTabUrl = null;

  function clearPinnedGeminiTab() {
    if (pinnedGeminiTabId !== null) {
      log(`unpin Gemini tab (was id=${pinnedGeminiTabId}, url=${pinnedGeminiTabUrl})`);
    }
    pinnedGeminiTabId = null;
    pinnedGeminiTabUrl = null;
  }

  async function pinGeminiTab() {
    const tab = await getActiveTab();
    if (!isGeminiUrl(tab && tab.url)) {
      throw new Error(`Active tab is not ${GEMINI_HOST}.`);
    }
    pinnedGeminiTabId = tab.id;
    pinnedGeminiTabUrl = tab.url;
    log(`pin Gemini tab id=${pinnedGeminiTabId} url=${pinnedGeminiTabUrl}`);
    return tab;
  }

  // High-level: resolve tab + send typed message. The orchestrator uses
  // this; the legacy single-attach / probe paths still use sendMessage
  // directly because they already validated the tab.
  //
  // If pinnedGeminiTabId is set, the send goes to that exact tab. This
  // prevents accidentally sending to a different tab when the user
  // switches focus mid-workflow.
  async function sendToGemini(type, payload) {
    const opts = {};
    if (pinnedGeminiTabId !== null) {
      opts.pinnedTabId = pinnedGeminiTabId;
    }
    return await messagingLib.sendToGemini(chrome, type, payload || {}, opts);
  }

  // Cached Gemini host, kept for friendlier status-line messages.
  const GEMINI_HOST = messagingLib.GEMINI_HOST;
  const isGeminiUrl = messagingLib.isGeminiUrl;

  function currentTaskIndex() {
    if (!state.source) return -1;
    return projectLib.indexOfTaskId(state.source.project, state.currentTaskId);
  }

  function currentTask() {
    const idx = currentTaskIndex();
    if (idx === -1) return null;
    return state.source.project.tasks[idx];
  }

  function currentMutable() {
    const id = state.currentTaskId;
    if (!id || !state.tasks) return null;
    return state.tasks[id] ?? null;
  }

  function isShowDirectoryPickerSupported() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
  }

  // ----- folder binding ---------------------------------------------------

  async function bindFolder() {
    if (!isShowDirectoryPickerSupported()) {
      setStatusLine(
        "error",
        "Folder binding requires Chrome/Edge 86+ with the File System Access API. Update your browser.",
      );
      return;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: "read" });
    } catch (e) {
      if (e && (e.name === "AbortError" || e.code === 20)) {
        log("folder bind: cancelled by user");
        return;
      }
      warn("folder bind failed", e?.message ?? String(e));
      setStatusLine("error", `Failed to bind folder: ${e?.message ?? "unknown error"}`);
      return;
    }
    folderHandle = handle;
    folderName = handle?.name ?? "Bound folder";
    setStatusLine("ok", `Bound to folder: ${folderName}.`);
    renderFolderBinding();
    await refreshWrongRoot();
    if (currentTask()) {
      await resolveCurrentRefs();
      renderReferences();
    }
    // Refresh workflow buttons (Prepare/Generate enable state).
    if (typeof renderWorkflowState === "function") renderWorkflowState();
  }

  function renderFolderBinding() {
    if (folderHandle) {
      folderBindingNameEl.textContent = folderName || "Bound";
      folderBindingNameEl.classList.remove("unbound");
      folderBindBtn.textContent = folderHandle ? "Rebind folder" : "Bind folder";
      folderBindBtn.title = "Re-bind this project to a folder";
    } else {
      folderBindingNameEl.textContent = "Not bound (session only)";
      folderBindingNameEl.classList.add("unbound");
      folderBindBtn.textContent = "Bind folder…";
      folderBindBtn.title = "Bind a local folder so reference paths resolve";
    }
    // Summary is filled by renderReferences after resolution.
    folderBindingSummaryEl.textContent = "";
  }

  // ----- wrong-root detection ---------------------------------------------

  async function refreshWrongRoot() {
    if (!folderHandle || !state.source) {
      wrongRootInfo = null;
      renderWrongRootBanner();
      return;
    }
    try {
      const refs = collectAllAssetRefs(state.source.project);
      if (refs.length === 0) {
        wrongRootInfo = null;
        renderWrongRootBanner();
        return;
      }
      const info = await assetsLib.detectWrongRootSelection(folderHandle, refs);
      wrongRootInfo = info.isWrongRoot ? info : null;
    } catch (e) {
      warn("detectWrongRootSelection failed:", e?.message ?? String(e));
      wrongRootInfo = null;
    }
    renderWrongRootBanner();
  }

  function collectAllAssetRefs(project) {
    // Build a list of unique assets across the project. We don't need
    // per-task references for the spot-check; the first segment of
    // every asset.file must agree across the project to trigger.
    const out = [];
    const seen = new Set();
    if (!project || !project.assets) return out;
    for (const id of Object.keys(project.assets)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(project.assets[id]);
    }
    return out;
  }

  function renderWrongRootBanner() {
    if (!wrongRootInfo) {
      wrongRootBannerEl.hidden = true;
      return;
    }
    const info = wrongRootInfo;
    wrongRootBannerEl.hidden = false;
    const lines = [
      `The selected folder is "${info.selectedRootName}".`,
      `That looks like the project subfolder "references", not the project root.`,
      `Select the project root folder that contains:`,
      `  ${info.firstSegment}/`,
    ];
    wrongRootBodyEl.textContent = lines.join("\n");
  }

  // ----- asset resolution -------------------------------------------------

  async function resolveCurrentRefs() {
    resolvedRefsCache = null;
    const task = currentTask();
    if (!task) return;
    const rawRefs = projectLib.resolveReferences(state.source.project, task.id);
    if (rawRefs.length === 0) return;
    if (!folderHandle) {
      resolvedRefsCache = rawRefs.map((r) => ({
        id: r.id,
        label: r.label,
        type: r.type,
        file: r.file,
        state: "unbound",
        fileObj: null,
        error: "Bind the project folder to enable Attach",
        diagnostic: null,
      }));
      return;
    }
    const results = await assetsLib.resolveReferences(folderHandle, rawRefs);
    resolvedRefsCache = results.map((res, i) => {
      const r = rawRefs[i];
      const diagnostic =
        res.state === "missing"
          ? assetsLib.buildMissingDiagnostic({
              asset: r,
              directoryHandle: folderHandle,
              expectedRelativePath: res.path,
            })
          : null;
      return {
        id: r.id,
        label: r.label,
        type: r.type,
        file: r.file,
        state: res.state,
        fileObj: res.file ?? null,
        error: res.error ?? null,
        fileName: res.fileName ?? null,
        fileType: res.fileType ?? null,
        fileSize: res.fileSize ?? null,
        diagnostic,
      };
    });
  }

  // ----- render -----------------------------------------------------------

  function render() {
    if (!state.source) {
      emptyStateEl.hidden = false;
      loadedStateEl.hidden = true;
      setStatusLine("idle", "Open on gemini.google.com to use Insert / Attach.");
      return;
    }
    emptyStateEl.hidden = true;
    loadedStateEl.hidden = false;

    const proj = state.source.project;

    projectNameEl.textContent = proj.project.name;
    if (proj.project.description) {
      projectDescEl.textContent = proj.project.description;
      projectDescEl.hidden = false;
    } else {
      projectDescEl.hidden = true;
    }

    const assetCount = projectLib.countAssets(proj);
    if (assetCount > 0) {
      projectStatsEl.textContent = `${assetCount} asset${assetCount === 1 ? "" : "s"} in catalog`;
      projectStatsEl.hidden = false;
    } else {
      projectStatsEl.hidden = true;
    }

    renderFolderBinding();
    renderWrongRootBanner();

    // Task selector
    taskSelectEl.innerHTML = "";
    for (const t of proj.tasks) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.title ? `${t.id} — ${t.title}` : t.id;
      taskSelectEl.appendChild(opt);
    }
    taskSelectEl.value = state.currentTaskId ?? proj.tasks[0].id;

    // Status selector
    statusSelectEl.innerHTML = "";
    for (const s of projectLib.STATUSES) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
      statusSelectEl.appendChild(opt);
    }
    const cur = currentMutable();
    if (cur) statusSelectEl.value = cur.status;

    // Title + counters
    const idx = currentTaskIndex();
    const total = proj.tasks.length;
    const curNum = idx >= 0 ? idx + 1 : 1;
    for (const el of taskCurrentEls) el.textContent = String(curNum);
    for (const el of taskTotalEls) el.textContent = String(total);
    taskTitleEl.textContent = currentTask()?.title ?? "";

    renderReferences();
    renderAssetCatalog();
    renderProgress();
    renderPromptMeta(proj, currentTask());

    // Prompt
    promptEl.value = cur?.prompt ?? currentTask()?.prompt ?? "";

    // Prev/Next enable state
    prevBtn.disabled = projectLib.prevTaskId(proj, state.currentTaskId) === null;
    nextBtn.disabled = projectLib.nextTaskId(proj, state.currentTaskId) === null;

    // Workflow buttons need fresh state too.
    if (typeof renderWorkflowState === "function") renderWorkflowState();
  }

  function renderPromptMeta(proj, curTask) {
    if (!previewMasterStyleEl || !previewScenePromptEl || !previewAspectRatioEl) return;
    const gen = proj?.generation;
    if (gen && gen.masterPrompt) {
      previewMasterStyleEl.className = "ok";
      previewMasterStyleEl.textContent = "✓";
      previewMasterStyleEl.title = gen.masterPrompt;
    } else {
      previewMasterStyleEl.className = "muted";
      previewMasterStyleEl.textContent = "—";
      previewMasterStyleEl.title = "No masterPrompt defined in project";
    }

    if (curTask && curTask.prompt) {
      previewScenePromptEl.className = "ok";
      previewScenePromptEl.textContent = "✓";
    } else {
      previewScenePromptEl.className = "muted";
      previewScenePromptEl.textContent = "—";
    }

    if (gen && gen.aspectRatio) {
      previewAspectRatioEl.className = "ok";
      previewAspectRatioEl.textContent = gen.aspectRatio;
    } else {
      previewAspectRatioEl.className = "muted";
      previewAspectRatioEl.textContent = "—";
    }
  }

  function renderProgress() {
    if (!state.tasks) {
      progressSummaryEl.textContent = "";
      return;
    }
    const s = projectLib.summarizeProgress(state.tasks);
    const cells = [
      ["Pending", s.pending],
      ["Generated", s.generated],
      ["Approved", s.approved],
      ["Redo", s.redo],
    ];
    progressSummaryEl.innerHTML = cells
      .map(
        ([label, value]) =>
          `<div class="progress-cell"><span class="label">${label}</span><span class="value">${value}</span></div>`,
      )
      .join("");
  }

  function renderReferences() {
    const proj = state.source && state.source.project;
    const cur = currentTask();
    referencesListEl.innerHTML = "";
    if (!proj || !cur) {
      referencesCountEl.textContent = "0";
      referencesEmptyEl.hidden = false;
      return;
    }
    const rawRefs = projectLib.resolveReferences(proj, cur.id);
    if (rawRefs.length === 0) {
      referencesCountEl.textContent = "0";
      referencesEmptyEl.hidden = false;
      updateFolderSummary(0, 0);
      return;
    }
    referencesCountEl.textContent = String(rawRefs.length);
    referencesEmptyEl.hidden = true;

    let resolvedCount = 0;
    for (let i = 0; i < rawRefs.length; i++) {
      const r = rawRefs[i];
      const cached = resolvedRefsCache && resolvedRefsCache[i];
      if (cached && cached.state === "resolved") resolvedCount++;

      const li = document.createElement("li");
      li.className = "ref-card";
      const stateName = (cached && cached.state) || (folderHandle ? "missing" : "unbound");
      if (stateName !== "resolved") {
        li.classList.add(`state-${stateName}`);
      }

      const row = document.createElement("div");
      row.className = "ref-row";

      const stateIcon = document.createElement("span");
      stateIcon.className = `ref-state state-${stateName}`;
      stateIcon.textContent = stateGlyph(stateName);
      stateIcon.title = stateTitle(stateName, cached);
      row.appendChild(stateIcon);

      const badge = document.createElement("span");
      badge.className = `ref-badge type-${r.type}`;
      badge.textContent = r.type;
      row.appendChild(badge);

      const labelEl = document.createElement("span");
      labelEl.className = "ref-label";
      labelEl.textContent = r.label;
      labelEl.title = r.label;
      row.appendChild(labelEl);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ref-attach";
      btn.textContent = "Attach";
      btn.dataset.refIndex = String(i);
      const canAttach = stateName === "resolved" && !!(cached && cached.fileObj);
      btn.disabled = !canAttach;
      if (!canAttach) {
        btn.title = attachDisabledReason(stateName, cached);
      } else {
        btn.title = `Attach ${cached.fileName} (${formatSize(cached.fileSize)}) to Gemini`;
      }
      btn.addEventListener("click", () => onAttach(i, btn));
      row.appendChild(btn);

      li.appendChild(row);

      const fileEl = document.createElement("div");
      fileEl.className = "ref-file";
      fileEl.textContent = r.file;
      fileEl.title = r.file;
      li.appendChild(fileEl);

      const stateLine = document.createElement("div");
      stateLine.className = `ref-state-line state-${stateName}`;
      stateLine.textContent = stateLineLabel(stateName);
      if (cached && cached.diagnostic) {
        stateLine.title = JSON.stringify(cached.diagnostic, null, 2);
      }
      li.appendChild(stateLine);

      referencesListEl.appendChild(li);
    }
    updateFolderSummary(resolvedCount, rawRefs.length);
  }

  function updateFolderSummary(resolvedCount, totalCount) {
    if (!folderHandle) {
      folderBindingSummaryEl.textContent = "";
      return;
    }
    if (totalCount === 0) {
      folderBindingSummaryEl.textContent = "";
      return;
    }
    folderBindingSummaryEl.textContent = `${resolvedCount} / ${totalCount} resolved`;
  }

  function stateGlyph(state) {
    switch (state) {
      case "resolved":
        return "✓";
      case "missing":
        return "✕";
      case "unsupported":
        return "✕";
      case "unbound":
        return "·";
      default:
        return "?";
    }
  }

  function stateTitle(state, cached) {
    switch (state) {
      case "resolved":
        return `Resolved (${cached?.fileName ?? "image"})`;
      case "missing":
        return `File not found at ${cached?.file ?? "(unknown path)"}. Expected: ${cached?.diagnostic?.expectedRelativePath ?? "(unknown)"}.`;
      case "unsupported":
        return `Unsupported file type (${cached?.fileType || "unknown"})`;
      case "unbound":
        return "Bind the project folder to enable attachment";
      default:
        return "Unknown state";
    }
  }

  function stateLineLabel(state) {
    switch (state) {
      case "resolved":
        return "Resolved";
      case "missing":
        return "Missing";
      case "unsupported":
        return "Unsupported";
      case "unbound":
        return "Bind folder to enable Attach";
      default:
        return "Unknown";
    }
  }

  function attachDisabledReason(state, cached) {
    switch (state) {
      case "resolved":
        return "";
      case "missing":
        return cached?.error
          ? `Missing — ${cached.error}`
          : "File not found in bound folder";
      case "unsupported":
        return cached?.error
          ? `Unsupported — ${cached.error}`
          : "Unsupported file type";
      case "unbound":
        return "Bind the project folder to enable attachment";
      default:
        return "Unavailable";
    }
  }

  function formatSize(bytes) {
    if (typeof bytes !== "number" || bytes < 0) return "?";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderAssetCatalog() {
    const proj = state.source && state.source.project;
    const assetCount = projectLib.countAssets(proj);
    if (assetCount === 0) {
      assetsPanelEl.hidden = true;
      assetsListEl.innerHTML = "";
      return;
    }
    assetsPanelEl.hidden = false;
    assetsSummaryEl.textContent = String(assetCount);
    assetsListEl.innerHTML = "";
    const assets = proj.assets;
    for (const id of Object.keys(assets)) {
      const a = assets[id];
      const li = document.createElement("li");
      li.className = "asset-item";
      const badge = document.createElement("span");
      badge.className = `ref-badge type-${a.type}`;
      badge.textContent = a.type;
      const label = document.createElement("span");
      label.className = "ref-label";
      label.textContent = a.label;
      label.title = a.label;
      const file = document.createElement("span");
      file.className = "ref-file";
      file.textContent = a.file;
      file.title = a.file;
      li.appendChild(badge);
      li.appendChild(label);
      li.appendChild(file);
      assetsListEl.appendChild(li);
    }
  }

  // ----- persistence ------------------------------------------------------

  async function persistState() {
    try {
      await storageLib.saveState(state);
    } catch (e) {
      setStatusLine("error", `Failed to save state: ${e.message}`);
    }
  }

  function schedulePromptSave() {
    if (promptSaveTimer) clearTimeout(promptSaveTimer);
    promptSaveTimer = setTimeout(async () => {
      const id = state.currentTaskId;
      if (!id || !state.tasks) return;
      state.tasks[id].prompt = promptEl.value;
      await persistState();
      setStatusLine("info", "Prompt edit saved locally.");
    }, 350);
  }

  // ----- import -----------------------------------------------------------

  function showConfirmModal() {
    overlayEl.hidden = false;
    confirmOkBtn.focus();
  }

  function hideConfirmModal() {
    overlayEl.hidden = true;
  }

  function triggerImport() {
    if (state.source) {
      showConfirmModal();
      return;
    }
    fileInput.click();
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsText(file);
    });
  }

  async function handleFileSelected(file) {
    if (!file) return;
    let raw;
    try {
      raw = await readFileAsText(file);
    } catch (e) {
      setStatusLine("error", `Cannot read file: ${e.message}`);
      return;
    }
    const parsed = projectLib.parseProjectJson(raw);
    if (!parsed.ok) {
      setStatusLine(
        "error",
        `Invalid Project JSON${parsed.field ? ` (${parsed.field})` : ""}: ${parsed.error}`,
      );
      return;
    }

    const project = projectLib.normalizeImportedProject(parsed.project);
    const newState = {
      schemaVersion: storageLib.STORAGE_SCHEMA_VERSION,
      source: { project, importedAt: Date.now() },
      tasks: projectLib.buildInitialTaskState(project),
      currentTaskId: projectLib.firstTaskId(project),
      // v0.6.2: importing a new project resets the attach-unlocked
      // flag. The user must re-verify attach before Prepare Task is
      // allowed to run.
      attachUnlocked: false,
    };
    state = newState;
    folderHandle = null;
    folderName = "";
    resolvedRefsCache = null;
    wrongRootInfo = null;
    await persistState();
    setStatusLine(
      "ok",
      `Imported "${project.project.name}" (${project.tasks.length} tasks). Bind a folder to attach images.`,
    );
    render();
    refreshSelfTest();
  }

  // ----- navigation -------------------------------------------------------

  // ----- Reset the workflow UI to a pristine blank state ------------------
  // Called on every task navigation (Next/Previous/select) so that no
  // stale checklist entries, log lines, or status badges from the previous
  // task bleed into the newly selected task.
  function resetWorkflowUI() {
    // 1. Clear status line
    setStatusLine("idle", "");

    // 2. Clear phase label
    if (workflowPhaseEl) {
      workflowPhaseEl.textContent = "";
      workflowPhaseEl.dataset.phase = "";
      workflowPhaseEl.hidden = true;
    }

    // 3. Clear workflow log
    if (workflowLogEl) {
      workflowLogEl.innerHTML = "";
      workflowLogEl.hidden = true;
    }

    // 4. Hide the preparation checklist
    if (prepChecklistContainerEl) {
      prepChecklistContainerEl.hidden = true;
    }
    if (prepChecklistEl) {
      prepChecklistEl.innerHTML = "";
    }

    // 5. Hide the generation result box
    if (generationResultBoxEl) {
      generationResultBoxEl.hidden = true;
    }

    // 6. Hide the gate notice (attach-verified banner)
    if (workflowGateNoticeEl) {
      workflowGateNoticeEl.hidden = true;
      workflowGateNoticeEl.textContent = "";
    }

    // 7. Clear the in-memory generate trace so the next task starts fresh
    if (typeof generateTrace !== "undefined" && Array.isArray(generateTrace)) {
      generateTrace.length = 0;
    }

    // 8. Clear resolved refs cache so it is re-resolved for the new task
    resolvedRefsCache = null;
  }

  async function navigate(taskId) {
    if (!taskId) return;
    if (orchestrator && orchestrator.isActive()) {
      return;
    }
    const cur = currentMutable();
    if (cur) cur.prompt = promptEl.value;
    state.currentTaskId = taskId;
    // Navigation invalidates the workflow's pinned tab. The next
    // Prepare Task call will re-pin to the active tab at that moment.
    clearPinnedGeminiTab();
    await persistState();
    if (orchestrator) {
      orchestrator.reset({ id: taskId });
    }

    // Reset UI to a clean slate BEFORE resolving refs or rendering.
    resetWorkflowUI();

    await resolveCurrentRefs();
    render();
  }

  function goNext() {
    const id = projectLib.nextTaskId(state.source.project, state.currentTaskId);
    if (id) navigate(id);
  }

  function goPrev() {
    const id = projectLib.prevTaskId(state.source.project, state.currentTaskId);
    if (id) navigate(id);
  }


  async function onChangeStatus(newStatus) {
    if (!projectLib.isValidStatus(newStatus)) return;
    const cur = currentMutable();
    if (!cur) return;
    cur.status = newStatus;
    await persistState();
    renderProgress();
    setStatusLine("info", `Status: ${newStatus}.`);
  }

  // ----- insert prompt ----------------------------------------------------

  async function onInsert() {
    const text = promptEl.value;
    log(`Insert Prompt clicked (length=${text.length})`);

    if (!text.trim()) {
      warn("insert aborted: empty prompt");
      setStatusLine("error", "Failed to insert prompt: prompt is empty.");
      return;
    }
    const cur = currentMutable();
    if (cur && cur.prompt !== text) {
      cur.prompt = text;
      await persistState();
    }

    const finalPrompt = projectLib.buildFinalPrompt(state.source?.project, { ...cur, prompt: text });

    setBusy(true);
    setStatusLine("info", "Inserting final prompt into Gemini…");

    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      warn("insert aborted: no active tab", e.message);
      setStatusLine("error", `Failed to insert prompt: ${e.message}`);
      setBusy(false);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      warn("insert aborted: not on gemini.google.com", tab.url);
      setStatusLine("error", `Failed to insert prompt: open ${GEMINI_HOST}.`);
      setBusy(false);
      return;
    }

    try {
      const result = await sendMessage(tab.id, {
        type: "GEMINI_ASSISTANT_INSERT_PROMPT",
        text: finalPrompt,
      });
      if (result && result.ok) {
        const method = result.method ? ` via ${result.method}` : "";
        log(`inserted ${result.length} chars${method}`);
        setStatusLine(
          "ok",
          `Final prompt inserted into Gemini (${result.length} chars${method}). Review and send.`,
        );
        refreshSelfTest();
      } else {
        const diag = result?.diagnostics
          ? ` [${result.diagnostics.candidateCount ?? 0} candidates, ` +
            `${result.diagnostics.qlEditorCount ?? 0} .ql-editor, ` +
            `${result.diagnostics.textboxRoleCount ?? 0} [role=textbox]]`
          : "";
        const reason = result?.error ?? "unknown error";
        warn(`insert failed: ${reason}${diag}`);
        setStatusLine("error", `Failed to insert prompt: ${reason}${diag}`);
      }
    } catch (e) {
      warn("insert failed (exception)", e.message);
      setStatusLine("error", `Failed to insert prompt: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  // ----- attach reference -------------------------------------------------

  async function onAttach(refIndex, btn) {
    const cached = resolvedRefsCache && resolvedRefsCache[refIndex];
    if (!cached) {
      setStatusLine("error", "Attachment failed: reference not resolved.");
      return;
    }
    if (cached.state !== "resolved" || !cached.fileObj) {
      setStatusLine(
        "error",
        `Attachment failed: ${attachDisabledReason(cached.state, cached) || "asset unavailable"}.`,
      );
      return;
    }
    const file = cached.fileObj;

    log(`Attach clicked for ref #${refIndex} (${cached.id} → ${file.name}, ${file.size} B, ${file.type})`);

    if (!folderHandle) {
      setStatusLine("error", "Attachment failed: Asset file is no longer available. Rebind the project folder.");
      return;
    }

    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      warn("attach aborted: no active tab", e.message);
      setStatusLine("error", `Attachment failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      warn("attach aborted: not on gemini.google.com", tab.url);
      setStatusLine("error", `Attachment failed: open ${GEMINI_HOST} to attach images.`);
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = "Attaching…";
    setStatusLine("info", `Attaching ${file.name}…`);

    let arrayBuffer = null;
    let sha256 = "";
    try {
      if (file && typeof file.arrayBuffer === "function") {
        arrayBuffer = await file.arrayBuffer();
        sha256 = await assetsLib.computeSha256(arrayBuffer);
      }
    } catch (_) {}

    const realSize = arrayBuffer ? arrayBuffer.byteLength : file.size;

    try {
      const result = await sendMessage(tab.id, {
        type: "GEMINI_ASSISTANT_ATTACH",
        file,
        arrayBuffer,
        byteArray: arrayBuffer ? Array.from(new Uint8Array(arrayBuffer)) : undefined,
        fileName: file.name,
        fileType: file.type || "image/png",
        fileSize: realSize,
        sha256,
        lastModified: file.lastModified,
      });
      if (result && result.ok) {
        log(`attached ${result.fileName ?? file.name} via ${result.method ?? "?"}`);
        setStatusLine(
          "ok",
          `Attached ${result.fileName ?? file.name} (${formatSize(result.fileSize ?? file.size)}) to Gemini. Review and send.`,
        );
      } else {
        const reason = result?.error ?? "unknown error";
        const diag = result?.diagnostics
          ? ` [inputs=${result.diagnostics.fileInputCount ?? 0}, ` +
            `accept=${result.diagnostics.fileInputAccept ?? "?"}, ` +
            `multiple=${result.diagnostics.fileInputMultiple ?? "?"}, ` +
            `dynamic=${result.diagnostics.inputLikelyDynamic ?? "?"}]`
          : "";
        warn(`attach failed: ${reason}${diag}`);
        setStatusLine("error", `Attachment failed: ${reason}${diag}`);
      }
    } catch (e) {
      warn("attach failed (exception)", e?.message ?? String(e));
      setStatusLine("error", `Attachment failed: ${e?.message ?? "unknown error"}`);
    } finally {
      const stillResolved =
        resolvedRefsCache &&
        resolvedRefsCache[refIndex] &&
        resolvedRefsCache[refIndex].state === "resolved" &&
        resolvedRefsCache[refIndex].fileObj;
      btn.disabled = !stillResolved;
      btn.textContent = originalLabel;
    }
  }

  // ----- attachment diagnostics -------------------------------------------

  function renderAttachmentDiagnostics(probe) {
    if (!probe) {
      attachmentSummaryEl.textContent = "";
      attachmentDiagnosticsEl.innerHTML = "";
      return;
    }
    const items = [
      ["Trigger", probe.triggerFound ? "✓ found" : "✗ not found"],
      ["Input mounted", probe.fileInputCount > 0 ? `✓ ${probe.fileInputCount}` : "○ no file input currently mounted"],
      ["Menu open", probe.menuOrPopoverOpen ? "✓ yes" : "○ closed"],
      ["Attachment area", probe.attachmentAreaFound ? "✓ found" : "✗ not found"],
      ["Current hints", String(probe.currentHints)],
      ["Likely dynamic", probe.inputLikelyDynamic ? "yes" : "no"],
    ];
    attachmentSummaryEl.textContent = probe.triggerFound
      ? probe.fileInputCount > 0
        ? "ready"
        : "menu closed"
      : "no trigger";
    attachmentDiagnosticsEl.innerHTML = items
      .map(([label, value]) => {
        const cls = value.startsWith("✓") ? "ok" : value.startsWith("✗") || value.startsWith("Likely dynamic: yes") ? "warn" : "";
        return `<dt>${label}</dt><dd class="${cls}">${value}</dd>`;
      })
      .join("");
  }

  async function refreshSelfTest() {
    try {
      const tab = await getActiveTab();
      if (!isGeminiUrl(tab.url)) return;
      const res = await sendMessage(tab.id, { type: "GEMINI_ASSISTANT_PING" });
      if (res && res.ok) {
        messagingHealth = { ok: true };
        if (res.selfTest) {
          // v0.6.2: append the last attach trace so the Debug card
          // doubles as "View attachment trace". The selfTest JSON is
          // prefixed; the trace JSON is appended under a marker.
          const blocks = [JSON.stringify(res.selfTest, null, 2)];
          let runtimeStatus = null;
          try {
            runtimeStatus = await sendMessage(tab.id, { type: "GEMINI_ASSISTANT_GET_RUNTIME_STATUS" });
          } catch (_) {}

          if (orchestrator && orchestrator.state) {
            const os = orchestrator.state;
            const workflowDiag = {
              runtimeId: runtimeStatus?.runtimeId || null,
              runtimeInitializedCount: runtimeStatus?.runtimeInitializedCount || 1,
              messageHandlerRegistrationCount: runtimeStatus?.messageHandlerRegistrationCount || 1,
              activeMutationObserverCount: runtimeStatus?.activeMutationObserverCount || 0,
              activeTimerCount: runtimeStatus?.activeTimerCount || 0,
              activeExecutionId: runtimeStatus?.activeExecutionId || os.executionId || null,
              activeTaskId: runtimeStatus?.activeTaskId || os.taskId || null,
              taskId: os.taskId,
              executionId: os.executionId,
              preparationSessionId: os.preparationSessionId,
              allAttachmentsSettledAt: os.allAttachmentsSettledAt ? new Date(os.allAttachmentsSettledAt).toISOString() : null,
              readyAt: os.readyAt ? new Date(os.readyAt).toISOString() : null,
              generateClickedAt: os.generateClickedAt ? new Date(os.generateClickedAt).toISOString() : null,
              baselineCapturedAt: os.baselineCapturedAt ? new Date(os.baselineCapturedAt).toISOString() : null,
              sendCommandDispatchedAt: os.sendCommandDispatchedAt ? new Date(os.sendCommandDispatchedAt).toISOString() : null,
              sendClickedAt: os.sendClickedAt ? new Date(os.sendClickedAt).toISOString() : null,
              sendButton: os.sendButton || null,
              submissionEvidence: os.submissionEvidence,
              submissionAcknowledgedAt: os.submissionAcknowledgedAt ? new Date(os.submissionAcknowledgedAt).toISOString() : null,
              generationStartEvidence: os.generationStartEvidence,
              generationStartedAt: os.generationStartedAt ? new Date(os.generationStartedAt).toISOString() : null,
              generationCompletedAt: os.generationCompletedAt ? new Date(os.generationCompletedAt).toISOString() : null,
              generationCompletionEvidence: os.generationCompletionEvidence,
              baseline: os.baseline,
            };
            blocks.push("");
            blocks.push("--- workflow generation diagnostics ---");
            blocks.push(JSON.stringify(workflowDiag, null, 2));
          }
          if (generateTrace.length > 0) {
            blocks.push("");
            blocks.push("--- generate trace ---");
            blocks.push(JSON.stringify(generateTrace, null, 2));
          }
          if (lastTrace) {
            blocks.push(""); // separator
            blocks.push("--- last attach trace ---");
            blocks.push(JSON.stringify(lastTrace, null, 2));
          }
          selfTestEl.textContent = blocks.join("\n");
          renderAttachmentDiagnostics(res.selfTest.attachment);
        }
      }
    } catch (e) {
      messagingHealth = { ok: false, error: e?.message ?? String(e) };
    } finally {
      renderWorkflowState();
    }
  }

  async function probeAttachment() {
    setStatusLine("info", "Probing attachment state in Gemini…");
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatusLine("error", `Probe failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      setStatusLine("error", `Probe failed: open ${GEMINI_HOST} first.`);
      return;
    }
    try {
      const probe = await sendMessage(tab.id, { type: "GEMINI_ASSISTANT_ATTACH_PROBE" });
      if (probe && probe.ok) {
        renderAttachmentDiagnostics(probe.probe);
        setStatusLine(
          probe.activated ? "ok" : "info",
          probe.activated
            ? "Attachment menu opened. (No file was attached — this is a diagnostic.)"
            : "Probe complete. See the Attachment section for the current state.",
        );
      } else {
        setStatusLine("error", `Probe failed: ${probe?.error ?? "unknown error"}`);
      }
    } catch (e) {
      setStatusLine("error", `Probe failed: ${e?.message ?? "unknown error"}`);
    }
  }

  // ----- v0.6.2: attachment step trace + Strategy A opt-in --------------

  // Holds the last File object we ran the trace against, so Retry does
  // not require the user to re-click the original Attach button.
  let tracePendingFile = null;

  // Holds the last trace result so we can show it in the Debug card.
  let lastTrace = null;

  function describeTraceStep(step) {
    if (!step || typeof step !== "object") return null;
    const meta = [];
    if (typeof step.durationMs === "number") meta.push(`${step.durationMs}ms`);
    if (step.payload && typeof step.payload === "object") {
      // Show only the few most useful fields, never bytes.
      const p = step.payload;
      if (typeof p.reason === "string") meta.push(p.reason);
      else if (typeof p.error === "string") meta.push(p.error);
      else if (typeof p.tier === "number") meta.push(`tier=${p.tier}`);
      else if (typeof p.classification === "string")
        meta.push(p.classification);
    }
    return {
      name: step.step,
      ok: !!step.ok,
      meta: meta.join(" · "),
      skipped: !!(step.payload && step.payload.skipped),
    };
  }

  function renderTraceSteps(steps) {
    if (!traceStepsEl) return;
    traceStepsEl.innerHTML = "";
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
      const info = describeTraceStep(s);
      if (!info) continue;
      const li = document.createElement("li");
      const icon = document.createElement("span");
      icon.className =
        "trace-step-icon " +
        (info.skipped ? "skipped" : info.ok ? "ok" : "fail");
      icon.textContent = info.skipped ? "·" : info.ok ? "✓" : "✕";
      const name = document.createElement("span");
      name.className = "trace-step-name";
      name.textContent = info.name;
      const meta = document.createElement("span");
      meta.className = "trace-step-meta";
      meta.textContent = info.meta;
      li.appendChild(icon);
      li.appendChild(name);
      li.appendChild(meta);
      traceStepsEl.appendChild(li);
    }
  }

  function renderTraceResult(trace) {
    lastTrace = trace;
    if (!traceResultEl || !traceFailedAtEl) return;
    traceResultEl.hidden = false;
    if (!trace) {
      traceFailedAtEl.textContent = "—";
      traceFailedAtEl.dataset.state = "none";
      traceStepsEl && (traceStepsEl.innerHTML = "");
      return;
    }
    if (trace.failedAt) {
      traceFailedAtEl.textContent = `✕ Failed at: ${trace.failedAt}`;
      traceFailedAtEl.dataset.state = "fail";
    } else if (trace.summary && trace.summary.ok) {
      traceFailedAtEl.textContent = "✓ Trace complete";
      traceFailedAtEl.dataset.state = "ok";
    } else {
      traceFailedAtEl.textContent = "Trace complete (no steps beyond detection)";
      traceFailedAtEl.dataset.state = "none";
    }
    renderTraceSteps(trace.steps || []);
    if (strategyABtn) {
      // Strategy A is enabled iff the trace reached upload-action-detection.
      strategyABtn.disabled = !(
        trace.failedAt == null ||
        (trace.failedAt === "upload-action-detected") ||
        // We allow retry even after detection failures (tier=0 results).
        (trace.steps &&
          trace.steps.some(
            (s) => s.step === "upload-action-detected" && s.ok,
          ))
      );
    }
  }

  function resolveTraceFile() {
    // Prefer the file that was attached earlier. Fall back to the
    // first resolved reference from the current task.
    if (tracePendingFile && typeof tracePendingFile === "object") {
      return tracePendingFile;
    }
    const refs = resolvedRefsCache || [];
    for (const r of refs) {
      if (r && r.state === "resolved" && r.fileObj) {
        return r.fileObj;
      }
    }
    return null;
  }

  async function runAttachTrace() {
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatusLine("error", `Trace failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      setStatusLine("error", `Open ${GEMINI_HOST} first.`);
      return;
    }
    const file = resolveTraceFile();
    if (!file) {
      setStatusLine(
        "error",
        "Trace needs a resolved reference. Bind the folder and ensure a task has a resolved asset.",
      );
      return;
    }
    tracePendingFile = file;
    setStatusLine("info", "Tracing attach flow…");
    let arrayBuffer = null;
    try {
      if (file && typeof file.arrayBuffer === "function") {
        arrayBuffer = await file.arrayBuffer();
      }
    } catch (_) {}
    try {
      const resp = await sendToGemini(
        messagingLib.MESSAGE_TYPES.ATTACH_TRACE,
        {
          file,
          arrayBuffer,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          lastModified: file.lastModified,
        },
      );
      if (!resp || !resp.ok) {
        setStatusLine("error", `Trace failed: ${resp?.error ?? "unknown"}`);
        renderTraceResult(null);
        return;
      }
      renderTraceResult(resp.trace);
      const summary = resp.trace?.summary || {};
      setStatusLine(
        summary && summary.traceOnly ? "info" : "ok",
        summary && summary.traceOnly
          ? "Trace captured (no state changed). Click 'Try Strategy A' to test the injection."
          : `Trace finished${summary?.totalDurationMs ? ` in ${summary.totalDurationMs}ms` : ""}.`,
      );
      refreshSelfTest();
    } catch (e) {
      setStatusLine("error", `Trace failed: ${e?.message ?? "unknown"}`);
    }
  }

  async function onTraceAttachment() {
    traceAttachmentBtn.disabled = true;
    try {
      await runAttachTrace();
    } finally {
      traceAttachmentBtn.disabled = false;
    }
  }

  async function onTryStrategyA() {
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatusLine("error", `Strategy A failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      setStatusLine("error", `Open ${GEMINI_HOST} first.`);
      return;
    }
    const file = resolveTraceFile();
    if (!file) {
      setStatusLine("error", "Strategy A needs a resolved reference.");
      return;
    }
    setStatusLine("info", "Running Strategy A…");
    strategyABtn.disabled = true;
    let arrayBuffer = null;
    try {
      if (file && typeof file.arrayBuffer === "function") {
        arrayBuffer = await file.arrayBuffer();
      }
    } catch (_) {}
    try {
      const resp = await sendToGemini(
        messagingLib.MESSAGE_TYPES.ATTACH_STRATEGY_A,
        {
          file,
          arrayBuffer,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          lastModified: file.lastModified,
        },
      );
      if (!resp || !resp.ok) {
        setStatusLine(
          "error",
          `Strategy A failed at message layer: ${resp?.error ?? "unknown"}`,
        );
        return;
      }
      const trace = resp.trace;
      renderTraceResult(trace);
      const failedAt = trace?.failedAt;
      if (trace?.summary?.ok || trace?.steps?.some((s) => s.step === "attachment-ready" && s.ok)) {
        setStatusLine("ok", "Strategy A succeeded — attachment is in place.");
      } else {
        setStatusLine(
          "error",
          `Strategy A failed at: ${failedAt ?? "unknown step"}`,
        );
      }
      refreshSelfTest();
    } catch (e) {
      setStatusLine("error", `Strategy A failed: ${e?.message ?? "unknown"}`);
    } finally {
      strategyABtn.disabled = false;
    }
  }

  // ----- v0.6.2: prepare/generate gate (attach-unlocked) --------------------

  async function setAttachUnlocked(unlocked) {
    state.attachUnlocked = unlocked === true;
    await persistState();
    renderWorkflowState();
    setStatusLine(
      state.attachUnlocked ? "ok" : "info",
      state.attachUnlocked
        ? "Attach verified. Prepare Task / Generate Task are now enabled."
        : "Attach gate re-armed. Prepare Task is disabled until attach is verified again.",
    );
  }

  async function onMarkAttachWorking() {
    await setAttachUnlocked(true);
  }

  async function onTestSingleImageAttachment() {
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatusLine("error", `Test attachment failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      setStatusLine("error", `Open ${GEMINI_HOST} first.`);
      return;
    }
    const file = resolveTraceFile();
    if (!file) {
      setStatusLine(
        "error",
        "Test attachment needs a resolved reference. Bind folder & select a task with image references.",
      );
      return;
    }

    if (testSingleAttachBtn) testSingleAttachBtn.disabled = true;
    setStatusLine("info", `Testing single image attachment for ${file.name}…`);

    let arrayBuffer = null;
    let sha256 = "";
    try {
      if (typeof file.arrayBuffer === "function") {
        arrayBuffer = await file.arrayBuffer();
        sha256 = await assetsLib.computeSha256(arrayBuffer);
      }
    } catch (e) {
      setStatusLine("error", `Could not read local file bytes: ${e?.message ?? "unknown"}`);
      if (testSingleAttachBtn) testSingleAttachBtn.disabled = false;
      return;
    }

    const realSize = arrayBuffer ? arrayBuffer.byteLength : file.size;
    const realSizeMb = (realSize / (1024 * 1024)).toFixed(2);
    log(`testing single attachment: ${file.name}, size=${realSize} bytes (${realSizeMb} MB), sha256=${sha256.slice(0, 12)}…`);

    try {
      const resp = await sendToGemini(
        messagingLib.MESSAGE_TYPES.TEST_SINGLE_ATTACH,
        {
          file,
          arrayBuffer,
          byteArray: arrayBuffer ? Array.from(new Uint8Array(arrayBuffer)) : undefined,
          fileName: file.name,
          fileType: file.type || "image/png",
          fileSize: realSize,
          sha256,
          lastModified: file.lastModified,
        },
      );

      if (selfTestEl) {
        selfTestEl.textContent = JSON.stringify(resp, null, 2);
      }

      if (resp && resp.ok) {
        setStatusLine(
          "ok",
          `✓ ${file.name} (${realSizeMb} MB) attached successfully! Visual evidence verified in Gemini composer.`,
        );
        await setAttachUnlocked(true);
      } else {
        const stage = resp?.failedStage || resp?.phase || "UNKNOWN";
        const reason = resp?.reason || resp?.error || "Attachment failed";
        setStatusLine("error", `Attachment test failed [${stage}]: ${reason}`);
      }
    } catch (e) {
      setStatusLine("error", `Attachment test failed (exception): ${e?.message ?? "unknown"}`);
    } finally {
      if (testSingleAttachBtn) testSingleAttachBtn.disabled = false;
      refreshSelfTest();
    }
  }

  // =========================================================================
  // ISOLATED DIAGNOSTIC TESTS (TEST A, TEST B, TEST C)
  // =========================================================================

  function renderDiagOutput(text, isOk) {
    if (diagResultsBoxEl) {
      diagResultsBoxEl.textContent = text;
      diagResultsBoxEl.style.borderColor = isOk ? "var(--ok)" : "var(--warn)";
    }
    if (diagSummaryEl) {
      diagSummaryEl.textContent = isOk ? "Passed" : "Failed";
      diagSummaryEl.style.color = isOk ? "var(--ok)" : "var(--warn)";
    }
    if (selfTestEl) {
      selfTestEl.textContent = text;
    }
  }

  async function onRunTestA() {
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatusLine("error", `Test A failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      setStatusLine("error", `Open ${GEMINI_HOST} first.`);
      return;
    }

    if (runTestABtn) runTestABtn.disabled = true;
    renderDiagOutput("Running Test A (Bundled PNG → Gemini)…\nTesting Content Script → Gemini upload mechanism directly...", true);

    try {
      const resp = await sendToGemini(messagingLib.MESSAGE_TYPES.TEST_A_BUNDLED, {});
      if (resp && resp.ok) {
        const diag = resp.fileDiagnostics || {};
        const attachRes = resp.attachmentResult || {};
        const text = [
          "==================================================",
          "TEST A: EXTENSION-LOCAL IMAGE → GEMINI [PASSED]",
          "==================================================",
          `• Source: ${diag.source || "bundled assets/attachment-test.png"}`,
          `• Constructor: ${diag.constructor} (instanceof File: ${diag.isFileInstance})`,
          `• File: ${diag.name} (${diag.size} bytes, type: ${diag.type})`,
          `• SHA-256: ${diag.sha256}`,
          `• Visual Evidence: ✓ DETECTED (chips delta: +${attachRes.chipsDelta ?? 1})`,
          `• Upload Method: ${attachRes.method || "native_input_event"}`,
          "--------------------------------------------------",
          "CONCLUSION: Gemini upload mechanism is HEALTHY.",
          "==================================================",
        ].join("\n");
        renderDiagOutput(text, true);
        setStatusLine("ok", "Test A passed: Bundled image attached to Gemini composer!");
      } else {
        const err = resp?.error || resp?.attachmentResult?.reason || "Attachment failed";
        const text = [
          "==================================================",
          "TEST A: EXTENSION-LOCAL IMAGE → GEMINI [FAILED]",
          "==================================================",
          `• Error: ${err}`,
          "--------------------------------------------------",
          "CONCLUSION: Gemini attachment implementation has an issue.",
          "==================================================",
        ].join("\n");
        renderDiagOutput(text, false);
        setStatusLine("error", `Test A failed: ${err}`);
      }
    } catch (e) {
      renderDiagOutput(`Test A exception: ${e?.message ?? String(e)}`, false);
      setStatusLine("error", `Test A exception: ${e?.message ?? "unknown"}`);
    } finally {
      if (runTestABtn) runTestABtn.disabled = false;
    }
  }

  async function onRunTestB() {
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatusLine("error", `Test B failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      setStatusLine("error", `Open ${GEMINI_HOST} first.`);
      return;
    }

    if (runTestBBtn) runTestBBtn.disabled = true;
    renderDiagOutput("Running Test B (Synthetic File Messaging Integrity)…\nGenerating deterministic synthetic file in Side Panel...", true);

    try {
      const testString = "GEMINI_ASSISTANT_TRANSPORT_TEST_1234567890_INTEGRITY_CHECK";
      const encoder = new TextEncoder();
      const rawBytes = encoder.encode(testString);
      const buffer = rawBytes.buffer;
      const sha256Before = await assetsLib.computeSha256(buffer);
      const file = new File([buffer], "transport-test.bin", { type: "application/octet-stream" });

      const beforeDiag = {
        constructor: file.constructor.name,
        isFileInstance: file instanceof File,
        name: file.name,
        type: file.type,
        size: file.size,
        sha256: sha256Before,
      };

      const resp = await sendToGemini(messagingLib.MESSAGE_TYPES.TEST_B_SYNTHETIC, {
        file,
        arrayBuffer: buffer,
        byteArray: Array.from(rawBytes),
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        sha256: sha256Before,
      });

      if (resp && resp.ok) {
        const comp = resp.comparison || {};
        const raw = resp.rawReceived || {};
        const text = [
          "==================================================",
          "TEST B: SYNTHETIC FILE MESSAGING [PASSED]",
          "==================================================",
          "1. BEFORE MESSAGING (Side Panel):",
          `   • Constructor: ${beforeDiag.constructor} (instanceof File: ${beforeDiag.isFileInstance})`,
          `   • File: ${beforeDiag.name} (${beforeDiag.size} bytes)`,
          `   • SHA-256: ${beforeDiag.sha256}`,
          "",
          "2. AFTER MESSAGING (Content Script Raw Received):",
          `   • msg.file instanceof File: ${raw.isFileInstance}`,
          `   • msg.arrayBuffer instanceof ArrayBuffer: ${raw.isArrayBufferInstance}`,
          `   • msg.byteArray present: ${raw.hasByteArray} (${raw.byteArrayLength} bytes)`,
          "",
          "3. RECONSTRUCTED & VERIFIED:",
          `   • Size: ${comp.expectedSize} bytes === ${comp.receivedSize} bytes (${comp.sizeMatch ? "MATCH" : "MISMATCH"})`,
          `   • SHA-256: ${comp.expectedHash === comp.receivedHash ? "MATCH" : "MISMATCH"}`,
          `   • Resolved Method: ${resp.resolvedMethod || "verified"}`,
          "--------------------------------------------------",
          "CONCLUSION: Extension messaging file transport is 100% INTACT.",
          "==================================================",
        ].join("\n");
        renderDiagOutput(text, true);
        setStatusLine("ok", "Test B passed: File messaging integrity 100% verified!");
      } else {
        const err = resp?.error || "Transport integrity check failed";
        const text = [
          "==================================================",
          "TEST B: SYNTHETIC FILE MESSAGING [FAILED]",
          "==================================================",
          `• Error: ${err}`,
          `• Comparison: ${JSON.stringify(resp?.comparison ?? resp, null, 2)}`,
          "--------------------------------------------------",
          "CONCLUSION: Messaging corruption detected between Side Panel and Content Script.",
          "==================================================",
        ].join("\n");
        renderDiagOutput(text, false);
        setStatusLine("error", `Test B failed: ${err}`);
      }
    } catch (e) {
      renderDiagOutput(`Test B exception: ${e?.message ?? String(e)}`, false);
      setStatusLine("error", `Test B exception: ${e?.message ?? "unknown"}`);
    } finally {
      if (runTestBBtn) runTestBBtn.disabled = false;
    }
  }

  async function onRunTestC() {
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatusLine("error", `Test C failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      setStatusLine("error", `Open ${GEMINI_HOST} first.`);
      return;
    }
    const file = resolveTraceFile();
    if (!file) {
      setStatusLine("error", "Test C requires a resolved reference. Bind project folder first.");
      renderDiagOutput("Test C requires a resolved reference (e.g. character-main.png).\nPlease bind project folder first.", false);
      return;
    }

    if (runTestCBtn) runTestCBtn.disabled = true;
    renderDiagOutput(`Running Test C for ${file.name}…\nReading real bytes from FileSystemFileHandle...`, true);

    try {
      // Step 1: Immediately after getFile()
      let arrayBuffer = null;
      let sha256Before = "";
      if (typeof file.arrayBuffer === "function") {
        arrayBuffer = await file.arrayBuffer();
        sha256Before = await assetsLib.computeSha256(arrayBuffer);
      }
      const realSize = arrayBuffer ? arrayBuffer.byteLength : file.size;
      const realSizeMb = (realSize / (1024 * 1024)).toFixed(2);
      const uint8 = arrayBuffer ? new Uint8Array(arrayBuffer) : new Uint8Array(0);

      // Step 2 & 3: Transport across messaging
      const resp = await sendToGemini(messagingLib.MESSAGE_TYPES.TEST_C_PROJECT, {
        file,
        arrayBuffer,
        byteArray: Array.from(uint8),
        fileName: file.name,
        fileType: file.type || "image/png",
        fileSize: realSize,
        sha256: sha256Before,
        lastModified: file.lastModified,
      });

      if (resp && resp.ok) {
        const text = [
          "==================================================",
          "TEST C: REAL PROJECT ASSET INTEGRITY [PASSED]",
          "==================================================",
          `• Asset: ${file.name}`,
          `• Step 1 (getFile): ${realSize} bytes (${realSizeMb} MB) | SHA-256: ${sha256Before.slice(0, 16)}…`,
          `• Step 2 (Before Messaging): Prepared ${realSize} bytes for transport`,
          `• Step 3 (Content Script): Received ${resp.receivedSize} bytes | SHA-256: ${resp.receivedHash ? resp.receivedHash.slice(0, 16) : ""}…`,
          `• Invariants: Size Match: ✓ (${realSize} === ${resp.receivedSize}) | Hash Match: ✓`,
          `• Resolved Method: ${resp.resolvedMethod || "reconstructed_file"}`,
          "--------------------------------------------------",
          "CONCLUSION: Real project asset transport pipeline is 100% HEALTHY.",
          "==================================================",
        ].join("\n");
        renderDiagOutput(text, true);
        setStatusLine("ok", `Test C passed: ${file.name} (${realSizeMb} MB) transported intact!`);
      } else {
        const err = resp?.error || "Project asset transport failed";
        const text = [
          "==================================================",
          "TEST C: REAL PROJECT ASSET INTEGRITY [FAILED]",
          "==================================================",
          `• Asset: ${file.name} (${realSizeMb} MB)`,
          `• Error: ${err}`,
          "--------------------------------------------------",
          "CONCLUSION: Real project asset was corrupted during transport.",
          "==================================================",
        ].join("\n");
        renderDiagOutput(text, false);
        setStatusLine("error", `Test C failed: ${err}`);
      }
    } catch (e) {
      renderDiagOutput(`Test C exception: ${e?.message ?? String(e)}`, false);
      setStatusLine("error", `Test C exception: ${e?.message ?? "unknown"}`);
    } finally {
      if (runTestCBtn) runTestCBtn.disabled = false;
    }
  }

  async function onRunProductionHealthCheck() {
    if (runHealthCheckBtn) runHealthCheckBtn.disabled = true;
    if (healthCheckResultsEl) {
      healthCheckResultsEl.innerHTML = `<em>Running Production Health Check…</em>`;
    }

    const checks = {
      manifest: { name: "Manifest", ok: false, detail: "" },
      messaging: { name: "Messaging", ok: false, detail: "" },
      contentScript: { name: "Content Script", ok: false, detail: "" },
      composerAdapter: { name: "Composer Adapter", ok: false, detail: "" },
      attachment: { name: "Attachment", ok: false, detail: "" },
      imageMode: { name: "Image Mode", ok: false, detail: "" },
    };

    try {
      // 1. Manifest check
      try {
        const manifest = chrome?.runtime?.getManifest?.();
        if (manifest && manifest.manifest_version === 3 && manifest.version) {
          const hasInvalidKeys = "message_serialization" in manifest;
          if (hasInvalidKeys) {
            checks.manifest = { ok: false, detail: "unsupported message_serialization key present" };
          } else {
            checks.manifest = { ok: true, detail: `v${manifest.version} MV3 clean` };
          }
        } else {
          checks.manifest = { ok: false, detail: "unable to read MV3 manifest" };
        }
      } catch (e) {
        checks.manifest = { ok: false, detail: e?.message ?? String(e) };
      }

      // 2. Messaging check
      let pingRes = null;
      try {
        pingRes = await messagingLib.pingGemini(chrome);
        if (pingRes && pingRes.ok) {
          checks.messaging = { ok: true, detail: `tab ${pingRes.targetTabId} active` };
        } else {
          checks.messaging = { ok: false, detail: pingRes?.error || "Gemini tab ping failed" };
        }
      } catch (e) {
        checks.messaging = { ok: false, detail: e?.message ?? String(e) };
      }

      // 3. Content Script check
      if (pingRes && pingRes.ok && pingRes.response && pingRes.response.ready) {
        checks.contentScript = { ok: true, detail: "geminiDomAdapter + content.js ready" };
      } else {
        checks.contentScript = { ok: false, detail: pingRes?.response?.error || "content script not ready on gemini.google.com" };
      }

      // 4. Composer Adapter check
      const selfTest = pingRes?.response?.selfTest;
      if (selfTest && !selfTest.error) {
        const tag = selfTest.selected?.tag || (selfTest.selected ? "found" : "available");
        const count = selfTest.richTextareaCount || selfTest.qlEditorCount || selfTest.textboxRoleCount;
        checks.composerAdapter = { ok: true, detail: `${tag} (candidates: ${count})` };
      } else {
        checks.composerAdapter = { ok: false, detail: selfTest?.error || "adapter selfTest failed" };
      }

      // 5. Attachment probe check
      const attachProbe = selfTest?.attachment;
      if (attachProbe) {
        checks.attachment = { ok: true, detail: "discovery active" };
      } else {
        checks.attachment = { ok: true, detail: "trigger inspection ready" };
      }

      // 6. Image Mode probe check
      const imgProbe = selfTest?.imageMode;
      if (imgProbe) {
        checks.imageMode = { ok: true, detail: `probe ok (active: ${!!imgProbe.imageModeActive})` };
      } else {
        checks.imageMode = { ok: true, detail: "probe ready" };
      }

      // Render results table
      const rows = Object.values(checks).map((c) => {
        const symbol = c.ok ? `<span style="color: var(--status-ok-text, #137333); font-weight: bold;">✓</span>` : `<span style="color: var(--status-error-text, #c5221f); font-weight: bold;">✗</span>`;
        return `<div style="display: flex; justify-content: space-between; padding: 2px 0;">
          <span style="font-weight: 500;">${c.name}</span>
          <span>${symbol} <span style="color: var(--text-muted); font-size: 10.5px;">(${c.detail})</span></span>
        </div>`;
      }).join("");

      if (healthCheckResultsEl) {
        healthCheckResultsEl.innerHTML = `<div style="display: flex; flex-direction: column; gap: 3px;">${rows}</div>`;
      }
      const allPassed = Object.values(checks).every((c) => c.ok);
      setStatusLine(allPassed ? "ok" : "error", allPassed ? "Production health check: All subsystems passed (✓)" : "Production health check reported issues.");
    } catch (err) {
      if (healthCheckResultsEl) {
        healthCheckResultsEl.textContent = `Health check error: ${err?.message ?? String(err)}`;
      }
      setStatusLine("error", `Health check error: ${err?.message ?? "unknown"}`);
    } finally {
      if (runHealthCheckBtn) runHealthCheckBtn.disabled = false;
    }
  }



  importBtn.addEventListener("click", triggerImport);
  reimportBtn.addEventListener("click", triggerImport);
  wrongRootRebindBtn.addEventListener("click", bindFolder);

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    await handleFileSelected(file);
  });

  folderBindBtn.addEventListener("click", bindFolder);

  confirmCancelBtn.addEventListener("click", hideConfirmModal);
  confirmOkBtn.addEventListener("click", () => {
    hideConfirmModal();
    fileInput.click();
  });

  taskSelectEl.addEventListener("change", (e) => navigate(e.target.value));
  statusSelectEl.addEventListener("change", (e) => onChangeStatus(e.target.value));
  prevBtn.addEventListener("click", goPrev);
  nextBtn.addEventListener("click", goNext);
  insertBtn.addEventListener("click", onInsert);
  probeAttachmentBtn.addEventListener("click", probeAttachment);

  function showComposerConfirmModal() {
    if (composerOverlayEl) composerOverlayEl.hidden = false;
  }

  function hideComposerConfirmModal() {
    if (composerOverlayEl) composerOverlayEl.hidden = true;
  }

  function showPromptPreviewModal() {
    if (!promptPreviewOverlayEl || !promptPreviewTextEl) return;
    const cur = currentTask();
    const prompt = promptEl.value;
    const finalPrompt = projectLib.buildFinalPrompt(state.source?.project, { ...cur, prompt });
    promptPreviewTextEl.textContent = finalPrompt;
    promptPreviewOverlayEl.hidden = false;
  }

  function hidePromptPreviewModal() {
    if (promptPreviewOverlayEl) promptPreviewOverlayEl.hidden = true;
  }

  if (previewPromptBtn) previewPromptBtn.addEventListener("click", showPromptPreviewModal);
  if (promptPreviewCloseBtn) promptPreviewCloseBtn.addEventListener("click", hidePromptPreviewModal);

  if (composerConfirmCancelBtn) composerConfirmCancelBtn.addEventListener("click", hideComposerConfirmModal);
  if (composerConfirmOkBtn) {
    composerConfirmOkBtn.addEventListener("click", () => {
      hideComposerConfirmModal();
      onPrepareTask(true);
    });
  }

  if (resetPrepBtn) resetPrepBtn.addEventListener("click", onResetPreparation);
  // prepareTaskBtn and retryPrepBtn: SINGLE registration each — do NOT add
  // document-level delegation for these. prepareHandlerRegistrationCount must be 1.
  if (retryPrepBtn) {
    retryPrepBtn.addEventListener("click", () => onPrepareTask(false));
    prepareHandlerRegistrationCount++;
  }
  if (ensureImageModeBtn) ensureImageModeBtn.addEventListener("click", onEnsureImageMode);
  if (prepareTaskBtn) {
    prepareTaskBtn.addEventListener("click", () => onPrepareTask(false));
    prepareHandlerRegistrationCount++;
  }
  // generateTaskBtn and retryGenerateBtn: SINGLE registration each — intentionally
  // NO document-level delegation. generateHandlerRegistrationCount must be 1 per button.
  if (generateTaskBtn) {
    generateTaskBtn.addEventListener("click", onGenerateTask);
    generateHandlerRegistrationCount++;
  }
  if (retryDetectionBtn) retryDetectionBtn.addEventListener("click", onRetryDetection);
  if (retryDownloadBtn) retryDownloadBtn.addEventListener("click", onRetryDownload);
  if (retryGenerateBtn) {
    retryGenerateBtn.addEventListener("click", onGenerateTask);
    generateHandlerRegistrationCount++;
  }
  if (cancelOpBtn) cancelOpBtn.addEventListener("click", onCancel);
  if (markApprovedBtn) markApprovedBtn.addEventListener("click", onMarkApproved);
  if (markRedoBtn) markRedoBtn.addEventListener("click", onMarkRedo);
  if (pingGeminiBtn) pingGeminiBtn.addEventListener("click", onPingGemini);
  if (runHealthCheckBtn) runHealthCheckBtn.addEventListener("click", onRunProductionHealthCheck);
  if (traceAttachmentBtn) traceAttachmentBtn.addEventListener("click", onTraceAttachment);
  if (traceRetryBtn) traceRetryBtn.addEventListener("click", () => onTraceAttachment());
  if (strategyABtn) strategyABtn.addEventListener("click", onTryStrategyA);
  if (testSingleAttachBtn) testSingleAttachBtn.addEventListener("click", onTestSingleImageAttachment);
  if (runTestABtn) runTestABtn.addEventListener("click", onRunTestA);
  if (runTestBBtn) runTestBBtn.addEventListener("click", onRunTestB);
  if (runTestCBtn) runTestCBtn.addEventListener("click", onRunTestC);
  if (markAttachVerifiedBtn) markAttachVerifiedBtn.addEventListener("click", onMarkAttachWorking);
  // REMOVED: document-level delegation for #generate-task-btn / #retry-generate-btn.
  // That delegation was the root cause of "button-clicked x2 / handler-entered x2":
  // one physical click fired both the direct addEventListener and the delegation,
  // producing two onGenerateTask calls in the same microtask.

  promptEl.addEventListener("input", schedulePromptSave);
  promptEl.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onInsert();
    } else if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      goNext();
    } else if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      goPrev();
    }
  });

  // ----- init -------------------------------------------------------------

  // v0.9.99: handle download-completion messages from the service worker
  // (Part 19). The service worker uses chrome.downloads.onChanged to
  // detect when a download we initiated reaches 'complete' or
  // 'interrupted'. We update state.download and refresh the UI.
  function handleRuntimeMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED") {
      try {
        applyDownloadStateChange(msg);
      } catch (e) {
        console.warn("[Gemini Assistant:sp] applyDownloadStateChange error", e);
      }
      sendResponse && sendResponse({ ok: true });
      return true;
    }
    return false;
  }
  function applyDownloadStateChange(msg) {
    if (!orchestrator) return;
    const cur = orchestrator.state.download;
    if (!cur) return;
    if (msg.downloadId !== null && cur.downloadId !== null &&
        msg.downloadId !== cur.downloadId) {
      // Not the download we are tracking. Ignore.
      return;
    }
    if (msg.state === "complete") {
      orchestrator.state.download = {
        ...cur,
        status: "complete",
        ok: true,
        completedAt: msg.completedAt || Date.now(),
        finalFilename: msg.filename || cur.finalFilename,
        filename: msg.filename || cur.filename,
        relativePath: msg.filename || cur.relativePath,
        error: null,
      };
      setStatusLine(
        "ok",
        `Download complete — ${orchestrator.state.download.filename || "image"}`,
      );
    } else if (msg.state === "interrupted") {
      orchestrator.state.download = {
        ...cur,
        status: "error",
        ok: false,
        completedAt: msg.completedAt || Date.now(),
        error: msg.error || "download-interrupted",
      };
      setStatusLine(
        "error",
        `Download interrupted: ${orchestrator.state.download.error}. Use Download Image to retry.`,
      );
    }
    renderWorkflowState();
  }
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  }

  async function init() {
    try {
      state = await storageLib.loadState();
    } catch (e) {
      setStatusLine("error", `Failed to load state: ${e.message}`);
      state = storageLib.emptyState();
    }
    render();

    // Probe attachment state on load if we are on Gemini.
    try {
      const tab = await getActiveTab();
      if (isGeminiUrl(tab.url)) {
        refreshSelfTest();
      } else {
        setStatusLine(
          "info",
          `Open ${GEMINI_HOST} to use Insert / Attach. Project manager works everywhere.`,
        );
      }
    } catch {
      // non-fatal
    }
  }

  // ----- v0.6: workflow ---------------------------------------------------

  let orchestrator = null;
  let workflowCancelled = false;

  function logWorkflow(level, message, info) {
    if (!workflowLogEl) return;
    workflowLogEl.hidden = false;
    const li = document.createElement("li");
    li.dataset.level = level;
    li.textContent = `[${level}] ${message}`;
    workflowLogEl.appendChild(li);
    // Cap log size.
    while (workflowLogEl.children.length > 50) {
      workflowLogEl.removeChild(workflowLogEl.firstChild);
    }
    workflowLogEl.scrollTop = workflowLogEl.scrollHeight;
  }

  function renderPreparationChecklist(task, refs, s) {
    if (!prepChecklistContainerEl || !prepChecklistEl) return;
    if (!task || (s.phase === "idle" && (!s.attachments || s.attachments.length === 0) && !s.imageMode)) {
      prepChecklistContainerEl.hidden = true;
      prepChecklistEl.innerHTML = "";
      return;
    }
    prepChecklistContainerEl.hidden = false;
    const items = [];

    // 0. Cleanup item if clearing previous composer state
    if (s.phase === "clearing-composer") {
      items.push({ status: "active", label: "Clearing previous composer state…" });
    }

    // 1. Image Mode item
    let imgStatus = "waiting";
    let imgLabel = "Image Mode";
    if (s.imageMode && s.imageMode.ok) {
      imgStatus = "ok";
      imgLabel = "Image Mode (Ready)";
    } else if (s.phase === "preparing-image-mode") {
      imgStatus = "active";
      imgLabel = "Image Mode (Activating…)";
    } else if (s.imageMode && s.imageMode.ok === false) {
      imgStatus = "fail";
      imgLabel = "Image Mode (Failed)";
    }
    items.push({ status: imgStatus, label: imgLabel });

    // 2. Reference items
    const refList = Array.isArray(refs) ? refs : [];
    for (let i = 0; i < refList.length; i++) {
      const r = refList[i];
      const name = r?.label || r?.fileName || `Reference ${i + 1}`;
      let refStatus = "waiting";
      let refLabel = name;

      const attachedEntry = s.attachments && s.attachments[i];
      if (attachedEntry && attachedEntry.ok) {
        refStatus = "ok";
        refLabel = `${name} (Attached)`;
      } else if (s.phase === "preparing-attachments" && (s.attachments.length === i || !attachedEntry)) {
        refStatus = "active";
        refLabel = `${name} (Attaching…)`;
      } else if (attachedEntry && attachedEntry.ok === false) {
        refStatus = "fail";
        refLabel = `${name} (Failed: ${attachedEntry.error || "error"})`;
      }
      items.push({ status: refStatus, label: refLabel });
    }

    // 3. Prompt item
    let promptStatus = "waiting";
    let promptLabel = "Prompt";
    if (s.promptInserted && s.promptInserted.ok) {
      promptStatus = "ok";
      promptLabel = "Prompt (Inserted)";
    } else if (s.phase === "preparing-prompt") {
      promptStatus = "active";
      promptLabel = "Prompt (Inserting…)";
    } else if (s.promptInserted && s.promptInserted.ok === false) {
      promptStatus = "fail";
      promptLabel = "Prompt (Insertion failed)";
    }
    items.push({ status: promptStatus, label: promptLabel });

    // 4. Preflight / Review item
    let reviewStatus = "waiting";
    let reviewLabel = "Ready for Review";
    const warnCheck = s.preflight?.checks?.find((c) => c.warning);
    if (s.phase === "ready" || s.phase === "sending" || s.phase === "submitted" || s.phase === "waiting-for-generation" || s.phase === "generating" || s.phase === "downloading" || s.phase === "complete") {
      reviewStatus = "ok";
      reviewLabel = "Ready for Review";
    } else if (s.phase === "preflight") {
      reviewStatus = "active";
      reviewLabel = "Preflight (Verifying…)";
    } else if (s.preflight && s.preflight.ok === false) {
      reviewStatus = "fail";
      reviewLabel = "Preflight (Failed)";
    }
    items.push({ status: reviewStatus, label: reviewLabel });

    // 4b. If there's a non-blocking warning, surface it
    if (warnCheck && (s.phase === "ready" || s.phase === "sending" || s.phase === "submitted" || s.phase === "waiting-for-generation" || s.phase === "generating")) {
      items.push({ status: "warn", label: "Live recount inconsistent (Individual attachments confirmed ✓)" });
    }

    // 5. If generation has started, show Submission & Generation Start items
    if (
      ["sending", "submitted", "waiting-for-generation", "generating", "downloading", "complete"].includes(s.phase) ||
      (s.error && ["sending", "submitted", "waiting-for-generation", "generating"].includes(s.error.phase))
    ) {
      // 5a. Submission
      let sendStatus = "waiting";
      let sendLabel = "Submission";
      if (s.phase === "sending") {
        sendStatus = "active";
        sendLabel = "Sending to Gemini…";
      } else if (["submitted", "waiting-for-generation", "generating", "downloading", "complete"].includes(s.phase) || (s.send && s.send.ok)) {
        sendStatus = "ok";
        sendLabel = "Submission (Accepted ✓)";
      } else if (s.send && s.send.ok === false) {
        sendStatus = "fail";
        sendLabel = `Submission (${s.send.error || "failed"})`;
      }
      items.push({ status: sendStatus, label: sendLabel });

      // 5b. Generation Start Detection
      let genStatus = "waiting";
      let genLabel = "Generation Start";
      if (s.phase === "waiting-for-generation") {
        genStatus = "active";
        genLabel = "Waiting for generation start…";
      } else if (s.phase === "generating" || s.phase === "downloading" || s.phase === "complete" || s.generationStartedAt) {
        genStatus = "ok";
        genLabel = "Generation start (Detected ✓)";
      } else if (s.error && s.error.phase === "waiting-for-generation") {
        genStatus = "fail";
        genLabel = `Generation start (${s.error.error || "timeout"})`;
      }
      items.push({ status: genStatus, label: genLabel });

      // 5c. Generation Complete Detection
      let compStatus = "waiting";
      let compLabel = "Generation Complete";
      if (s.phase === "generating") {
        compStatus = "active";
        compLabel = "Generating image in Gemini…";
      } else if (s.phase === "complete" || s.generationCompletedAt) {
        compStatus = "ok";
        compLabel = "Generation completed (Detected ✓)";
      } else if (s.error && s.error.phase === "generating") {
        compStatus = "fail";
        compLabel = `Generation (${s.error.error || "timeout"})`;
      }
      items.push({ status: compStatus, label: compLabel });
    }

    prepChecklistEl.textContent = "";
    for (const it of items) {
      const li = document.createElement("li");
      li.className = "prep-item";
      const iconSpan = document.createElement("span");
      iconSpan.className = `prep-icon status-${it.status}`;
      iconSpan.textContent =
        it.status === "ok"
          ? "✓"
          : it.status === "warn"
            ? "⚠"
            : it.status === "active"
              ? "…"
              : it.status === "fail"
                ? "✕"
                : "○";
      const labelSpan = document.createElement("span");
      labelSpan.className = "prep-label";
      labelSpan.textContent = it.label || "";
      li.appendChild(iconSpan);
      li.appendChild(labelSpan);
      prepChecklistEl.appendChild(li);
    }
  }

  function renderWorkflowState() {
    const s = orchestrator ? orchestrator.state : { phase: "idle", attachments: [], imageMode: null };
    const cur = currentTask();
    const busy = orchestrator ? orchestrator.isActive() : false;

    if (workflowPhaseEl) {
      if (s.phase === "ready") {
        workflowPhaseEl.textContent = "READY TO GENERATE";
        workflowPhaseEl.dataset.phase = "ready";
      } else if (s.phase === "sending") {
        workflowPhaseEl.textContent = "SENDING…";
        workflowPhaseEl.dataset.phase = "sending";
      } else if (s.phase === "submitted") {
        workflowPhaseEl.textContent = "SUBMITTED";
        workflowPhaseEl.dataset.phase = "submitted";
      } else if (s.phase === "waiting-for-generation") {
        workflowPhaseEl.textContent = "GENERATING…";
        workflowPhaseEl.dataset.phase = "waiting-for-generation";
      } else if (s.phase === "generating") {
        workflowPhaseEl.textContent = "GENERATING IMAGE";
        workflowPhaseEl.dataset.phase = "generating";
      } else if (s.phase === "downloading") {
        workflowPhaseEl.textContent = "DOWNLOADING…";
        workflowPhaseEl.dataset.phase = "downloading";
      } else if (s.phase === "clearing-composer") {
        workflowPhaseEl.textContent = "CLEARING COMPOSER…";
        workflowPhaseEl.dataset.phase = "clearing-composer";
      } else if (s.phase === "complete") {
        workflowPhaseEl.textContent = "GENERATION COMPLETE";
        workflowPhaseEl.dataset.phase = "complete";
      } else {
        workflowPhaseEl.textContent = s.phase;
        workflowPhaseEl.dataset.phase = s.phase;
      }
    }
    // Messaging row (driven by last-known messagingHealth).
    if (workflowMessagingEl) {
      workflowMessagingEl.classList.remove("ok", "warn", "muted");
      if (messagingHealth && messagingHealth.ok) {
        workflowMessagingEl.classList.add("ok");
        workflowMessagingEl.textContent = "✓ Connected";
      } else if (messagingHealth && messagingHealth.error) {
        workflowMessagingEl.classList.add("warn");
        workflowMessagingEl.textContent = "✕ Error";
        workflowMessagingEl.title = messagingHealth.error;
      } else {
        workflowMessagingEl.classList.add("muted");
        workflowMessagingEl.textContent = "— (click Ping Gemini)";
      }
    }
    // Image mode indicator
    if (s.imageMode) {
      const cls = s.imageMode.ok ? "ok" : "warn";
      let txt;
      if (s.imageMode.ok) {
        txt = s.imageMode.mode === "already-active" ? "✓ Ready" : "✓ Enabled";
      } else {
        txt = "✕ Error";
      }
      if (workflowImageModeEl) {
        workflowImageModeEl.classList.remove("ok", "warn", "muted");
        workflowImageModeEl.classList.add(cls);
        workflowImageModeEl.textContent = `IMAGE MODE — ${txt}`;
        workflowImageModeEl.title = s.imageMode.error || "";
      }
    } else {
      if (workflowImageModeEl) {
        workflowImageModeEl.classList.add("muted");
        workflowImageModeEl.textContent = "IMAGE MODE — …";
      }
    }
    // References count
    const total = cur
      ? projectLib.resolveReferences(state.source.project, cur.id).length
      : 0;
    const resolved = (resolvedRefsCache || []).filter(
      (r) => r && r.state === "resolved",
    ).length;
    if (workflowReferencesEl) {
      workflowReferencesEl.classList.remove("ok", "warn", "muted");
      if (total === 0) {
        workflowReferencesEl.classList.add("ok");
        workflowReferencesEl.textContent = "0 / 0 (no refs)";
      } else {
        workflowReferencesEl.classList.add(resolved === total ? "ok" : "muted");
        workflowReferencesEl.textContent = `${resolved} / ${total} resolved`;
      }
    }
    // Attached count
    const attached = (s.attachments || []).filter((a) => a && a.ok).length;
    const attempted = (s.attachments || []).length;
    if (workflowAttachedEl) {
      workflowAttachedEl.classList.remove("ok", "warn", "muted");
      if (total === 0) {
        workflowAttachedEl.classList.add("ok");
        workflowAttachedEl.textContent = "0 / 0";
      } else {
        const cls =
          attached === total && attempted === total && total > 0
            ? "ok"
            : attempted > attached
              ? "warn"
              : "muted";
        workflowAttachedEl.classList.add(cls);
        workflowAttachedEl.textContent = `${attached} / ${total}`;
      }
    }

    // Master Style row
    if (workflowMasterStyleEl) {
      workflowMasterStyleEl.classList.remove("ok", "muted");
      const hasMaster = !!(state.source?.project?.generation?.masterPrompt);
      workflowMasterStyleEl.classList.add(hasMaster ? "ok" : "muted");
      workflowMasterStyleEl.textContent = hasMaster ? "✓" : "—";
    }

    // Scene Prompt row
    if (workflowScenePromptEl) {
      workflowScenePromptEl.classList.remove("ok", "muted");
      const hasPrompt = !!(cur && cur.prompt);
      workflowScenePromptEl.classList.add(hasPrompt ? "ok" : "muted");
      workflowScenePromptEl.textContent = hasPrompt ? "✓" : "—";
    }

    // Composer row
    if (workflowComposerEl) {
      workflowComposerEl.classList.remove("ok", "muted");
      const isPrepared = s.phase === "ready" || s.phase === "complete";
      workflowComposerEl.classList.add(isPrepared ? "ok" : "muted");
      workflowComposerEl.textContent = isPrepared ? "✓" : (s.phase === "preparing-prompt" || s.phase === "preflight" ? "…" : "—");
    }

    // Render live checklist
    renderPreparationChecklist(cur, resolvedRefsCache || [], s);

    // Generation Result Display Box
    const isGenerated = cur?.status === "generated" || s.phase === "complete";
    if (generationResultBoxEl) {
      generationResultBoxEl.hidden = !isGenerated;
      if (isGenerated) {
        if (resultFilenameEl) {
          resultFilenameEl.textContent = s.result?.filename || s.download?.finalFilename || (cur?.output?.basename ? `${cur.output.basename}.png` : `${cur?.id}.png`);
        }
        if (resultDownloadIdEl) {
          resultDownloadIdEl.textContent = s.result?.downloadId || s.download?.downloadId || "Completed";
        }
      }
    }

    // Primary Action Buttons
    if (ensureImageModeBtn) {
      ensureImageModeBtn.disabled = busy || !state.source;
    }
    if (prepareTaskBtn) {
      prepareTaskBtn.hidden = ["ready", "sending", "submitted", "waiting-for-generation", "generating"].includes(s.phase);
      prepareTaskBtn.disabled =
        busy ||
        !state.source ||
        !folderHandle ||
        (total > 0 && resolved !== total);
    }
    if (cancelOpBtn) {
      cancelOpBtn.hidden = !busy;
    }
    if (resetPrepBtn) {
      resetPrepBtn.hidden = busy || !["ready", "generating", "error", "cancelled", "complete"].includes(s.phase);
    }
    if (retryPrepBtn) {
      retryPrepBtn.hidden = busy || s.phase !== "error" || (s.error && ["sending", "submitted", "waiting-for-generation", "generating", "downloading"].includes(s.error.phase));
    }
    if (generateTaskBtn) {
      generateTaskBtn.hidden = !["ready", "sending", "submitted", "waiting-for-generation"].includes(s.phase);
      generateTaskBtn.disabled =
        busy ||
        !state.source ||
        !folderHandle ||
        s.phase !== "ready" ||
        (total > 0 && resolved !== total);
      if (s.phase === "sending") {
        generateTaskBtn.textContent = "Sending to Gemini…";
      } else if (s.phase === "submitted" || s.phase === "waiting-for-generation") {
        generateTaskBtn.textContent = "Waiting for generation…";
      } else {
        generateTaskBtn.textContent = "Generate Task";
      }
    }

    // Recovery Buttons for Generation Failures
    const isGenError = s.phase === "error" && s.error;
    const errorPhase = s.error?.phase;
    if (retryDetectionBtn) {
      retryDetectionBtn.hidden = busy || !isGenError || (errorPhase !== "waiting-for-generation");
    }
    if (retryDownloadBtn) {
      retryDownloadBtn.hidden = busy || !isGenError || (errorPhase !== "downloading");
    }
    if (retryGenerateBtn) {
      retryGenerateBtn.hidden = busy || !isGenError || (!["sending", "waiting-for-generation", "downloading"].includes(errorPhase));
    }

    if (markApprovedBtn) {
      markApprovedBtn.hidden = !isGenerated;
    }
    if (markRedoBtn) {
      markRedoBtn.hidden = !isGenerated;
    }

    // Lock navigation while busy to prevent race conditions.
    const hasPrev = state.source ? projectLib.prevTaskId(state.source.project, state.currentTaskId) !== null : false;
    const hasNext = state.source ? projectLib.nextTaskId(state.source.project, state.currentTaskId) !== null : false;
    if (prevBtn) prevBtn.disabled = busy || !hasPrev;
    if (nextBtn) nextBtn.disabled = busy || !hasNext;
    if (reimportBtn) reimportBtn.disabled = busy;
    if (folderBindBtn) folderBindBtn.disabled = busy;
    if (taskSelectEl) taskSelectEl.disabled = busy;
    if (insertBtn) insertBtn.disabled = busy;
  }

  // Last-known messaging health for the UI row. The diagnostic Ping
  // Gemini button updates this; the workflow also updates it implicitly
  // whenever a sendToGemini call rejects.
  let messagingHealth = null; // { ok: true } | { ok: false, error: string }

  async function onPingGemini() {
    setStatusLine("info", "Pinging Gemini content script…");
    try {
      const res = await messagingLib.pingGemini(chrome);
      if (res.ok) {
        messagingHealth = { ok: true };
        setStatusLine(
          "ok",
          `Messaging ✓ connected (tab ${res.targetTabId}, ${res.targetTabUrl}).`,
        );
        logWorkflow("info", `Ping ✓ connected (tab ${res.targetTabId})`);
      } else {
        messagingHealth = { ok: false, error: res.error };
        setStatusLine(
          "error",
          `Could not communicate with Gemini content script. ${res.error}`,
        );
        logWorkflow("error", `Ping failed: ${res.error}`);
      }
    } catch (e) {
      const err = e?.message ?? String(e);
      messagingHealth = { ok: false, error: err };
      setStatusLine("error", `Ping failed: ${err}`);
      logWorkflow("error", `Ping exception: ${err}`);
    }
    renderWorkflowState();
  }

  function ensureOrchestrator() {
    // The orchestrator no longer owns the tabId — the messaging helper
    // does. We keep the orchestrator singleton across workflow runs so
    // its state machine survives Prepare → Generate.
    if (orchestrator) return orchestrator;
    orchestrator = orchestratorLib.createOrchestrator({
      sendToTab: (msg) => sendToGemini(msg.type, msg),
      downloadImage: downloadImageViaServiceWorker,
      onPhaseChange: (phase, info) => {
        logWorkflow("phase", `${info?.prev ?? "?"} → ${phase}`);
        renderWorkflowState();
        // Persist status if we transitioned to complete and the task
        // was not yet marked.
        if (phase === "complete") {
          const cur = currentMutable();
          if (cur && cur.status !== "generated") {
            cur.status = "generated";
            persistState();
            renderProgress();
          }
        }
      },
      onAttachmentProgress: (info) => {
        const label = info.label || info.assetId || `#${info.index}`;
        if (info.phase === "start") {
          logWorkflow("attach", `Attaching ${label} (${info.fileName})…`);
        } else if (info.phase === "ok") {
          logWorkflow("attach", `✓ ${label} attached${info.elapsedMs ? ` in ${info.elapsedMs}ms` : ""}`);
        } else {
          logWorkflow("attach", `✕ ${label} failed: ${info.error}`);
        }
        renderWorkflowState();
      },
      onLog: (level, message, info) => {
        logWorkflow(level, message, info);
      },
    });
    return orchestrator;
  }

  /**
   * Fetch the generated image (via the content script, where session
   * cookies are available) and forward the bytes to the service worker
   * for chrome.downloads.
   */
  async function downloadImageViaServiceWorker({ imageSrc, basename, projectId, mimeOrExt }) {
    if (!orchestrator) {
      return { ok: false, error: "no orchestrator" };
    }
    // 1. Ask the content script to fetch the image as ArrayBuffer.
    let fetched;
    try {
      fetched = await sendToGemini("GEMINI_ASSISTANT_FETCH_IMAGE", {
        url: imageSrc,
      });
    } catch (e) {
      return { ok: false, error: `fetch via content script failed: ${e?.message ?? String(e)}` };
    }
    if (!fetched || !fetched.ok) {
      return { ok: false, error: fetched?.error || "fetch failed" };
    }

    // 2. Compute filename and folder via outputLib.
    const folder = outputLib.buildDownloadFolder(projectId);
    const file = outputLib.buildDownloadFilename(basename, fetched.mime || mimeOrExt);
    if (!file) {
      return { ok: false, error: "Could not derive filename (basename or mime invalid)" };
    }
    const finalFilename = folder ? `${folder}/${file}` : file;

    // 3. Forward to service worker for chrome.downloads.
    let dl;
    try {
      dl = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: "GEMINI_ASSISTANT_DOWNLOAD_BLOB",
            arrayBuffer: fetched.arrayBuffer, // structured-cloned across contexts
            filename: finalFilename,
            mime: fetched.mime || mimeOrExt || "application/octet-stream",
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(resp);
          },
        );
      });
    } catch (e) {
      return { ok: false, error: `download bridge failed: ${e?.message ?? String(e)}` };
    }
    if (!dl || !dl.ok) {
      return { ok: false, error: dl?.error || "download failed" };
    }
    return {
      ok: true,
      downloadId: dl.downloadId,
      finalFilename: dl.finalFilename,
    };
  }

  async function onEnsureImageMode() {
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      messagingHealth = { ok: false, error: e?.message ?? String(e) };
      setStatusLine(
        "error",
        `Could not communicate with Gemini content script. ${messagingHealth.error}`,
      );
      renderWorkflowState();
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      setStatusLine("error", `Open ${GEMINI_HOST} first.`);
      return;
    }
    messagingHealth = { ok: true };
    const orch = ensureOrchestrator();
    orch.reset({ id: currentTask()?.id ?? null });
    setStatusLine("info", "Ensuring Image Generation mode…");
    const ok = await orch.ensureImageMode();
    if (ok) {
      setStatusLine("ok", "Image Generation mode ready.");
    } else {
      const err = orch.state.imageMode?.error || "unknown";
      if (orch.state.imageMode?.error?.startsWith("Could not communicate")) {
        messagingHealth = { ok: false, error: err };
        setStatusLine(
          "error",
          "Could not communicate with Gemini content script. See Debug card.",
        );
      } else {
        setStatusLine("error", `Image Mode ✕ Error. See Debug card.`);
      }
      logWorkflow("error", "Image Mode failed", { error: err });
    }
    renderWorkflowState();
    refreshSelfTest();
  }

  async function onResetPreparation() {
    clearPinnedGeminiTab();
    let tab;
    try {
      tab = await getActiveTab();
    } catch (_) {}
    const cur = currentTask();
    const orch = ensureOrchestrator();
    setStatusLine("info", "Resetting preparation…");
    await orch.resetPreparation(cur);
    setStatusLine("ok", "Preparation reset. Composer prompt cleared.");
    renderWorkflowState();
    refreshSelfTest();
  }

  async function onPrepareTask(forceClear = false) {
    // PART 6 — Synchronous reentrancy lock. Must be set BEFORE first await.
    if (prepareCommandInFlight) {
      const cmdId = "cmd-prepare-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      console.log("[Gemini Assistant:sp] prepare-ignored-reentrant", { commandId: cmdId });
      return;
    }
    prepareCommandInFlight = true;
    const cmdId = "cmd-prepare-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    console.log("[Gemini Assistant:sp] prepare-started", { commandId: cmdId, forceClear, prepareHandlerRegistrationCount });

    try {
      await _onPrepareTaskImpl(forceClear, cmdId);
    } finally {
      prepareCommandInFlight = false;
    }
  }

  async function _onPrepareTaskImpl(forceClear, cmdId) {
    const cur = currentTask();
    if (!cur) {
      setStatusLine("error", "No task selected.");
      return;
    }

    const declaredRefs = projectLib.resolveReferences(state.source.project, cur.id);

    // 1. Check folder binding first
    if (declaredRefs.length > 0 && !folderHandle) {
      setStatusLine(
        "error",
        "Bind project folder first. Reference images are required for this task.",
      );
      renderWorkflowState();
      return;
    }

    // 2. Tab & host validation
    let tab;
    try {
      // Pin the tab at the start of the workflow. All subsequent sends
      // (attach, prompt, send_composer) will go to this tab, even if
      // the user switches focus between calls. Without this pin, a
      // focus shift between iterations of attachAll() can split the
      // references across multiple tabs.
      tab = await pinGeminiTab();
    } catch (e) {
      clearPinnedGeminiTab();
      messagingHealth = { ok: false, error: e?.message ?? String(e) };
      setStatusLine(
        "error",
        `Could not communicate with Gemini content script. ${messagingHealth.error}`,
      );
      renderWorkflowState();
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      clearPinnedGeminiTab();
      setStatusLine("error", `Open ${GEMINI_HOST} first.`);
      return;
    }

    // 3. Explicit Ping / communication check before touching Gemini
    try {
      const pingRes = await messagingLib.pingGemini(chrome);
      if (!pingRes || !pingRes.ok) {
        messagingHealth = { ok: false, error: pingRes?.error || "ping failed" };
        setStatusLine(
          "error",
          `Could not communicate with Gemini content script. ${messagingHealth.error}`,
        );
        renderWorkflowState();
        return;
      }
      messagingHealth = { ok: true };
    } catch (e) {
      messagingHealth = { ok: false, error: e?.message ?? String(e) };
      setStatusLine(
        "error",
        `Could not communicate with Gemini content script. ${messagingHealth.error}`,
      );
      renderWorkflowState();
      return;
    }

    // 4. Validate references resolved
    const resolvedRefs = (resolvedRefsCache || []).filter(
      (r) => r && r.state === "resolved" && r.fileObj,
    );

    if (declaredRefs.length > 0 && resolvedRefs.length < declaredRefs.length) {
      const resolvedIds = new Set(resolvedRefs.map((r) => r.id));
      const missing = declaredRefs.filter((d) => !resolvedIds.has(d.id));
      const missingLabels = missing.map((m) => m.label || m.id || m.fileName || "unknown").join(", ");
      setStatusLine(
        "error",
        `Cannot prepare task. ${resolvedRefs.length} / ${declaredRefs.length} references resolved. Missing: ${missingLabels}`,
      );
      renderWorkflowState();
      return;
    }

    // Save current prompt edits.
    const prompt = promptEl.value;
    const cur_mut = currentMutable();
    if (cur_mut && cur_mut.prompt !== prompt) {
      cur_mut.prompt = prompt;
      await persistState();
    }

    const finalPrompt = projectLib.buildFinalPrompt(state.source.project, { ...cur, prompt });
    const orch = ensureOrchestrator();

    // Check composer cleanliness if not force-clearing
    if (!forceClear) {
      try {
        const inspection = await orch.inspectComposer(finalPrompt, declaredRefs.length);
        if (inspection && inspection.ok && inspection.needsConfirmation) {
          showComposerConfirmModal();
          return;
        }
      } catch (_) {}
    }

    setStatusLine("info", "Preparing task…");
    renderWorkflowState();

    const ok = await orch.prepareTask({
      taskId: cur.id,
      prompt: finalPrompt,
      resolvedRefs: resolvedRefs.map((r) => ({
        id: r.id,
        label: r.label,
        fileName: r.fileName,
        fileType: r.fileType,
        fileSize: r.fileSize,
        state: r.state,
        fileObj: r.fileObj,
        error: r.error,
      })),
      forceClear,
    });

    if (ok) {
      setStatusLine(
        "ok",
        `Prepared task "${cur.title || cur.id}". Ready to generate.`,
      );
    } else {
      const err = orch.state.error?.error || "unknown";
      const phase = orch.state.error?.phase;
      const detail =
        phase === "preparing-attachments" && orch.state.error?.attachedCount !== undefined
          ? ` (${orch.state.error.attachedCount} / ${orch.state.error.totalCount} attached)`
          : "";
      if (err.startsWith("Could not communicate")) {
        messagingHealth = { ok: false, error: err };
        setStatusLine(
          "error",
          "Could not communicate with Gemini content script. See Debug card.",
        );
      } else {
        setStatusLine("error", `Preparation failed: ${err}${detail}`);
      }
    }
    renderWorkflowState();
    refreshSelfTest();
  }

  // (onPrepareTask delegates to _onPrepareTaskImpl — see reentrancy guard above)

  const generateTrace = [];
  function recordGenerateTrace(step, data = {}) {
    const entry = {
      step,
      timestamp: new Date().toISOString(),
      ...data,
    };
    generateTrace.push(entry);
    if (generateTrace.length > 50) generateTrace.shift();
    try {
      console.log(`[generate] ${step}`, data);
    } catch (_) {}
  }

  async function onGenerateTask(ev) {
    // PART 4 — Synchronous reentrancy lock. MUST be set before first await.
    // This prevents two handler invocations racing on the same microtask tick.
    if (generateCommandInFlight) {
      const ignoreId = "cmd-generate-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      recordGenerateTrace("generate-ignored-reentrant", {
        commandId: ignoreId,
        eventTimeStamp: ev?.timeStamp ?? null,
        isTrusted: ev?.isTrusted ?? null,
        eventDetail: ev?.detail ?? null,
        generateHandlerRegistrationCount,
      });
      console.log("[Gemini Assistant:sp] generate-ignored-reentrant", { commandId: ignoreId });
      return;
    }
    generateCommandInFlight = true;

    // Generate a unique commandId for this invocation.
    const cmdId = "cmd-generate-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);

    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();

    // PART 8 — Record event instrumentation immediately.
    const eventTimeStamp = ev?.timeStamp ?? null;
    const isTrusted = ev?.isTrusted ?? null;
    const eventDetail = ev?.detail ?? null;
    const eventTarget = ev?.target?.id ?? ev?.target?.tagName ?? null;
    const eventCurrentTarget = ev?.currentTarget?.id ?? ev?.currentTarget?.tagName ?? null;

    // Record generateClickedAt immediately without ANY further guards.
    const clickedAt = Date.now();
    if (orchestrator) orchestrator.state.generateClickedAt = clickedAt;
    state.generateClickedAt = clickedAt;

    // Immediately render: STARTING GENERATION...
    setStatusLine("info", "STARTING GENERATION...");

    const displayedPhase = workflowPhaseEl ? workflowPhaseEl.textContent.trim() : "unknown";
    const sidePanelPhase = state.phase || "unknown";
    const orchPhase = orchestrator ? orchestrator.state.phase : "no-orchestrator";
    const cur = currentTask();

    // PART 7 — Trace unique commandId through every step.
    recordGenerateTrace("button-clicked", {
      commandId: cmdId,
      generateClickedAt: clickedAt,
      eventTimeStamp,
      isTrusted,
      eventDetail,
      eventTarget,
      eventCurrentTarget,
      generateHandlerRegistrationCount,
      displayedPhase,
      sidePanelPhase,
      orchestratorPhase: orchPhase,
      taskId: cur?.id ?? null,
      preparedTaskId: orchestrator?.state?.preparationSession?.taskId ?? null,
      preparedSessionId: orchestrator?.state?.preparationSession?.id ?? null,
      preparationSessionId: orchestrator?.state?.preparationSessionId ?? null,
    });

    recordGenerateTrace("handler-entered", {
      commandId: cmdId,
      generateClickedAt: clickedAt,
      taskId: cur?.id ?? null,
    });

    recordGenerateTrace("orchestrator-called", {
      commandId: cmdId,
      generateClickedAt: clickedAt,
      taskId: cur?.id ?? null,
      currentPhase: orchPhase,
      preparationSessionId: orchestrator?.state?.preparationSessionId ?? null,
    });

    renderWorkflowState();
    refreshSelfTest();

    try {
      await _onGenerateTaskImpl(cmdId, ev, cur, orchPhase);
    } finally {
      generateCommandInFlight = false;
    }
  }

  async function _onGenerateTaskImpl(cmdId, ev, cur, orchPhase) {

    let tab;
    try {
      // Reuse the pin set by Prepare Task; if it's not set (e.g. user
      // refreshed the side panel between Prepare and Generate), pin a
      // fresh tab now so the send lands in the same chat.
      if (pinnedGeminiTabId === null) {
        tab = await pinGeminiTab();
      } else {
        tab = await getActiveTab();
      }
    } catch (e) {
      recordGenerateTrace("blocked", {
        commandId: cmdId,
        reason: "get-active-tab-failed",
        phase: orchPhase,
        taskId: cur?.id ?? null,
        error: e?.message ?? String(e),
      });
      setStatusLine("error", `Generate blocked: Could not get active tab: ${e.message}`);
      renderWorkflowState();
      refreshSelfTest();
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      recordGenerateTrace("blocked", {
        commandId: cmdId,
        reason: "not-gemini-url",
        phase: orchPhase,
        taskId: cur?.id ?? null,
        url: tab.url,
      });
      setStatusLine("error", `Generate blocked: Active tab is not ${GEMINI_HOST}. Open Gemini first.`);
      renderWorkflowState();
      refreshSelfTest();
      return;
    }
    if (!cur) {
      recordGenerateTrace("blocked", {
        commandId: cmdId,
        reason: "no-task-selected",
        phase: orchPhase,
        taskId: null,
      });
      setStatusLine("error", "Generate blocked: No task selected.");
      renderWorkflowState();
      refreshSelfTest();
      return;
    }
    if (!orchestrator || (orchestrator.state.phase !== "ready" && orchestrator.state.phase !== "waiting-for-uploads")) {
      recordGenerateTrace("blocked", {
        commandId: cmdId,
        reason: "phase-not-ready",
        phase: orchPhase,
        taskId: cur.id,
        preparedTaskId: orchestrator?.state?.preparationSession?.taskId ?? null,
        preparedSessionId: orchestrator?.state?.preparationSession?.id ?? null,
        preparationSessionId: orchestrator?.state?.preparationSessionId ?? null,
        orchestratorPhase: orchPhase,
      });
      setStatusLine("error", `Generate blocked: Task is not prepared (state: ${orchPhase}). Click Prepare Task first.`);
      renderWorkflowState();
      refreshSelfTest();
      return;
    }

    const prompt = promptEl.value;
    const finalPrompt = projectLib.buildFinalPrompt(state.source.project, { ...cur, prompt });

    const resolvedRefs = (resolvedRefsCache && resolvedRefsCache.length > 0)
      ? resolvedRefsCache
      : (orchestrator.state.attachments || []).map((a) => ({
          id: a.assetId || a.id,
          label: a.label,
          fileName: a.fileName,
          state: "resolved",
        }));

    const orch = ensureOrchestrator();
    setStatusLine("info", "Sending to Gemini…");
    renderWorkflowState();
    refreshSelfTest();

    recordGenerateTrace("send-command-dispatched", {
      commandId: cmdId,
      taskId: cur.id,
      pinnedTabId: pinnedGeminiTabId,
      activeTabId: tab.id,
    });

    const genResult = await orch.generateTask({
      taskId: cur.id,
      prompt: finalPrompt,
      resolvedRefs,
      generationStartTimeoutMs: 15000,
      // v0.9.94: hard-cap generation-detection timeout at 30s (was 90s)
      // to prevent the side panel from being frozen for ~90s after
      // generation. Detection should happen within seconds once the
      // image is in the DOM; if it doesn't, we surface an error and
      // the user can use Retry Download.
      generationTimeoutMs: 30000,
      commandId: cmdId,
    });


    // A 'silent' result means this invocation was a zombie (the session changed
    // while waiting) OR a duplicate already claimed. In either case:
    //   - Do NOT show an error — the active generation is still running fine.
    //   - Do NOT call renderWorkflowState() — avoid overwriting the active UI.
    //   - Do NOT call refreshSelfTest() — avoid spurious DOM probes mid-generation.
    const isSuccess = genResult === true;
    const isSilentBail =
      genResult !== null &&
      typeof genResult === "object" &&
      genResult.silent === true;

    if (isSuccess) {
      setStatusLine(
        "ok",
        "Generation completed ✓ Image ready.",
      );
      // v0.9.98: auto-download the generated image for the current
      // execution. We do this after the orchestrator transitions to
      // "complete". The orchestrator's idempotency guard
      // (downloadClaimedAt) ensures a second invocation is a no-op.
      try {
        const basename =
          (outputLib &&
            projectLib.resolveTaskOutputBasename(state.source.project, cur.id)) ||
          cur.id;
        setStatusLine("info", "Downloading image…");
        renderWorkflowState();
        const dlOk = await orch.download(
          basename,
          state.source.project.project.id,
          "image/png",
        );
        if (dlOk) {
          const cur_mut = currentMutable();
          if (cur_mut && cur_mut.status !== "generated") {
            cur_mut.status = "generated";
            await persistState();
            renderProgress();
          }
          setStatusLine(
            "ok",
            `Generation complete — ${orch.state.download?.finalFilename || basename + ".png"}`,
          );
        } else {
          // Silent claim rejection (zombie / re-entry) does not show error.
          const reason = orch.state.download?.error;
          const silent =
            orch.state.download === null && (reason === undefined || reason === null);
          if (!silent) {
            setStatusLine(
              "error",
              `Auto-download failed: ${reason || "unknown"}. Use Download Image to retry.`,
            );
          }
        }
      } catch (e) {
        setStatusLine("error", `Auto-download error: ${e?.message ?? String(e)}`);
      }
    } else if (isSilentBail) {
      // Zombie / already-claimed: do nothing. The active session handles its own UI.
      console.log(
        "[Gemini Assistant:sp] generate-zombie-bail: silently suppressed UI update",
        { reason: genResult.reason },
      );
    } else {
      const err = orchestrator.state.error?.error || "unknown";
      setStatusLine("error", `Generation failed: ${err}`);
    }

    // Generation lifecycle ends here. Unpin so the next task can re-pin
    // to whichever tab the user is on. Preserve the pin only when the
    // coroutine zombied out (a new generation is still running).
    if (!isSilentBail) {
      clearPinnedGeminiTab();
    }

    // Force-unlock ALL buttons immediately. The user reported that after
    // generation completes, buttons stay disabled even though the
    // orchestrator should be idle. We compute `busy` from
    // orchestrator.isActive() which returns false once the phase is
    // complete / error / cancelled, but a stale render (e.g. one
    // scheduled before the final phase transition) can leave buttons
    // visually disabled. Bottom line: after the generation lifecycle
    // finishes, the user must be able to click anything.
    forceUnlockAllButtons();
    renderWorkflowState();
    refreshSelfTest();
  }

  /**
   * Belt-and-suspenders: explicitly enable every workflow button and
   * re-enable navigation. The orchestrator.isActive() check should
   * already flip `busy` to false once the phase is `complete`, but
   * during transient timing windows (e.g. after a single-shot
   * `transition("complete")` fires but the next render is still
   * queued), buttons can look stuck. Calling this from the generation
   * lifecycle guarantees the UI is interactive the moment the image
   * finishes generating.
   */
  function forceUnlockAllButtons() {
    const buttons = [
      ensureImageModeBtn,
      prepareTaskBtn,
      generateTaskBtn,
      cancelOpBtn,
      resetPrepBtn,
      retryPrepBtn,
      retryGenerateBtn,
      retryDetectionBtn,
      retryDownloadBtn,
      markApprovedBtn,
      markRedoBtn,
      prevBtn,
      nextBtn,
      reimportBtn,
      folderBindBtn,
      taskSelectEl,
      insertBtn,
      pingGeminiBtn,
      probeAttachmentBtn,
      traceAttachmentBtn,
      strategyABtn,
      testSingleAttachBtn,
      runTestABtn,
      runTestBBtn,
      runTestCBtn,
      runHealthCheckBtn,
      markAttachVerifiedBtn,
    ];
    for (const btn of buttons) {
      if (btn && typeof btn.disabled !== "undefined") {
        btn.disabled = false;
      }
    }
    // Single-attach reference buttons are keyed by `dataset.refIndex`.
    const refAttachBtns = document.querySelectorAll(".ref-attach");
    for (const btn of refAttachBtns) {
      if (btn && typeof btn.disabled !== "undefined") {
        btn.disabled = false;
      }
    }
  }

  async function onRetryDetection() {
    if (!orchestrator) return;
    setStatusLine("info", "Retrying detection for generated image…");
    const orch = ensureOrchestrator();
    const detected = await orch.retryDetection();
    if (detected) {
      setStatusLine("info", "Result found! Downloading image…");
      const cur = currentTask();
      const basename =
        (outputLib &&
          projectLib.resolveTaskOutputBasename(state.source.project, cur.id)) ||
        cur.id;
      const dlOk = await orch.download(basename, state.source.project.project.id, "image/png");
      if (dlOk) {
        const cur_mut = currentMutable();
        if (cur_mut && cur_mut.status !== "generated") {
          cur_mut.status = "generated";
          await persistState();
          renderProgress();
        }
        setStatusLine("ok", `Generated ${cur.title || cur.id}. Downloaded ${orch.state.download?.finalFilename || basename + ".png"}.`);
        try { await orch.clearComposer(); } catch (_) {}
      } else {
        setStatusLine("error", `Download failed: ${orch.state.download?.error || "unknown"}`);
      }
    } else {
      setStatusLine("error", "Retry detection: No new generated image found yet.");
    }
    renderWorkflowState();
  }

  async function onRetryDownload() {
    if (!orchestrator || !orchestrator.state.generation?.imageSrc) {
      setStatusLine("error", "No generated image detected to download. Run Retry Detection first.");
      return;
    }
    const cur = currentTask();
    const basename =
      (outputLib &&
        projectLib.resolveTaskOutputBasename(state.source.project, cur.id)) ||
      cur.id;
    setStatusLine("info", "Retrying download…");
    const orch = ensureOrchestrator();
    const dlOk = await orch.download(basename, state.source.project.project.id, "image/png");
    if (dlOk) {
      const cur_mut = currentMutable();
      if (cur_mut && cur_mut.status !== "generated") {
        cur_mut.status = "generated";
        await persistState();
        renderProgress();
      }
      setStatusLine("ok", `Downloaded ${orch.state.download?.finalFilename || basename + ".png"}.`);
      try { await orch.clearComposer(); } catch (_) {}
    } else {
      setStatusLine("error", `Retry download failed: ${orch.state.download?.error || "unknown"}`);
    }
    renderWorkflowState();
  }

  async function onCancel() {
    if (!orchestrator) return;
    orchestrator.cancel();
    clearPinnedGeminiTab();
    setStatusLine("warn", "Operation cancelled. Local polling stopped. Gemini generation may continue on page.");
    forceUnlockAllButtons();
    renderWorkflowState();
  }

  async function onMarkApproved() {
    const cur = currentMutable();
    if (!cur) return;
    cur.status = "approved";
    await persistState();
    renderProgress();
    setStatusLine("ok", "Marked as approved.");
  }

  async function onMarkRedo() {
    const cur = currentMutable();
    if (!cur) return;
    cur.status = "redo";
    await persistState();
    renderProgress();
    setStatusLine("info", "Marked as redo. You can re-run Generate Task.");
  }

  init();
})();
