/*
 * geminiDomAdapter.js
 *
 * Single source of truth for ALL DOM interactions with gemini.google.com.
 * If Gemini changes its UI, this is the only file that needs to be updated.
 *
 * Strategy (NEW: language-independent):
 *
 *   The Gemini prompt field is a Quill editor wrapped in a custom
 *   <rich-textarea> Web Component. Both the structural and semantic
 *   markers are stable across locales (the aria-label is localized and
 *   therefore unreliable).
 *
 *   We collect candidate elements from three independent observers:
 *     A. Structural: inside a <rich-textarea> + .ql-editor (Quill)
 *     B. Semantic:   div.ql-editor[contenteditable="true"][role="textbox"]
 *     C. Generic:    any [contenteditable="true"][role="textbox"]
 *
 *   Each candidate is then validated:
 *     - has non-zero box (actually rendered)
 *     - is not a Quill internal clipboard helper
 *     - is the prompt input, not a reply editor, code cell, etc.
 *       (heuristic: prefer candidates that live inside <rich-textarea>
 *        or whose closest fieldset/input-area-v2 contains the send button)
 *
 *   If multiple candidates remain, the most specific one wins.
 *
 *   We still locate the Quill instance via the container's __quill property
 *   (preferred) or window.Quill.find() (fallback). We use Quill's API
 *   (insertText) instead of innerHTML because Gemini ships a strict CSP
 *   that blocks TrustedHTML assignment.
 *
 * Exposes:
 *   globalThis.RedSunDomAdapter.insertPromptIntoGemini(text)
 *   globalThis.RedSunDomAdapter.selfTest()  -> detailed diagnostics
 */

(function () {
  "use strict";

  const LOG_PREFIX = "[Gemini Assistant:dom]";

  // Retry budget: Gemini is a heavy SPA, the input may be swapped in
  // shortly after document_idle. We poll for it up to RETRY_TIMEOUT_MS.
  const RETRY_TIMEOUT_MS = 5000;
  const RETRY_INTERVAL_MS = 100;

  // The send button is the closest reliable companion to the prompt
  // input. We use it as a validator: the prompt input is the editable
  // element that shares an ancestor (fieldset or input-area) with this
  // button. Future-proof against Send button rename via aria-label.
  const SEND_BUTTON_LABEL_CANDIDATES = [
    "Send message",
    "Enviar mensagem",
    "メッセージを送信",
    "发送消息",
    "Gửi tin nhắn",
    "보내기",
    "Envoyer le message",
    "Nachricht senden",
    "Enviar mensaje",
  ];

  // Candidate selectors. Each is independent of locale.
  // Order matters: earlier = more specific.
  const CANDIDATE_SELECTORS = Object.freeze([
    {
      name: "rich-textarea + ql-editor",
      selector: "rich-textarea .ql-editor",
    },
    {
      name: "ql-editor with semantic attrs",
      selector: 'div.ql-editor[contenteditable="true"][role="textbox"]',
    },
    {
      name: "any contenteditable textbox",
      selector: '[role="textbox"][contenteditable="true"]',
    },
  ]);

  // Things we never want to match as the prompt input.
  const NEGATIVE_CLASS_HINTS = ["ql-clipboard", "ql-hidden"];

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisibleEnough(el) {
    // A node detached from the layout has no offsetParent. We allow
    // position:fixed (offsetParent === null but visible) only as a
    // last resort.
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  function isNegativeCandidate(el) {
    const cls = (el.className && el.className.toString()) || "";
    return NEGATIVE_CLASS_HINTS.some((hint) => cls.includes(hint));
  }

  function isInsidePromptStructure(el) {
    // The Gemini prompt input lives inside a <rich-textarea> Web Component
    // (rare stable marker) or, failing that, inside an <input-area-v2>.
    return !!(
      el.closest("rich-textarea") ||
      el.closest("input-area-v2") ||
      el.closest("input-container")
    );
  }

  function findSendButton() {
    // Look for a button whose aria-label matches any send-button label.
    // Cache the result per call (cheap).
    const buttons = document.querySelectorAll("button[aria-label]");
    for (const b of buttons) {
      const label = b.getAttribute("aria-label") || "";
      if (SEND_BUTTON_LABEL_CANDIDATES.includes(label)) return b;
    }
    return null;
  }

  function isInsidePromptFieldset(el) {
    // Walk up from the candidate and look for a fieldset / input-area
    // that ALSO contains the send button. This is the strongest
    // structural signal that we found the prompt input.
    const sendBtn = findSendButton();
    if (!sendBtn) return false;
    let p = el.parentElement;
    let sendAncestor = sendBtn.parentElement;
    // Walk both up to a common container (fieldset or input-area-v2).
    while (p) {
      if (sendAncestor && sendAncestor.contains && sendAncestor.contains(p)) {
        return true;
      }
      if (p.contains(sendBtn)) return true;
      p = p.parentElement;
    }
    return false;
  }

  /**
   * Score a candidate element. Higher = better.
   * Tiers:
   *   100+ : inside <rich-textarea> AND inside the send-button fieldset
   *   50+  : inside <rich-textarea> or <input-area-v2>
   *   20+  : inside the send-button fieldset
   *   10   : has ql-editor class (Quill)
   *   1    : visible, generic contenteditable textbox
   *   0    : excluded
   */
  function scoreCandidate(el) {
    if (!isVisibleEnough(el)) return 0;
    if (isNegativeCandidate(el)) return 0;

    let score = 1;
    const richTextarea = el.closest("rich-textarea");
    const inputArea = el.closest("input-area-v2") || el.closest("input-container");
    if (richTextarea) score += 50;
    if (inputArea) score += 25;
    if (isInsidePromptFieldset(el)) score += 30;
    if (el.classList?.contains("ql-editor")) score += 10;
    if (el.getAttribute("role") === "textbox") score += 5;
    return score;
  }

  function collectCandidates() {
    const seen = new Set();
    const all = [];

    for (const layer of CANDIDATE_SELECTORS) {
      const nodes = document.querySelectorAll(layer.selector);
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        all.push({ node, source: layer.name });
      }
    }
    return all;
  }

  /**
   * Find the prompt input. Returns the best-ranked element or null.
   */
  function findPromptInput() {
    const candidates = collectCandidates();
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      const s = scoreCandidate(c.node);
      log(`candidate(${c.source}) score=${s}`, describeEl(c.node));
      if (s > bestScore) {
        best = c.node;
        bestScore = s;
      }
    }
    if (best) {
      log(`selected input with score=${bestScore}`, describeEl(best));
    }
    return best;
  }

  function describeEl(el) {
    if (!el) return null;
    return {
      tag: el.tagName?.toLowerCase(),
      classes: (el.className || "").toString().substring(0, 120),
      ariaLabel: el.getAttribute("aria-label"),
      role: el.getAttribute("role"),
      contenteditable: el.getAttribute("contenteditable"),
    };
  }

  /**
   * Find the textbox, retrying until it appears or the budget is exhausted.
   */
  async function findTextbox() {
    const start = Date.now();
    let attempt = 0;
    let lastSnapshot = null;

    while (Date.now() - start < RETRY_TIMEOUT_MS) {
      const el = findPromptInput();
      if (el) {
        if (attempt > 0) {
          log(`textbox found after ${attempt} retries`);
        }
        return el;
      }
      if (attempt === 0) {
        lastSnapshot = snapshotDom();
      }
      attempt++;
      await sleep(RETRY_INTERVAL_MS);
    }

    // Exhausted. Emit a diagnostic so the user/dev sees what's out there.
    warn(
      `textbox not found within ${RETRY_TIMEOUT_MS}ms. ` +
        `Visible candidates: ${lastSnapshot?.candidateCount ?? "?"}, ` +
        `ql-editor count: ${lastSnapshot?.qlEditorCount ?? "?"}, ` +
        `textbox role count: ${lastSnapshot?.textboxRoleCount ?? "?"}`,
    );
    return null;
  }

  function snapshotDom() {
    const qlEditors = document.querySelectorAll(".ql-editor");
    const textboxRoles = document.querySelectorAll('[role="textbox"]');
    const ariaLabels = Array.from(document.querySelectorAll("[aria-label]"))
      .slice(0, 20)
      .map((el) => `${el.tagName.toLowerCase()}:${el.getAttribute("aria-label")}`);
    return {
      candidateCount: collectCandidates().length,
      qlEditorCount: qlEditors.length,
      textboxRoleCount: textboxRoles.length,
      ariaLabelsSample: ariaLabels,
    };
  }

  /**
   * Locate the Quill instance for a given textbox element.
   */
  function locateQuill(textbox) {
    const container = textbox.closest(".ql-container");
    if (container && container.__quill) {
      return container.__quill;
    }
    if (container && typeof window.Quill?.find === "function") {
      try {
        const q = window.Quill.find(container);
        if (q) return q;
      } catch (e) {
        warn("Quill.find(container) threw:", e.message);
      }
    }
    const containers = document.querySelectorAll(".ql-container");
    for (const c of containers) {
      if (c.__quill) return c.__quill;
    }
    return null;
  }

  /**
   * Public API: insert text into the Gemini prompt field.
   * Replaces existing content (PoC behavior).
   */
  async function insertPromptIntoGemini(text) {
    if (typeof text !== "string") {
      return { ok: false, error: "text must be a string" };
    }

    log(`insertPromptIntoGemini called (length=${text.length})`);

    const textbox = await findTextbox();
    if (!textbox) {
      const diag = snapshotDom();
      return {
        ok: false,
        error:
          "Gemini prompt input not found. Are you signed in and on the chat screen?",
        diagnostics: diag,
      };
    }

    const quill = locateQuill(textbox);
    const lengthBefore = textboxTextLength(textbox);

    if (!quill) {
      // Fallback: select ALL existing content, then execCommand('insertText').
      // - Selecting all (NOT collapsing) is what makes this a REPLACE, not an
      //   append. execCommand('insertText') replaces the current selection.
      // - We do not write innerHTML (CSP/TrustedHTML would block it).
      warn("Quill instance not found; using execCommand fallback (replace)");
      try {
        textbox.focus();
        const range = document.createRange();
        range.selectNodeContents(textbox);
        // Deliberately do NOT collapse the range. Collapsing would move
        // the caret to one end and make insertText append.
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = document.execCommand("insertText", false, text);
        if (!ok) {
          return { ok: false, error: "execCommand('insertText') returned false" };
        }
        textbox.focus();
        const lengthAfter = textboxTextLength(textbox);
        log(
          `inserted via execCommand fallback (length=${text.length}, ` +
            `before=${lengthBefore}, after=${lengthAfter})`,
        );
        const verified = verifyReplacement(text, lengthAfter);
        if (!verified.ok) {
          return {
            ok: false,
            error: verified.error,
            method: "execCommand",
            lengthBefore,
            lengthAfter,
          };
        }
        return {
          ok: true,
          length: text.length,
          method: "execCommand",
          lengthBefore,
          lengthAfter,
        };
      } catch (e) {
        return { ok: false, error: `fallback failed: ${e.message}` };
      }
    }

    try {
      quill.focus();
      quill.setText("");
      quill.insertText(0, text);
      quill.focus();
      const lengthAfter = quill.getText().replace(/\n$/, "").length;
      log(
        `inserted via Quill API (length=${text.length}, ` +
          `before=${lengthBefore}, after=${lengthAfter})`,
      );
      // Note: getText() appends a trailing '\n' to every block; Quill's
      // internal length matches our input char-for-char for non-newline
      // content. We compare the un-trailing-newline length.
      const verified = verifyReplacement(text, lengthAfter);
      if (!verified.ok) {
        return {
          ok: false,
          error: verified.error,
          method: "quill",
          lengthBefore,
          lengthAfter,
        };
      }
      return {
        ok: true,
        length: text.length,
        method: "quill",
        lengthBefore,
        lengthAfter,
      };
    } catch (e) {
      warn("Quill API insertion failed:", e.message);
      return { ok: false, error: `Quill insertion failed: ${e.message}` };
    }
  }

  /**
   * Returns the user-visible text length of a textbox element, ignoring
   * Quill's trailing newline and any <br> placeholders.
   */
  function textboxTextLength(textbox) {
    const txt = (textbox.innerText || "").replace(/\u00a0/g, " ");
    return txt.length;
  }

  /**
   * Compare what we asked to insert vs what's currently in the textbox.
   * We do not log content. We return an error if the lengths diverge
   * in a way that signals appending (lengthAfter >> lengthRequested).
   */
  function verifyReplacement(requested, lengthAfter) {
    const requestedLen = requested.length;
    if (lengthAfter === requestedLen) return { ok: true };
    // Allow tiny slack (e.g. trailing newlines Quill adds).
    if (lengthAfter > requestedLen && lengthAfter - requestedLen <= 2) {
      return { ok: true };
    }
    if (lengthAfter > requestedLen) {
      return {
        ok: false,
        error: `replacement mismatch: editor has ${lengthAfter} chars, expected ${requestedLen} (likely appended instead of replaced)`,
      };
    }
    return {
      ok: false,
      error: `replacement mismatch: editor has ${lengthAfter} chars, expected ${requestedLen}`,
    };
  }

  /**
   * Self-test hook. Returns a diagnostic snapshot that explains what
   * the adapter sees right now. Useful from the popup and from DevTools.
   */
  function selfTest() {
    const candidates = collectCandidates();
    const scored = candidates
      .map((c) => ({
        source: c.source,
        score: scoreCandidate(c.node),
        describe: describeEl(c.node),
      }))
      .sort((a, b) => b.score - a.score);

    const selected = findPromptInput();
    const selectedQuill = selected ? locateQuill(selected) : null;
    const contentLength = selected ? textboxTextLength(selected) : null;

    return {
      url: location.href,
      htmlLang: document.documentElement.getAttribute("lang") || null,
      qlEditorCount: document.querySelectorAll(".ql-editor").length,
      richTextareaCount: document.querySelectorAll("rich-textarea").length,
      textboxRoleCount: document.querySelectorAll('[role="textbox"]').length,
      quillGlobalAvailable: typeof window.Quill !== "undefined",
      inputAreaCount:
        document.querySelectorAll("input-area-v2").length +
        document.querySelectorAll("input-container").length,
      sendButtonFound: !!findSendButton(),
      selected: selected ? describeEl(selected) : null,
      selectedQuillAttached: !!selectedQuill,
      contentLength,
      candidates: scored,
    };
  }

  globalThis.RedSunDomAdapter = Object.freeze({
    insertPromptIntoGemini,
    selfTest,
    describeEl,
    CANDIDATE_SELECTORS,
    SCORE_BREAKDOWN: Object.freeze({
      insideRichTextarea: 50,
      insideInputArea: 25,
      insideSendButtonFieldset: 30,
      hasQlEditorClass: 10,
      roleTextbox: 5,
      visible: 1,
    }),
  });

  log("adapter loaded");
})();
