/*
 * popup.js
 *
 * UI orchestration for the Project & Task Manager.
 *
 * Responsibilities:
 *   - Load/save state from chrome.storage.local.
 *   - Import Project JSON, validate, confirm replacement.
 *   - Render the loaded project: task selector, title, status, prompt.
 *   - Handle Previous/Next navigation and per-task prompt edits.
 *   - Hand off "Insert Prompt" to the content script (which calls the
 *     DOM adapter). Never auto-submits.
 *
 * The popup knows nothing about Gemini's DOM. The DOM adapter lives in
 * src/dom/geminiDomAdapter.js and is invoked only via the content script
 * message bridge.
 */

(function () {
  "use strict";

  const projectLib = globalThis.GeminiAssistantProject;
  const storageLib = globalThis.GeminiAssistantStorage;

  if (!projectLib || !storageLib) {
    document.body.textContent =
      "Internal error: GeminiAssistantProject / Storage libs not loaded.";
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
    await persistState();
    setStatusLine("ok", `Imported "${project.project.name}" (${project.tasks.length} tasks).`);
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
          `Open ${GEMINI_HOST} to use Insert Prompt. Project manager works everywhere.`,
        );
      }
    } catch {
      // non-fatal
    }
  }

  init();
})();
