/*
 * storage.js
 *
 * Thin wrapper around chrome.storage.local with an in-memory shim so the
 * same module can be required from Node tests.
 *
 * Schema for stored state (versioned in storage):
 *   {
 *     "schemaVersion": 1,
 *     "source": { "project": <project>, "importedAt": <ms> } | null,
 *     "tasks":  { [taskId]: { "status": string, "prompt": string } } | null,
 *     "currentTaskId": string | null
 *   }
 *
 * All async APIs return Promises for unified handling in popup and tests.
 */

(function (globalScope) {
  "use strict";

  const STORAGE_SCHEMA_VERSION = 1;
  const STATE_KEY = "state_v1";

  // ----- in-memory shim ----------------------------------------------------

  const memoryStore = new Map();

  function isChromeStorageAvailable() {
    return (
      typeof chrome !== "undefined" &&
      chrome &&
      chrome.storage &&
      chrome.storage.local &&
      typeof chrome.storage.local.get === "function"
    );
  }

  function getFromChrome(key) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get([key], (items) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(items[key] ?? null);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function setInChrome(key, value) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function clearInChrome() {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.clear(() => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function getFromMemory(key) {
    return memoryStore.has(key) ? memoryStore.get(key) : null;
  }

  function setInMemory(key, value) {
    memoryStore.set(key, value);
  }

  function clearMemory() {
    memoryStore.clear();
  }

  function emptyState() {
    return {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      source: null,
      tasks: null,
      currentTaskId: null,
      // v0.6.2: gate flag. When false, Prepare Task / Generate Task
      // remain disabled until the user has manually confirmed the
      // attachment trace succeeds end-to-end. Once flipped to true,
      // it persists across side-panel reloads.
      attachUnlocked: false,
    };
  }

  /**
   * Validate that a stored object conforms to the expected shape.
   * If the stored schemaVersion is missing or different, treat as empty
   * (forward-compatible: old data won't crash the popup).
   */
  function coerceState(raw) {
    if (!raw || typeof raw !== "object") return emptyState();
    if (raw.schemaVersion !== STORAGE_SCHEMA_VERSION) return emptyState();
    return {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      source: raw.source ?? null,
      tasks: raw.tasks && typeof raw.tasks === "object" ? raw.tasks : null,
      currentTaskId:
        typeof raw.currentTaskId === "string" ? raw.currentTaskId : null,
      // Backwards-compatible: legacy v0.6.1 stored objects have no
      // attachUnlocked field. Default to false (gated) so the user is
      // forced to validate the new attach flow manually.
      attachUnlocked: raw.attachUnlocked === true,
    };
  }

  async function loadState() {
    if (isChromeStorageAvailable()) {
      const raw = await getFromChrome(STATE_KEY);
      return coerceState(raw);
    }
    return coerceState(getFromMemory(STATE_KEY));
  }

  async function saveState(state) {
    // Defensive: always store under the current schema version.
    const safe = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      source: state?.source ?? null,
      tasks: state?.tasks ?? null,
      currentTaskId: state?.currentTaskId ?? null,
      // attachUnlocked is optional. We store it only if true so
      // legacy state written before v0.6.2 is not rewritten on every
      // save (keeps the storage diff small).
      ...(state && state.attachUnlocked === true
        ? { attachUnlocked: true }
        : {}),
    };
    if (isChromeStorageAvailable()) {
      await setInChrome(STATE_KEY, safe);
    } else {
      setInMemory(STATE_KEY, safe);
    }
  }

  async function clearAll() {
    if (isChromeStorageAvailable()) {
      await clearInChrome();
    } else {
      clearMemory();
    }
  }

  // Test helper: allow tests to fully reset between runs.
  function _resetForTests() {
    memoryStore.clear();
  }

  const api = Object.freeze({
    STORAGE_SCHEMA_VERSION,
    loadState,
    saveState,
    clearAll,
    emptyState,
    coerceState,
    _resetForTests,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalScope.GeminiAssistantStorage = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
