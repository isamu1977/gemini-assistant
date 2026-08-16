/*
 * messaging.js
 *
 * Single source of truth for chrome.tabs.sendMessage calls between the
 * Side Panel and the Gemini content script.
 *
 * Why this exists:
 *   v0.6 introduced several new sendMessage call sites (Image Mode,
 *   Attach, Composer State, Send, Wait For Image, Fetch Image, etc.).
 *   A copy-paste bug in the orchestrator caused `chrome.tabs.sendMessage`
 *   to be called with `tabId === null`, which Chrome rejects with
 *   "No matching signature" — the entire workflow failed immediately,
 *   before any DOM logic ran.
 *
 * This module:
 *   1. Resolves the target Gemini tab robustly.
 *   2. Validates that tabId is a positive integer before each call.
 *   3. Wraps the call in a Promise (no callback / no undefined options).
 *   4. Validates that the payload is structured-cloneable.
 *   5. Exposes the canonical list of message types in one place.
 *
 * It does NOT import chrome.* itself. The caller passes in the chrome
 * object (so this module is unit-testable with a mock).
 *
 * Tests: see tests/run.js (`messaging.js` suite) and the orchestrator
 * tests already in place.
 */

(function (globalScope) {
  "use strict";

  // Gemini host we send messages to. Anything else (including
  // chrome-extension:// pages and the Side Panel document itself) is
  // rejected with a clear error.
  const GEMINI_HOST = "gemini.google.com";
  const GEMINI_PROTOCOL = "https:";

  // Canonical message types. One place to look; the content script and
  // the side panel must agree on these names. We export this list for
  // tests; nothing else reads it at runtime.
  const MESSAGE_TYPES = Object.freeze({
    PING: "GEMINI_ASSISTANT_PING",
    INSERT_PROMPT: "GEMINI_ASSISTANT_INSERT_PROMPT",
    ATTACH: "GEMINI_ASSISTANT_ATTACH",
    ATTACH_WITH_MENU: "GEMINI_ASSISTANT_ATTACH_WITH_MENU",
    ATTACH_PROBE: "GEMINI_ASSISTANT_ATTACH_PROBE",
    ATTACH_ACTIVATE: "GEMINI_ASSISTANT_ATTACH_ACTIVATE",
    ATTACH_TRACE: "GEMINI_ASSISTANT_ATTACH_TRACE",
    ATTACH_STRATEGY_A: "GEMINI_ASSISTANT_ATTACH_STRATEGY_A",
    COMPOSER_STATE: "GEMINI_ASSISTANT_COMPOSER_STATE",
    IMAGE_MODE_PROBE: "GEMINI_ASSISTANT_IMAGE_MODE_PROBE",
    ENSURE_IMAGE_MODE: "GEMINI_ASSISTANT_ENSURE_IMAGE_MODE",
    SEND_COMPOSER: "GEMINI_ASSISTANT_SEND_COMPOSER",
    FIND_SEND_BUTTON: "GEMINI_ASSISTANT_FIND_SEND_BUTTON",
    CAPTURE_BASELINE: "GEMINI_ASSISTANT_CAPTURE_BASELINE",
    WAIT_FOR_GENERATED_IMAGE: "GEMINI_ASSISTANT_WAIT_FOR_GENERATED_IMAGE",
    FETCH_IMAGE: "GEMINI_ASSISTANT_FETCH_IMAGE",
  });

  function isGeminiUrl(url) {
    if (typeof url !== "string" || url.length === 0) return false;
    try {
      const u = new URL(url);
      return u.protocol === GEMINI_PROTOCOL && u.host === GEMINI_HOST;
    } catch (_) {
      return false;
    }
  }

  function isPositiveInteger(n) {
    return typeof n === "number" && Number.isInteger(n) && n > 0;
  }

  /**
   * Best-effort deep check that the payload does not contain values
   * that structured cloning will silently strip or that Chrome will
   * reject (Functions, Symbols, DOM nodes, AbortControllers, etc.).
   *
   * Returns { ok, reason? }. We never throw; callers decide what to do.
   */
  function isMessageSerializable(payload) {
    if (payload === null || payload === undefined) return { ok: true };
    if (typeof payload === "function" || typeof payload === "symbol") {
      return { ok: false, reason: "unsupported type: " + typeof payload };
    }
    if (typeof payload !== "object") return { ok: true };
    // Host objects (e.g. DOM nodes, AbortController) carry an internal
    // [[Class]] that structured cloning refuses to copy. The cheapest
    // portable proxy: check the tag.
    const tag = Object.prototype.toString.call(payload);
    if (tag === "[object Window]" || tag === "[object HTMLDocument]") {
      return { ok: false, reason: "DOM window/document in payload" };
    }
    if (typeof Node !== "undefined" && payload instanceof Node) {
      return { ok: false, reason: "DOM node in payload" };
    }
    if (typeof AbortController !== "undefined" && payload instanceof AbortController) {
      return { ok: false, reason: "AbortController in payload" };
    }
    // File / Blob are structured-cloneable in modern browsers. We allow them.
    if (typeof payload === "object") {
      for (const k of Object.keys(payload)) {
        const v = payload[k];
        if (typeof v === "function" || typeof v === "symbol") {
          return { ok: false, reason: `unsupported field '${k}' (${typeof v})` };
        }
        if (v !== null && typeof v === "object") {
          const sub = isMessageSerializable(v);
          if (!sub.ok) return { ok: false, reason: `${k}: ${sub.reason}` };
        }
      }
    }
    return { ok: true };
  }

  /**
   * Wrap chrome.tabs.query in a Promise. Caller passes the chrome stub.
   * queryInfo is the standard {active, currentWindow, ...} shape.
   */
  function queryTabs(chromeRef, queryInfo) {
    return new Promise((resolve, reject) => {
      if (!chromeRef || !chromeRef.tabs || typeof chromeRef.tabs.query !== "function") {
        reject(new Error("chrome.tabs.query unavailable"));
        return;
      }
      try {
        chromeRef.tabs.query(queryInfo, (tabs) => {
          if (chromeRef.runtime && chromeRef.runtime.lastError) {
            reject(new Error(chromeRef.runtime.lastError.message || "tabs.query failed"));
            return;
          }
          resolve(Array.isArray(tabs) ? tabs : []);
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Resolve the Gemini tab the side panel should talk to.
   *
   * Strategy:
   *   1. active + currentWindow (the page the user is currently looking at).
   *   2. Fallback: any window, any tab whose URL is on gemini.google.com.
   *
   * Returns the tab object. Throws with a clear message if no Gemini tab
   * is found or if the resolved tab has no integer id.
   */
  async function getTargetGeminiTab(chromeRef) {
    // 1. Active + currentWindow.
    try {
      const tabs = await queryTabs(chromeRef, { active: true, currentWindow: true });
      for (const t of tabs) {
        if (isGeminiUrl(t && t.url) && isPositiveInteger(t.id)) {
          return t;
        }
      }
    } catch (_) {
      // ignore; fall through to next strategy
    }

    // 2. All windows.
    try {
      const tabs = await queryTabs(chromeRef, {});
      for (const t of tabs) {
        if (isGeminiUrl(t && t.url) && isPositiveInteger(t.id)) {
          return t;
        }
      }
    } catch (_) {
      // ignore
    }

    throw new Error(
      `No Gemini tab found. Open ${GEMINI_HOST} (https) and try again.`,
    );
  }

  /**
   * Promise-wrap chrome.tabs.sendMessage with strict argument discipline:
   *   - tabId must be a positive integer (validated up front)
   *   - message must be a structured-cloneable object with a 'type' string
   *   - callback style only; we never pass `undefined` options
   *
   * Returns the response from the content script, or throws on failure.
   * The thrown Error is always a real Error with a useful `.message`.
   */
  function sendTabMessage(chromeRef, tabId, message) {
    if (!isPositiveInteger(tabId)) {
      return Promise.reject(
        new Error(
          `sendTabMessage: invalid tabId (${String(tabId)}); expected positive integer. ` +
            "This usually means the Side Panel could not find a gemini.google.com tab.",
        ),
      );
    }
    if (!message || typeof message !== "object") {
      return Promise.reject(new Error("sendTabMessage: message must be an object"));
    }
    if (typeof message.type !== "string" || message.type.length === 0) {
      return Promise.reject(new Error("sendTabMessage: message.type must be a non-empty string"));
    }
    const ser = isMessageSerializable(message);
    if (!ser.ok) {
      return Promise.reject(
        new Error(`sendTabMessage: payload is not structured-cloneable (${ser.reason})`),
      );
    }
    if (!chromeRef || !chromeRef.tabs || typeof chromeRef.tabs.sendMessage !== "function") {
      return Promise.reject(new Error("chrome.tabs.sendMessage unavailable"));
    }

    return new Promise((resolve, reject) => {
      try {
        chromeRef.tabs.sendMessage(tabId, message, (response) => {
          // lastError is set when the receiving end does not have a listener
          // (e.g. content script not injected into the target tab).
          if (chromeRef.runtime && chromeRef.runtime.lastError) {
            reject(
              new Error(
                `${chromeRef.runtime.lastError.message || "sendMessage failed"} ` +
                  `(tabId=${tabId}, type=${message.type})`,
              ),
            );
            return;
          }
          resolve(response);
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * High-level helper used by the Side Panel: resolve the Gemini tab and
   * send a typed message. The caller passes the chrome stub for
   * testability; in production the side panel passes `chrome`.
   *
   * @param {object} chromeRef  global `chrome` (or a stub in tests).
   * @param {string} type       one of MESSAGE_TYPES.
   * @param {object} [payload]  additional fields merged into the message.
   * @returns {Promise<*>}      resolves with the content-script response,
   *                            or rejects with an Error explaining why.
   */
  async function sendToGemini(chromeRef, type, payload) {
    if (typeof type !== "string" || type.length === 0) {
      throw new Error("sendToGemini: type required");
    }
    if (payload !== undefined && (payload === null || typeof payload !== "object")) {
      throw new Error("sendToGemini: payload must be an object when provided");
    }
    const tab = await getTargetGeminiTab(chromeRef);
    const message = Object.assign({ type }, payload || {});
    return await sendTabMessage(chromeRef, tab.id, message);
  }

  /**
   * One-shot diagnostic for the Side Panel UI. Calls PING and returns a
   * small object the UI can render in the Messaging row:
   *   { ok: true, targetTabId, targetTabUrl } | { ok: false, error }
   */
  async function pingGemini(chromeRef) {
    try {
      const tab = await getTargetGeminiTab(chromeRef);
      const response = await sendTabMessage(chromeRef, tab.id, {
        type: MESSAGE_TYPES.PING,
      });
      return {
        ok: !!(response && response.ok),
        targetTabId: tab.id,
        targetTabUrl: tab.url,
        targetTabActive: !!tab.active,
        targetTabWindowId: tab.windowId,
        response: response || null,
      };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  const api = Object.freeze({
    GEMINI_HOST,
    MESSAGE_TYPES,
    isGeminiUrl,
    isPositiveInteger,
    isMessageSerializable,
    queryTabs,
    getTargetGeminiTab,
    sendTabMessage,
    sendToGemini,
    pingGemini,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalScope.GeminiAssistantMessaging = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);