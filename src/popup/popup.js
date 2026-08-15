/*
 * popup.js
 *
 * UI orchestration for the Project & Task Manager.
 *
 * Responsibilities:
 *   - Load/save state from chrome.storage.local.
 *   - Import Project JSON, validate, confirm replacement.
 *   - Bind a project folder via the File System Access API
 *     (window.showDirectoryPicker) so asset paths can be resolved.
 *   - Resolve each task's references against the bound folder; render
 *     state (resolved / missing / unsupported / unbound) and a per-row
 *     Attach button when the asset is an image we support.
 *   - Render the loaded project: task selector, title, status, prompt.
 *   - Handle Previous/Next navigation and per-task prompt edits.
 *   - Hand off "Insert Prompt" to the content script (which calls the
 *     DOM adapter). Never auto-submits.
 *   - Hand off "Attach" (single reference) to the content script the
 *     same way. Never auto-sends.
 *
 * The popup knows nothing about Gemini's DOM. The DOM adapter lives in
 * src/dom/geminiDomAdapter.js and is invoked only via the content script
 * message bridge.
 *
 * Folder binding is kept in-memory for the PoC: the
 * FileSystemDirectoryHandle cannot be reliably rehydrated across a popup
 * close without re-prompting the user. Closing and reopening the popup
 * requires re-binding. This is documented in the UI ("bound to this
 * session").
 */

(function () {
  "use strict";

  const projectLib = globalThis.GeminiAssistantProject;
  const storageLib = globalThis.GeminiAssistantStorage;
  const assetsLib = globalThis.GeminiAssistantAssets;

  if (!projectLib || !storageLib || !assetsLib) {
    document.body.textContent =
      "Internal error: GeminiAssistant libs not loaded.";
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
  const taskSelectEl = $("#task-select");
  const statusSelectEl = $("#status-select");
  const taskTitleEl = $("#task-title");
  const taskCurrentEls = [$("#task-current"), $("#task-current-2")];
  const taskTotalEls = [$("#task-total"), $("#task-total-2")];
  const promptEl = $("#prompt");
  const insertBtn = $("#insert-btn");
  const prevBtn = $("#prev-btn");
  const nextBtn = $("#next-btn");
  const progressSummaryEl = $("#progress-summary");

  const referencesCountEl = $("#references-count");
  const referencesListEl = $("#references-list");
  const referencesEmptyEl = $("#references-empty");

  const folderBindingEl = $("#folder-binding");
  const folderBindingNameEl = $("#folder-binding-name");
  const folderBindBtn = $("#folder-bind-btn");

  const assetsPanelEl = $("#assets-panel");
  const assetsListEl = $("#assets-list");
  const assetsSummaryEl = $("#assets-summary");

  const statusEl = $("#status");
  const statusText = $("#status-text");
  const selfTestEl = $("#selftest");

  const overlayEl = $("#confirm-overlay");
  const confirmCancelBtn = $("#confirm-cancel");
  const confirmOkBtn = $("#confirm-ok");

  // ----- state (in-memory) ------------------------------------------------

  let state = storageLib.emptyState();
  // last user-typed prompt (debounced-saved)
  let promptSaveTimer = null;
  // Folder binding is intentionally session-only (see file header).
  let folderHandle = null;
  let folderName = "";
  // Cache of resolved refs for the current task. Shape:
  //   [{ id, label, type, file, state, fileObj|null, error|null, fileName?, fileType?, fileSize? }]
  // fileObj is dropped on task navigation to avoid holding bytes.
  let resolvedRefsCache = null;

  // ----- helpers ----------------------------------------------------------

  const POPUP_LOG_PREFIX = "[Gemini Assistant:popup]";

  function popupLog(...args) {
    console.log(POPUP_LOG_PREFIX, ...args);
  }

  function popupWarn(...args) {
    console.warn(POPUP_LOG_PREFIX, ...args);
  }

  function setStatusLine(state, text) {
    statusEl.dataset.state = state;
    statusText.textContent = text;
  }

  function setBusy(busy) {
    insertBtn.disabled = busy;
    insertBtn.textContent = busy ? "Inserting…" : "Insert Prompt";
  }

  function getActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!tabs || tabs.length === 0) {
          reject(new Error("No active tab"));
          return;
        }
        resolve(tabs[0]);
      });
    });
  }

  const GEMINI_HOST = "gemini.google.com";

  function isGeminiUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && u.host === GEMINI_HOST;
    } catch {
      return false;
    }
  }

  function sendMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

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
      // User cancelled or denied. Not an error — just leave state as-is.
      if (e && (e.name === "AbortError" || e.code === 20)) {
        popupLog("folder bind: cancelled by user");
        return;
      }
      popupWarn("folder bind failed", e?.message ?? String(e));
      setStatusLine("error", `Failed to bind folder: ${e?.message ?? "unknown error"}`);
      return;
    }
    folderHandle = handle;
    folderName = handle?.name ?? "Bound folder";
    setStatusLine("ok", `Bound to folder: ${folderName}.`);
    renderFolderBinding();
    // Re-resolve references for the current task, if any.
    if (currentTask()) {
      await resolveCurrentRefs();
      renderReferences();
    }
  }

  function unbindFolder() {
    folderHandle = null;
    folderName = "";
    // Drop any cached File objects to free memory.
    resolvedRefsCache = null;
    setStatusLine("info", "Folder unbound.");
    renderFolderBinding();
    if (currentTask()) {
      renderReferences();
    }
  }

  function renderFolderBinding() {
    if (folderHandle) {
      folderBindingNameEl.textContent = folderName || "Bound";
      folderBindingNameEl.classList.remove("unbound");
      folderBindBtn.textContent = "Rebind";
      folderBindBtn.title = "Re-bind this project to a folder";
    } else {
      folderBindingNameEl.textContent = "Not bound (session only)";
      folderBindingNameEl.classList.add("unbound");
      folderBindBtn.textContent = "Bind…";
      folderBindBtn.title = "Bind a local folder so reference paths resolve";
    }
  }

  // ----- asset resolution -------------------------------------------------

  async function resolveCurrentRefs() {
    resolvedRefsCache = null;
    const task = currentTask();
    if (!task) return;
    const rawRefs = projectLib.resolveReferences(state.source.project, task.id);
    if (rawRefs.length === 0) return;
    if (!folderHandle) {
      // No folder bound: cache as "unbound" placeholders so the UI can
      // still render them with a disabled Attach button.
      resolvedRefsCache = rawRefs.map((r) => ({
        id: r.id,
        label: r.label,
        type: r.type,
        file: r.file,
        state: "unbound",
        fileObj: null,
        error: "Bind the project folder to enable Attach",
      }));
      return;
    }
    const results = await assetsLib.resolveReferences(folderHandle, rawRefs);
    resolvedRefsCache = results.map((res, i) => {
      const r = rawRefs[i];
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
      };
    });
  }

  // ----- render -----------------------------------------------------------

  function render() {
    if (!state.source) {
      emptyStateEl.hidden = false;
      loadedStateEl.hidden = true;
      setStatusLine("idle", "Idle");
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
      projectStatsEl.textContent =
        `${assetCount} asset${assetCount === 1 ? "" : "s"} in catalog`;
      projectStatsEl.hidden = false;
    } else {
      projectStatsEl.hidden = true;
    }

    // Folder binding (always rendered when a project is loaded).
    renderFolderBinding();

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

    // References (current task) — render from cache when available,
    // otherwise from raw metadata with "unbound" state.
    renderReferences();

    // Asset catalog (collapsible)
    renderAssetCatalog();

    // Prompt
    promptEl.value = cur?.prompt ?? currentTask()?.prompt ?? "";

    // Prev/Next enable state
    prevBtn.disabled = projectLib.prevTaskId(proj, state.currentTaskId) === null;
    nextBtn.disabled = projectLib.nextTaskId(proj, state.currentTaskId) === null;

    // Progress
    renderProgress();
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
      return;
    }
    referencesCountEl.textContent = String(rawRefs.length);
    referencesEmptyEl.hidden = true;

    for (let i = 0; i < rawRefs.length; i++) {
      const r = rawRefs[i];
      const cached = resolvedRefsCache && resolvedRefsCache[i];
      const li = document.createElement("li");
      li.className = "ref-item";

      const stateIcon = document.createElement("span");
      stateIcon.className = "ref-state";
      const stateName = (cached && cached.state) || (folderHandle ? "missing" : "unbound");
      stateIcon.classList.add(`state-${stateName}`);
      stateIcon.textContent = stateGlyph(stateName);
      stateIcon.title = stateTitle(stateName, cached);
      li.appendChild(stateIcon);

      const badge = document.createElement("span");
      badge.className = `ref-badge type-${r.type}`;
      badge.textContent = r.type;
      li.appendChild(badge);

      const meta = document.createElement("div");
      meta.className = "ref-meta";
      const label = document.createElement("div");
      label.className = "ref-label";
      label.textContent = r.label;
      const file = document.createElement("div");
      file.className = "ref-file";
      file.textContent = r.file;
      file.title = r.file;
      meta.appendChild(label);
      meta.appendChild(file);
      li.appendChild(meta);

      const idEl = document.createElement("span");
      idEl.className = "ref-id";
      idEl.textContent = r.id;
      li.appendChild(idEl);

      // Attach button — present on every row, enabled only when resolved
      // (i.e. supported image we can find in the bound folder).
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ref-attach ghost";
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
      li.appendChild(btn);

      // Optional one-line note for non-resolved rows so the user knows why.
      if (stateName !== "resolved") {
        const note = document.createElement("div");
        note.className = "ref-state-note";
        note.textContent = attachDisabledReason(stateName, cached);
        li.appendChild(note);
      }

      referencesListEl.appendChild(li);
    }
  }

  function stateGlyph(state) {
    switch (state) {
      case "resolved": return "✓";
      case "missing": return "✕";
      case "unsupported": return "✕";
      case "unbound": return "·";
      default: return "?";
    }
  }

  function stateTitle(state, cached) {
    switch (state) {
      case "resolved":
        return `Resolved (${cached?.fileName ?? "image"})`;
      case "missing":
        return `File not found at ${cached?.file ?? "(unknown path)"}`;
      case "unsupported":
        return `Unsupported file type (${cached?.fileType || "unknown"})`;
      case "unbound":
        return "Bind the project folder to enable attachment";
      default:
        return "Unknown state";
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
    assetsSummaryEl.textContent = `Assets · ${assetCount}`;
    assetsListEl.innerHTML = "";
    const assets = proj.assets;
    for (const id of Object.keys(assets)) {
      const a = assets[id];
      const li = document.createElement("li");
      li.className = "asset-item";
      const badge = document.createElement("span");
      badge.className = `ref-badge type-${a.type}`;
      badge.textContent = a.type;
      const meta = document.createElement("div");
      meta.className = "ref-meta";
      const label = document.createElement("div");
      label.className = "ref-label";
      label.textContent = a.label;
      const file = document.createElement("div");
      file.className = "ref-file";
      file.textContent = a.file;
      file.title = a.file;
      meta.appendChild(label);
      meta.appendChild(file);
      const idEl = document.createElement("span");
      idEl.className = "ref-id";
      idEl.textContent = id;
      li.appendChild(badge);
      li.appendChild(meta);
      li.appendChild(idEl);
      assetsListEl.appendChild(li);
    }
  }

  // ----- persist ----------------------------------------------------------

  async function persistState() {
    try {
      await storageLib.saveState(state);
    } catch (e) {
      setStatusLine("error", `Failed to save state: ${e.message}`);
    }
  }

  // Debounced save when user types in the prompt textarea.
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
      // Confirm before replacing.
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

    // Replace state. Existing progress is intentionally discarded.
    const project = projectLib.normalizeImportedProject(parsed.project);
    const newState = {
      schemaVersion: storageLib.STORAGE_SCHEMA_VERSION,
      source: { project, importedAt: Date.now() },
      tasks: projectLib.buildInitialTaskState(project),
      currentTaskId: projectLib.firstTaskId(project),
    };
    state = newState;
    // Re-importing discards the bound folder too — it may not match.
    folderHandle = null;
    folderName = "";
    resolvedRefsCache = null;
    await persistState();
    setStatusLine("ok", `Imported "${project.project.name}" (${project.tasks.length} tasks). Bind a folder to attach images.`);
    render();
    refreshSelfTest();
  }

  // ----- navigation -------------------------------------------------------

  async function navigate(taskId) {
    if (!taskId) return;
    // Persist current prompt before leaving.
    const cur = currentMutable();
    if (cur) {
      cur.prompt = promptEl.value;
    }
    state.currentTaskId = taskId;
    await persistState();
    // Resolve the new task's refs (if a folder is bound) and re-render.
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
    popupLog(`Insert Prompt clicked (length=${text.length})`);

    if (!text.trim()) {
      popupWarn("insert aborted: empty prompt");
      setStatusLine("error", "Failed to insert prompt: prompt is empty.");
      return;
    }
    // Persist the latest edit before sending.
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
      popupWarn("insert aborted: no active tab", e.message);
      setStatusLine("error", `Failed to insert prompt: ${e.message}`);
      setBusy(false);
      return;
    }

    if (!isGeminiUrl(tab.url)) {
      popupWarn("insert aborted: not on gemini.google.com", tab.url);
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
        popupLog(`inserted ${result.length} chars${method}`);
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
        popupWarn(`insert failed: ${reason}${diag}`);
        setStatusLine("error", `Failed to insert prompt: ${reason}${diag}`);
        refreshSelfTest();
      }
    } catch (e) {
      popupWarn("insert failed (exception)", e.message);
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
      setStatusLine("error", `Attachment failed: ${attachDisabledReason(cached.state, cached) || "asset unavailable"}.`);
      return;
    }
    const file = cached.fileObj;

    popupLog(`Attach clicked for ref #${refIndex} (${cached.id} → ${file.name}, ${file.size} B, ${file.type})`);

    // Verify we still have a live File handle. (Theoretically the user
    // could have revoked permission between resolve and attach.)
    if (!folderHandle) {
      setStatusLine("error", "Attachment failed: Asset file is no longer available. Rebind the project folder.");
      return;
    }

    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      popupWarn("attach aborted: no active tab", e.message);
      setStatusLine("error", `Attachment failed: ${e.message}`);
      return;
    }
    if (!isGeminiUrl(tab.url)) {
      popupWarn("attach aborted: not on gemini.google.com", tab.url);
      setStatusLine("error", `Attachment failed: open ${GEMINI_HOST} to attach images.`);
      return;
    }

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = "Attaching…";
    setStatusLine("info", `Attaching ${file.name}…`);

    try {
      // The File is structured-cloneable (it is a Blob), so it survives
      // the chrome.tabs.sendMessage boundary without base64 conversion.
      // We do NOT persist bytes anywhere; the message envelope is
      // ephemeral and goes from popup -> content script -> adapter.
      const result = await sendMessage(tab.id, {
        type: "GEMINI_ASSISTANT_ATTACH",
        file,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
      });
      if (result && result.ok) {
        popupLog(`attached ${result.fileName ?? file.name} via ${result.method ?? "?"}`);
        setStatusLine(
          "ok",
          `Attached ${result.fileName ?? file.name} (${formatSize(result.fileSize ?? file.size)}) to Gemini. Review and send.`,
        );
      } else {
        const reason = result?.error ?? "unknown error";
        const diag = result?.diagnostics
          ? ` [inputs=${result.diagnostics.fileInputCount ?? 0}, ` +
            `accept=${result.diagnostics.fileInputAccept ?? "?"}, ` +
            `multiple=${result.diagnostics.fileInputMultiple ?? "?"}]`
          : "";
        popupWarn(`attach failed: ${reason}${diag}`);
        setStatusLine("error", `Attachment failed: ${reason}${diag}`);
      }
    } catch (e) {
      popupWarn("attach failed (exception)", e?.message ?? String(e));
      setStatusLine("error", `Attachment failed: ${e?.message ?? "unknown error"}`);
    } finally {
      // Re-enable the button only if the ref is still attachable.
      const stillResolved =
        resolvedRefsCache &&
        resolvedRefsCache[refIndex] &&
        resolvedRefsCache[refIndex].state === "resolved" &&
        resolvedRefsCache[refIndex].fileObj;
      btn.disabled = !stillResolved;
      btn.textContent = originalLabel;
      refreshSelfTest();
    }
  }

  async function refreshSelfTest() {
    try {
      const tab = await getActiveTab();
      if (!isGeminiUrl(tab.url)) return;
      const res = await sendMessage(tab.id, { type: "GEMINI_ASSISTANT_PING" });
      if (res && res.ok && res.selfTest) {
        selfTestEl.textContent = JSON.stringify(res.selfTest, null, 2);
      }
    } catch {
      // non-fatal
    }
  }

  // ----- wiring -----------------------------------------------------------

  importBtn.addEventListener("click", triggerImport);
  reimportBtn.addEventListener("click", triggerImport);

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    // reset so the same file can be selected again later
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

  promptEl.addEventListener("input", () => {
    // Update prev/next enabled state — none of these depend on prompt.
    // Just schedule a debounced save.
    schedulePromptSave();
  });

  // Cmd/Ctrl + Enter inserts; arrows navigate
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

    // Always try to populate the self-test panel for the dev/DevTools audience.
    refreshSelfTest();

    // Friendly hint if user is not on Gemini.
    try {
      const tab = await getActiveTab();
      if (!isGeminiUrl(tab.url)) {
        setStatusLine(
          "info",
          `Open ${GEMINI_HOST} to use Insert / Attach. Project manager works everywhere.`,
        );
      }
    } catch {
      // non-fatal
    }
  }

  init();
})();
