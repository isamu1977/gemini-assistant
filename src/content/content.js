/*
 * content.js
 *
 * Bridges the extension popup to the Gemini DOM via geminiDomAdapter.
 * The adapter is loaded BEFORE this script (see manifest.json order),
 * so globalThis.RedSunDomAdapter is already available.
 *
 * Message protocol (popup -> content):
 *   { type: "GEMINI_ASSISTANT_PING" }
 *     -> { ok: true, url, selfTest }
 *   { type: "GEMINI_ASSISTANT_INSERT_PROMPT", text: string }
 *     -> { ok: true, length } | { ok: false, error }
 */

(function () {
  "use strict";

  const LOG_PREFIX = "[Gemini Assistant:content]";

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function handleMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg !== "object") {
      sendResponse({ ok: false, error: "invalid message" });
      return false;
    }

    switch (msg.type) {
      case "GEMINI_ASSISTANT_PING": {
        const adapter = globalThis.RedSunDomAdapter;
        sendResponse({
          ok: true,
          url: location.href,
          ready: !!adapter,
          selfTest: adapter ? adapter.selfTest() : null,
        });
        return false;
      }

      case "GEMINI_ASSISTANT_INSERT_PROMPT": {
        const adapter = globalThis.RedSunDomAdapter;
        if (!adapter) {
          sendResponse({ ok: false, error: "adapter not loaded" });
          return false;
        }
        // insertPromptIntoGemini is async; keep the message channel open.
        adapter
          .insertPromptIntoGemini(msg.text ?? "")
          .then((result) => sendResponse(result))
          .catch((e) =>
            sendResponse({ ok: false, error: e?.message ?? String(e) })
          );
        return true;
      }

      default:
        sendResponse({ ok: false, error: `unknown type: ${msg.type}` });
        return false;
    }
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  log("content script loaded");
})();
