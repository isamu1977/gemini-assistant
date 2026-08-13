/*
 * popup.js
 *
 * UI side of the PoC.
 * - Reads the active tab.
 * - If it is on gemini.google.com, the popup enables the Insert button.
 * - The button sends a message to the content script, which (via the DOM
 *   adapter) places the text into Gemini's prompt field.
 * - We never auto-submit.
 */

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const promptEl = $("#prompt");
  const insertBtn = $("#insert-btn");
  const clearBtn = $("#clear-btn");
  const statusEl = $("#status");
  const statusText = $("#status-text");
  const selfTestEl = $("#selftest");

  const GEMINI_HOST = "gemini.google.com";

  function setStatus(state, text) {
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

  async function checkTab() {
    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatus("error", e.message);
      insertBtn.disabled = true;
      return;
    }

    if (!isGeminiUrl(tab.url)) {
      setStatus("idle", `Open ${GEMINI_HOST} to use this extension`);
      insertBtn.disabled = true;
      return;
    }

      // Ping the content script to confirm it's alive.
      try {
        const res = await sendMessage(tab.id, { type: "GEMINI_ASSISTANT_PING" });
      if (res && res.ok) {
        setStatus("ok", "Ready");
        selfTestEl.textContent = JSON.stringify(res.selfTest, null, 2);
      } else {
        setStatus("error", "Content script not responding");
      }
      insertBtn.disabled = !res?.ok;
    } catch (e) {
      // Most common cause: the user is on gemini.google.com but the
      // content script didn't load (e.g. extension was just installed
      // and the page was already open).
      setStatus(
        "error",
        "Reload the Gemini tab to activate the extension."
      );
      insertBtn.disabled = true;
    }
  }

  async function onInsert() {
    const text = promptEl.value;
    if (!text.trim()) {
      setStatus("error", "Prompt is empty");
      return;
    }

    setBusy(true);
    setStatus("idle", "Inserting…");

    let tab;
    try {
      tab = await getActiveTab();
    } catch (e) {
      setStatus("error", e.message);
      setBusy(false);
      return;
    }

    if (!isGeminiUrl(tab.url)) {
      setStatus("error", `Not on ${GEMINI_HOST}`);
      setBusy(false);
      return;
    }

    try {
      const result = await sendMessage(tab.id, {
        type: "GEMINI_ASSISTANT_INSERT_PROMPT",
        text,
      });
      if (result && result.ok) {
        const method = result.method ? ` (${result.method})` : "";
        setStatus(
          "ok",
          `Inserted (${result.length} chars${method}). Review and send.`,
        );
        // No auto-close: keep the popup open so the user can tweak and re-send.
        // Refresh the self-test so the panel shows the new state.
        await refreshSelfTest();
      } else {
        const diag = result?.diagnostics
          ? `\n\nDiagnostics: ${result.diagnostics.candidateCount ?? 0} candidates, ` +
            `${result.diagnostics.qlEditorCount ?? 0} .ql-editor, ` +
            `${result.diagnostics.textboxRoleCount ?? 0} [role=textbox]`
          : "";
        setStatus("error", (result?.error ?? "Insertion failed") + diag);
        await refreshSelfTest();
      }
    } catch (e) {
      setStatus("error", e.message);
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
      // Non-fatal: just don't update the panel.
    }
  }

  function onClear() {
    promptEl.value = "";
    promptEl.focus();
    setStatus("ok", "Ready");
  }

  insertBtn.addEventListener("click", onInsert);
  clearBtn.addEventListener("click", onClear);

  // Cmd/Ctrl + Enter to insert
  promptEl.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onInsert();
    }
  });

  checkTab();
})();
