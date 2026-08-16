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

  const selfTestEl = $("#selftest");

  const statusEl = $("#status");
  const statusText = $("#status-text");

  const overlayEl = $("#confirm-overlay");
  const confirmCancelBtn = $("#confirm-cancel");
  const confirmOkBtn = $("#confirm-ok");

  // v0.6: workflow
  const outputLib = globalThis.GeminiAssistantOutput;
  const orchestratorLib = globalThis.GeminiAssistantOrchestrator;

  const workflowImageModeEl = $("#workflow-image-mode");
  const workflowReferencesEl = $("#workflow-references");
  const workflowAttachedEl = $("#workflow-attached");
  const workflowMessagingEl = $("#workflow-messaging");
  const workflowPhaseEl = $("#workflow-phase");
  const workflowLogEl = $("#workflow-log");
  const ensureImageModeBtn = $("#ensure-image-mode-btn");
  const prepareTaskBtn = $("#prepare-task-btn");
  const generateTaskBtn = $("#generate-task-btn");
  const cancelOpBtn = $("#cancel-op-btn");
  const markApprovedBtn = $("#mark-approved-btn");
  const markRedoBtn = $("#mark-redo-btn");
  const pingGeminiBtn = $("#ping-gemini-btn");

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

  // High-level: resolve tab + send typed message. The orchestrator uses
  // this; the legacy single-attach / probe paths still use sendMessage
  // directly because they already validated the tab.
  async function sendToGemini(type, payload) {
    return await messagingLib.sendToGemini(chrome, type, payload || {});
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

    // Prompt
    promptEl.value = cur?.prompt ?? currentTask()?.prompt ?? "";

    // Prev/Next enable state
    prevBtn.disabled = projectLib.prevTaskId(proj, state.currentTaskId) === null;
    nextBtn.disabled = projectLib.nextTaskId(proj, state.currentTaskId) === null;

    // Workflow buttons need fresh state too.
    if (typeof renderWorkflowState === "function") renderWorkflowState();
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

  async function navigate(taskId) {
    if (!taskId) return;
    const cur = currentMutable();
    if (cur) cur.prompt = promptEl.value;
    state.currentTaskId = taskId;
    await persistState();
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

    setBusy(true);
    setStatusLine("info", "Inserting into Gemini…");

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
        text,
      });
      if (result && result.ok) {
        const method = result.method ? ` via ${result.method}` : "";
        log(`inserted ${result.length} chars${method}`);
        setStatusLine(
          "ok",
          `Prompt inserted into Gemini (${result.length} chars${method}). Review and send.`,
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

    try {
      const result = await sendMessage(tab.id, {
        type: "GEMINI_ASSISTANT_ATTACH",
        file,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
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
          selfTestEl.textContent = JSON.stringify(res.selfTest, null, 2);
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

  // ----- wiring -----------------------------------------------------------

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

  if (ensureImageModeBtn) ensureImageModeBtn.addEventListener("click", onEnsureImageMode);
  if (prepareTaskBtn) prepareTaskBtn.addEventListener("click", onPrepareTask);
  if (generateTaskBtn) generateTaskBtn.addEventListener("click", onGenerateTask);
  if (cancelOpBtn) cancelOpBtn.addEventListener("click", onCancel);
  if (markApprovedBtn) markApprovedBtn.addEventListener("click", onMarkApproved);
  if (markRedoBtn) markRedoBtn.addEventListener("click", onMarkRedo);
  if (pingGeminiBtn) pingGeminiBtn.addEventListener("click", onPingGemini);

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

  function renderWorkflowState() {
    // Always refresh the workflow UI, even when the orchestrator hasn't
    // been created yet (e.g. user just bound a folder and we need to
    // re-evaluate the Prepare button).
    const s = orchestrator ? orchestrator.state : { phase: "idle", attachments: [], imageMode: null };
    if (workflowPhaseEl) {
      workflowPhaseEl.textContent = s.phase;
      workflowPhaseEl.dataset.phase = s.phase;
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
        // v0.6.1: short, friendly error in the main UI; details in Debug.
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
    const total = currentTask()
      ? projectLib.resolveReferences(state.source.project, currentTask().id).length
      : 0;
    const resolved = (resolvedRefsCache || []).filter(
      (r) => r && r.state === "resolved",
    ).length;
    if (workflowReferencesEl) {
      workflowReferencesEl.classList.remove("ok", "warn", "muted");
      workflowReferencesEl.classList.add(resolved === total && total > 0 ? "ok" : "muted");
      workflowReferencesEl.textContent = `${resolved} / ${total} resolved`;
    }
    // Attached count
    const attached = s.attachments.filter((a) => a && a.ok).length;
    const attempted = s.attachments.length;
    if (workflowAttachedEl) {
      workflowAttachedEl.classList.remove("ok", "warn", "muted");
      const cls =
        attached === total && attempted === total && total > 0
          ? "ok"
          : attempted > attached
            ? "warn"
            : "muted";
      workflowAttachedEl.classList.add(cls);
      workflowAttachedEl.textContent = `${attached} / ${total}`;
    }
    // Buttons
    const busy = orchestrator ? orchestrator.isActive() : false;
    if (ensureImageModeBtn) {
      ensureImageModeBtn.disabled = busy || !state.source;
    }
    if (prepareTaskBtn) {
      prepareTaskBtn.disabled =
        busy || !state.source || !folderHandle || total === 0 || resolved !== total;
    }
    if (generateTaskBtn) {
      // Enable only after a successful prepare.
      generateTaskBtn.disabled =
        busy ||
        !state.source ||
        !folderHandle ||
        s.phase !== "ready" ||
        (total > 0 && attached !== total);
    }
    if (cancelOpBtn) {
      cancelOpBtn.hidden = !busy;
    }
    if (markApprovedBtn) {
      markApprovedBtn.hidden = s.phase !== "complete";
    }
    if (markRedoBtn) {
      markRedoBtn.hidden = s.phase !== "complete";
    }
    // Lock navigation while busy.
    if (prevBtn) prevBtn.disabled = busy || (projectLib.prevTaskId(state.source.project, state.currentTaskId) === null);
    if (nextBtn) nextBtn.disabled = busy || (projectLib.nextTaskId(state.source.project, state.currentTaskId) === null);
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
      } else {
        messagingHealth = { ok: false, error: res.error };
        setStatusLine(
          "error",
          `Could not communicate with Gemini content script. ${res.error}`,
        );
      }
    } catch (e) {
      messagingHealth = { ok: false, error: e?.message ?? String(e) };
      setStatusLine("error", `Ping failed: ${messagingHealth.error}`);
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

    // 2. Compute filename via outputLib.
    const finalFilename =
      outputLib.buildDownloadFilename(basename, fetched.mime || mimeOrExt);
    if (!finalFilename) {
      return { ok: false, error: "Could not derive filename (basename or mime invalid)" };
    }

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

  async function onPrepareTask() {
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
    const cur = currentTask();
    if (!cur) {
      setStatusLine("error", "No task selected.");
      return;
    }
    const refs = (resolvedRefsCache || []).filter(
      (r) => r && r.state === "resolved",
    );
    if (refs.length === 0) {
      setStatusLine("error", "No references resolved for this task.");
      return;
    }
    // Save current prompt edits.
    const prompt = promptEl.value;
    const cur_mut = currentMutable();
    if (cur_mut && cur_mut.prompt !== prompt) {
      cur_mut.prompt = prompt;
      await persistState();
    }
    // Safety: refuse if composer is not clean.
    try {
      const cs = await sendMessage(tab.id, {
        type: "GEMINI_ASSISTANT_COMPOSER_STATE",
      });
      if (cs && cs.ok && (cs.attachmentCount > 0 || cs.promptLength > 0)) {
        const proceed = window.confirm(
          "The composer is not clean (attachments or text remain). " +
            "Continuing will APPEND to the existing content and may fail. " +
            "Press OK to proceed anyway, or Cancel to clear the composer manually first.",
        );
        if (!proceed) return;
      }
    } catch (_) {
      /* non-fatal */
    }

    const orch = ensureOrchestrator();
    setStatusLine("info", "Preparing task…");
    const ok = await orch.prepareTask({
      taskId: cur.id,
      prompt,
      resolvedRefs: refs.map((r) => ({
        id: r.id,
        label: r.label,
        fileName: r.fileName,
        fileType: r.fileType,
        fileSize: r.fileSize,
        state: r.state,
        fileObj: r.fileObj,
        error: r.error,
      })),
    });
    if (ok) {
      setStatusLine(
        "ok",
        `Prepared task "${cur.title || cur.id}". Review and click Generate Task when ready.`,
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

  async function onGenerateTask() {
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatusLine("error", `Generate failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      setStatusLine("error", `Open ${GEMINI_HOST} first.`);
      return;
    }
    const cur = currentTask();
    if (!cur) {
      setStatusLine("error", "No task selected.");
      return;
    }
    if (!orchestrator || orchestrator.state.phase !== "ready") {
      setStatusLine("error", "Task is not prepared. Click Prepare Task first.");
      return;
    }
    const basename =
      (outputLib &&
        projectLib.resolveTaskOutputBasename(state.source.project, cur.id)) ||
      cur.id;
    const orch = ensureOrchestrator();
    setStatusLine("info", "Generating…");
    const ok = await orch.generateTask({
      taskId: cur.id,
      prompt: promptEl.value,
      resolvedRefs: (orchestrator.state.attachments || []).map((a) => a),
      basename,
      projectId: state.source.project.project.id,
      mimeOrExt: "image/png", // refined later from fetch mime
      generationTimeoutMs: 90000,
    });
    if (ok) {
      const dl = orchestrator.state.download;
      setStatusLine(
        "ok",
        `Generated ${cur.title || cur.id}. ` +
          `Downloaded ${dl?.finalFilename || basename + ".png"}.`,
      );
    } else {
      const phase = orchestrator.state.error?.phase;
      const err = orchestrator.state.error?.error || "unknown";
      setStatusLine("error", `Generation failed at ${phase}: ${err}`);
    }
    renderWorkflowState();
    refreshSelfTest();
  }

  async function onCancel() {
    if (!orchestrator) return;
    orchestrator.cancel();
    setStatusLine("warn", "Operation cancelled. Local polling stopped.");
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
