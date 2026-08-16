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

  // Labels for the menu trigger "+" (Upload & tools). Localized variants
  // we have observed. We use this as a soft fallback; the structural
  // detection (icon `plus` + position in input area) is the primary.
  const PLUS_BUTTON_LABEL_CANDIDATES = [
    "Upload & tools",
    "Upload and tools",
    "Upload",
    "Add files and tools",
    "Carregar e ferramentas",
    "Cargar y herramientas",
    "Téléverser et outils",
    "Hochladen und Tools",
    "アップロードとツール",
    "업로드 및 도구",
    "上传和工具",
  ];

  // Locale-aware labels for "Create image" inside the + menu.
  // We use text matching only as a FALLBACK. The primary detector is the
  // structural role `menuitemcheckbox` (Create image is a toggle, not an
  // action) combined with the icon name `image_create`.
  const CREATE_IMAGE_TEXT_CANDIDATES = [
    "Create image",
    "Criar imagem",
    "Créer une image",
    "Crear imagen",
    "Immagine erstellen",
    "画像を作成",
    "이미지 만들기",
    "创建图片",
    "Tạo hình ảnh",
  ];

  // Locale-aware labels for the "Upload files" entry inside the + menu.
  // Used as a fallback when the structural detector (`attach_file` icon)
  // does not match. The aria-label is more stable; the visible text is
  // the fallback below.
  const UPLOAD_FILES_TEXT_CANDIDATES = [
    "Upload files",
    "Upload file",
    "Enviar arquivos",
    "Enviar archivo",
    "Enviar arquivo",
    "Téléverser des fichiers",
    "Datei hochladen",
    "ファイルをアップロード",
    "파일 업로드",
    "上传文件",
    "Tải tệp lên",
  ];

  // Labels for the "Deselect Images" toggle button that appears in the
  // composer toolbar ONLY when Image Generation mode is active.
  // This is the most reliable structural indicator of image-mode ON.
  const DESELECT_IMAGE_LABEL_CANDIDATES = [
    "Deselect Images",
    "Deselect Image",
    "Cancel image generation",
    "Image generation on",
    "Imagens selecionadas",
    "Imágenes seleccionadas",
    "Images sélectionnées",
    "画像を選択中",
    "이미지 선택됨",
    "已选择图片",
  ];

  // Labels for the menuitemcheckbox "Create image" toggle inside the menu.
  const CREATE_IMAGE_MENUITEM_LABEL_CANDIDATES = CREATE_IMAGE_TEXT_CANDIDATES;

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

  // ---- Image Generation Mode (v0.6) -----------------------------------------

  // Image mode is a structural state in the Gemini composer. When active:
  //   1. A toggle button "Deselect Images" appears next to the + button.
  //      We accept multiple locale variants.
  //   2. The textbox placeholder switches to "Describe your image".
  //   3. The menuitemcheckbox "Create image" in the + menu shows a
  //      checked state.
  //
  // We use ALL THREE signals to confirm. We never click anything if
  // already active.

  const IMAGE_MODE_CONFIRM_TIMEOUT_MS = 4000;
  const IMAGE_MODE_ACTIVATE_POLL_MS = 120;

  /**
   * Find the "Deselect Images" toggle that appears when image mode is on.
   * Returns the button element or null.
   */
  function findDeselectImagesToggle() {
    const allBtns = Array.from(document.querySelectorAll("button, gem-button"));
    for (const el of allBtns) {
      const label = (el.getAttribute && el.getAttribute("aria-label")) || "";
      if (!label) continue;
      if (DESELECT_IMAGE_LABEL_CANDIDATES.some((l) => label === l || label.includes(l))) {
        return el;
      }
    }
    return null;
  }

  /**
   * Find the + (Upload & tools) button. Falls back from aria-label to
   * structural detection (icon name `plus` inside the input-area-v2).
   */
  function findPlusButton() {
    const buttons = Array.from(
      document.querySelectorAll("button[aria-label], gem-button[aria-label]"),
    );
    for (const b of buttons) {
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      if (PLUS_BUTTON_LABEL_CANDIDATES.some((l) => label.includes(l.toLowerCase()))) {
        return b;
      }
    }
    const area = document.querySelector("input-area-v2");
    if (area) {
      const candidates = Array.from(area.querySelectorAll("button, gem-button"));
      for (const b of candidates) {
        const img = b.querySelector("img");
        if (!img) continue;
        const alt = (img.getAttribute("alt") || img.textContent || "").toLowerCase();
        if (alt === "plus" || alt.includes("plus")) return b;
      }
    }
    return null;
  }

  /**
   * Find the menuitemcheckbox matching "Create image" inside the + menu.
   * Accepts text match OR icon-name match. Returns the best candidate or
   * null. We never throw.
   */
  function findCreateImageMenuitem() {
    const items = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]'));
    const area = document.querySelector("input-area-v2");
    const candidates = items.filter((i) => {
      const r = i.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      if (area) {
        const ar = area.getBoundingClientRect();
        const dx = Math.abs(r.left + r.width / 2 - (ar.left + ar.width / 2));
        const dy = Math.abs(r.top + r.height / 2 - (ar.top + ar.height / 2));
        if (dx > 600 || dy > 600) return false;
      }
      return true;
    });

    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const text = (el.textContent || "").trim().toLowerCase();
      const img = el.querySelector("img");
      const alt = img ? (img.getAttribute("alt") || "").toLowerCase() : "";
      let score = 0;
      if (CREATE_IMAGE_TEXT_CANDIDATES.some((c) => c.toLowerCase() === text)) score += 50;
      if (CREATE_IMAGE_TEXT_CANDIDATES.some((c) => text.includes(c.toLowerCase()))) score += 30;
      if (alt === "image_create" || alt.includes("image_create")) score += 40;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Non-destructive probe: returns structured info about Image Generation
   * mode without clicking anything. Used by the sidepanel for status.
   */
  function imageModeProbe() {
    const deselect = findDeselectImagesToggle();
    const tb = document.querySelector('[role="textbox"]') || findPromptInput();
    const placeholder =
      (tb && tb.getAttribute("aria-placeholder")) ||
      (tb && tb.getAttribute("placeholder")) ||
      (tb && tb.getAttribute("data-placeholder")) ||
      null;
    const composerTextSample = tb ? (tb.textContent || "").trim().slice(0, 80) : null;
    const area = document.querySelector("input-area-v2");
    const createHeader = area
      ? Array.from(area.querySelectorAll("h1, h2, h3")).find((h) =>
          /create images?|create with/i.test(h.textContent || ""),
        )
      : null;

    return {
      probeAt: new Date().toISOString(),
      deselectImagesToggleFound: !!deselect,
      textboxPlaceholder: placeholder,
      composerTextSample,
      createImagesHeaderFound: !!createHeader,
      imageModeActive:
        !!deselect ||
        (placeholder &&
          /describe (your|uma|une|una|ein) image|describe uma imagem|descreva sua imagem/i.test(
            placeholder,
          )) ||
        !!createHeader ||
        // Fallback: PT-BR composer placeholder "Descreva sua imagem…"
        (placeholder &&
          /descreva (sua|sue?s?) imagem/i.test(placeholder)) ||
        // Generic structural fallback: any placeholder containing "image"
        // when the composer is empty AND the createImagesHeader is found.
        false,
    };
  }

  /**
   * Idempotent: ensure Gemini is in Image Generation mode.
   *   - If already active, return immediately without clicking.
   *   - Otherwise: open the + menu, find Create image, click it, then
   *     poll for the Deselect Images toggle to appear.
   */
  async function ensureImageGenerationMode() {
    const before = imageModeProbe();
    if (before.imageModeActive) {
      return { ok: true, mode: "already-active", probe: before };
    }

    const plus = findPlusButton();
    if (!plus) {
      return {
        ok: false,
        mode: "no-plus-button",
        error: "Could not find the + (Upload & tools) button.",
        probe: before,
      };
    }

    if (isAttachmentMenuOpen()) {
      try {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            bubbles: true,
          }),
        );
      } catch (_) {
        /* ignore */
      }
      await sleep(120);
    }

    try {
      plus.click();
    } catch (e) {
      return {
        ok: false,
        mode: "click-plus-failed",
        error: `Click on + button failed: ${e?.message ?? "unknown"}`,
        probe: imageModeProbe(),
      };
    }

    const start = Date.now();
    let createItem = null;
    while (Date.now() - start < IMAGE_MODE_CONFIRM_TIMEOUT_MS) {
      createItem = findCreateImageMenuitem();
      if (createItem) break;
      await sleep(IMAGE_MODE_ACTIVATE_POLL_MS);
    }

    if (!createItem) {
      try {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            bubbles: true,
          }),
        );
      } catch (_) {
        /* ignore */
      }
      return {
        ok: false,
        mode: "no-create-image-item",
        error:
          "Could not find 'Create image' in the + menu. The Gemini UI may have changed.",
        probe: imageModeProbe(),
      };
    }

    try {
      createItem.click();
    } catch (e) {
      return {
        ok: false,
        mode: "click-create-failed",
        error: `Click on Create image failed: ${e?.message ?? "unknown"}`,
        probe: imageModeProbe(),
      };
    }

    const start2 = Date.now();
    let probeAfter = imageModeProbe();
    while (Date.now() - start2 < IMAGE_MODE_CONFIRM_TIMEOUT_MS) {
      probeAfter = imageModeProbe();
      if (probeAfter.imageModeActive) break;
      await sleep(IMAGE_MODE_ACTIVATE_POLL_MS);
    }

    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          bubbles: true,
        }),
      );
    } catch (_) {
      /* ignore */
    }

    return {
      ok: probeAfter.imageModeActive,
      mode: probeAfter.imageModeActive ? "activated" : "activate-timeout",
      error: probeAfter.imageModeActive
        ? null
        : "Clicked Create image but image mode did not become active within the timeout.",
      probeBefore: before,
      probeAfter,
    };
  }

  // ---- Attachment (file upload) support --------------------------------

  // Gemini's upload affordance is a hidden <input type="file"> rendered
  // when the user clicks the "+" button near the composer. We don't try
  // to drive the "+" button itself — we go straight for the input. If
  // the input is not currently in the DOM, we return a structured error
  // so the caller can show a meaningful message.
  //
  // The success signal we look for is language-independent and
  // structural: an attachment thumbnail appears in the same input area
  // as the prompt textbox. We watch that subtree with a one-shot
  // MutationObserver for up to ATTACH_TIMEOUT_MS.

  const ATTACH_TIMEOUT_MS = 4000;
  const ATTACH_OBSERVER_QUIESCE_MS = 120;

  // v0.6: extended timeouts for full file uploads (a few MB).
  const ATTACH_FILE_TIMEOUT_MS = 12000;
  const ATTACH_MENU_OPEN_TIMEOUT_MS = 2500;

  // CSS / attribute hints that indicate an attachment thumbnail in the
  // upload chip area. Locale-independent.
  const ATTACHMENT_HINT_SELECTORS = [
    'img[src^="data:"]',
    'img[src^="blob:"]',
    '[class*="thumbnail" i]',
    '[class*="uploaded" i]',
    '[class*="attachment" i]',
  ];

  function findFileInputs() {
    return Array.from(document.querySelectorAll('input[type="file"]'));
  }

  function findPromptInputArea() {
    // The upload area lives near the prompt composer. Walk up from the
    // first file input (or, failing that, the send button) and pick the
    // nearest container that also contains the composer textbox.
    const tb = findPromptInput();
    if (!tb) return null;
    let p = tb.parentElement;
    while (p && p !== document.body) {
      // Prefer containers that look like the input area.
      if (
        p.tagName?.toLowerCase() === "input-area-v2" ||
        p.tagName?.toLowerCase() === "input-container" ||
        p.querySelector?.("input-area-v2, input-container")
      ) {
        return p;
      }
      p = p.parentElement;
    }
    // Fallback: walk up to the closest fieldset that contains an input.
    p = tb.parentElement;
    while (p && p !== document.body) {
      if (p.tagName?.toLowerCase() === "fieldset" || p.tagName?.toLowerCase() === "form") {
        return p;
      }
      p = p.parentElement;
    }
    return tb.parentElement || document.body;
  }

  function countAttachmentHints(root) {
    if (!root) return 0;
    let total = 0;
    for (const sel of ATTACHMENT_HINT_SELECTORS) {
      total += root.querySelectorAll(sel).length;
    }
    return total;
  }

  function attachmentDiagnostics() {
    const inputs = findFileInputs();
    const area = findPromptInputArea();
    return {
      attachmentButtonFound: !!findAttachmentTrigger(),
      fileInputCount: inputs.length,
      fileInputAccept: inputs[0]?.accept ?? null,
      fileInputMultiple: inputs[0]?.multiple ?? false,
      attachmentContainerFound: !!area,
      currentAttachmentHints: countAttachmentHints(area),
    };
  }

  /**
   * Structured, verbose snapshot of the attachment surface. Used by the
   * side panel's Debug section. Designed to be readable by humans AND
   * stable across Gemini UI changes: it never asserts which element is
   * "the right one", it just reports what is present.
   *
   * State fields:
   *   triggerFound       boolean — did we find a likely "+" / upload button?
   *   fileInputCount     number  — how many <input type="file"> exist now?
   *   fileInputAccept    string|null — accept attr of the first input
   *   fileInputMultiple  boolean
   *   menuOrPopoverOpen  boolean — any popover/menu/dialog currently visible?
   *   attachmentAreaFound boolean — could we identify the upload area?
   *   currentHints       number  — count of attachment thumbnail hints
   *   inputLikelyDynamic boolean — deduction; see below
   *   notes              string[] — short human-readable notes
   */
  function attachmentProbe() {
    const inputs = findFileInputs();
    const area = findPromptInputArea();
    const trigger = findAttachmentTrigger();
    const menuOpen = isAttachmentMenuOpen();

    const notes = [];
    if (inputs.length === 0) {
      notes.push(
        "No <input type=\"file\"> currently mounted. Gemini typically mounts the input only after the user opens the attachment menu.",
      );
    }
    if (!trigger) {
      notes.push(
        "No obvious \"+\" / upload button found in the composer toolbar (we tried aria-label and structural heuristics).",
      );
    }
    if (!area) {
      notes.push(
        "Could not localize the upload area near the prompt textbox.",
      );
    }

    return {
      probeAt: new Date().toISOString(),
      url: location.href,
      triggerFound: !!trigger,
      triggerDescriptor: describeTrigger(trigger),
      fileInputCount: inputs.length,
      fileInputAccept: inputs[0]?.accept ?? null,
      fileInputMultiple: inputs[0]?.multiple ?? false,
      menuOrPopoverOpen: menuOpen,
      attachmentAreaFound: !!area,
      currentHints: countAttachmentHints(area),
      inputLikelyDynamic: inputs.length === 0 && !!trigger && !!area,
      notes,
    };
  }

  /**
   * Heuristic: find a button that likely opens the attachment menu.
   * Locale-independent: we look for structural attributes first
   * (aria-haspopup, mat-icon naming hints) and then fall back to a
   * small set of common aria-label fragments in multiple languages.
   *
   * Does NOT click anything. Returns the element or null.
   */
  function findAttachmentTrigger() {
    // 1. Structural: any button with aria-haspopup inside the prompt area.
    const area = findPromptInputArea();
    if (area) {
      const structural = area.querySelector(
        'button[aria-haspopup], button[aria-controls], [role="button"][aria-haspopup]',
      );
      if (structural) return structural;
    }

    // 2. Aria-label hints (locale-independent fragments).
    const HINTS = [
      "upload",
      "attach",
      "file",
      "add file",
      "add image",
      "insert file",
      "plus",
      "more",
      "tools",
      "media",
      "imagen",
      "video",
      "carregar",
      "adjuntar",
      "archivo",
      "fichier",
      "anhang",
      "Datei",
      "添付",
      "ファイル",
      "업로드",
      "파일",
    ];
    const buttons = document.querySelectorAll("button[aria-label], [role='button'][aria-label]");
    for (const b of buttons) {
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      if (HINTS.some((h) => label.includes(h))) return b;
    }

    // 3. Icon-name hint (mat-icon, material symbol, etc.): a button whose
    //    icon child has a name commonly used for "add"/"attach".
    const ICON_HINTS = ["add", "attach", "upload", "plus", "image"];
    const iconButtons = document.querySelectorAll("button");
    for (const b of iconButtons) {
      const icon = b.querySelector(
        'mat-icon, [class*="material-symbols"], [class*="mat-icon"], i[class*="icon"]',
      );
      if (!icon) continue;
      const name = (
        icon.getAttribute("fontset") ||
        icon.getAttribute("data-mat-icon-name") ||
        icon.textContent ||
        ""
      ).toLowerCase();
      if (ICON_HINTS.some((h) => name.includes(h))) return b;
    }

    return null;
  }

  function describeTrigger(el) {
    if (!el) return null;
    return {
      tag: el.tagName?.toLowerCase() ?? null,
      ariaLabel: el.getAttribute("aria-label") ?? null,
      ariaHasPopup: el.getAttribute("aria-haspopup") ?? null,
      classHint: (el.className || "").toString().slice(0, 80),
    };
  }

  /**
   * Heuristic: is a popover / menu / dialog currently visible?
   * We look for elements commonly used by Gemini for menus: mat-menu,
   * role="menu", role="dialog", or popover-class attributes.
   */
  function isAttachmentMenuOpen() {
    const menu = document.querySelector(
      '[role="menu"]:not([hidden]), [role="dialog"]:not([hidden]), mat-menu-panel, .cdk-overlay-pane mat-menu-panel, [popover], dialog[open]',
    );
    if (!menu) return false;
    const rect = menu.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Best-effort: open the attachment menu by clicking the trigger,
   * then wait a short budget for a file input to appear. Always
   * returns a structured result; never throws.
   *
   * The caller (the side panel "Probe attachment" button) uses this
   * ONLY for the structured diagnostic. It does NOT auto-attach.
   *
   * Phases:
   *   A. Snapshot pre-click state.
   *   B. Click the trigger (if found).
   *   C. Poll for a new file input or a visible menu for up to
   *      ACTIVATE_TIMEOUT_MS.
   *   D. Capture the post-click state.
   *   E. Restore the original state as best we can (close the menu by
   *      pressing Escape, re-click the trigger again if needed).
   */
  const ACTIVATE_TIMEOUT_MS = 2500;
  const ACTIVATE_POLL_MS = 80;

  async function activateAttachmentFlow() {
    const probeBefore = attachmentProbe();
    const trigger = findAttachmentTrigger();

    if (!trigger) {
      return {
        ok: false,
        reason: "no-trigger",
        message: "Could not find an attachment-related button to click.",
        probeBefore,
        probeAfter: probeBefore,
      };
    }

    // Click the trigger. Use a real click so any listeners fire.
    try {
      trigger.click();
    } catch (e) {
      return {
        ok: false,
        reason: "click-failed",
        message: `Click on the trigger failed: ${e?.message ?? "unknown"}`,
        probeBefore,
        probeAfter: attachmentProbe(),
      };
    }

    // Wait for the menu / input to appear.
    const start = Date.now();
    let probeAfter = probeBefore;
    while (Date.now() - start < ACTIVATE_TIMEOUT_MS) {
      await sleep(ACTIVATE_POLL_MS);
      probeAfter = attachmentProbe();
      if (probeAfter.menuOrPopoverOpen || probeAfter.fileInputCount > 0) {
        break;
      }
    }

    // Restore: send Escape to close the menu so the user is not left
    // holding an open dialog. Best-effort; failures are non-fatal.
    try {
      const esc = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true,
      });
      document.dispatchEvent(esc);
    } catch (_) {
      // ignore
    }

    return {
      ok: probeAfter.menuOrPopoverOpen || probeAfter.fileInputCount > 0,
      reason:
        probeAfter.menuOrPopoverOpen || probeAfter.fileInputCount > 0
          ? "activated"
          : "no-change",
      message:
        probeAfter.menuOrPopoverOpen || probeAfter.fileInputCount > 0
          ? "Attachment menu opened (or file input appeared). Use this to drive the actual Attach in the next milestone."
          : "Click on the trigger did not produce a visible menu or a file input within the timeout. The Gemini UI may have changed; check the trigger descriptor.",
      probeBefore,
      probeAfter,
    };
  }

  /**
   * Find the "Upload files" item inside the + menu. Localized via text
   * OR aria-label (the menuitem's aria-label is the most stable; the
   * visible text is the fallback).
   */
  function findUploadFilesMenuitem() {
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    // Prefer the one closest to the composer.
    const area = document.querySelector("input-area-v2");
    const candidates = items.filter((i) => {
      const r = i.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      if (area) {
        const ar = area.getBoundingClientRect();
        const dx = Math.abs(r.left + r.width / 2 - (ar.left + ar.width / 2));
        const dy = Math.abs(r.top + r.height / 2 - (ar.top + ar.height / 2));
        if (dx > 600 || dy > 600) return false;
      }
      return true;
    });
    // Score: aria-label is most stable.
    let best = null;
    let bestScore = 0;
    for (const el of candidates) {
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      const text = (el.textContent || "").trim().toLowerCase();
      const img = el.querySelector("img");
      const alt = img ? (img.getAttribute("alt") || "").toLowerCase() : "";
      let score = 0;
      if (/^upload files?\.?$/i.test(label)) score += 60;
      if (/^upload files?\.?$/i.test(text)) score += 50;
      // Locale-aware text fallback for "Upload files" (PT: "Enviar arquivos").
      if (UPLOAD_FILES_TEXT_CANDIDATES.some((c) => text === c.toLowerCase())) score += 45;
      if (UPLOAD_FILES_TEXT_CANDIDATES.some((c) => text.includes(c.toLowerCase()) && c.length >= 6)) score += 25;
      if (/upload/i.test(label) && /file|document/i.test(label)) score += 30;
      if (alt === "attach_file" || alt.includes("attach_file")) score += 40;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Open the + menu by clicking the + button. Idempotent: if the menu is
   * already open, returns ok with reason="already-open". Never throws.
   */
  async function openAttachmentMenu() {
    const before = isAttachmentMenuOpen();
    if (before) {
      return { ok: true, reason: "already-open" };
    }
    const plus = findPlusButton();
    if (!plus) {
      return { ok: false, reason: "no-plus-button", error: "Could not find + button." };
    }
    try {
      plus.click();
    } catch (e) {
      return {
        ok: false,
        reason: "click-plus-failed",
        error: `Click on + button failed: ${e?.message ?? "unknown"}`,
      };
    }
    const start = Date.now();
    while (Date.now() - start < ATTACH_MENU_OPEN_TIMEOUT_MS) {
      if (isAttachmentMenuOpen()) {
        return { ok: true, reason: "opened" };
      }
      // Fallback signal: file input appeared.
      if (findFileInputs().length > 0) {
        return { ok: true, reason: "input-mounted" };
      }
      await sleep(80);
    }
    return {
      ok: false,
      reason: "menu-not-opened",
      error: "Clicked + but no menu or file input appeared within the timeout.",
    };
  }

  /**
   * Public API (v0.6): attach a File to the Gemini composer by:
   *   1. Opening the + menu (if not already open).
   *   2. Clicking "Upload files" to ensure a <input type="file"> is
   *      mounted by Gemini's component.
   *   3. Injecting the File via DataTransfer + change/input events.
   *   4. Waiting for the chip to appear in the composer with the
   *      expected filename.
   *
   * The function is idempotent in the sense that it reuses the menu /
   * input that is already there. It does NOT remove pre-existing
   * attachments.
   *
   * @param {File} file
   * @param {{ onProgress?: (phase: string, info?: object) => void, timeoutMs?: number }} [opts]
   * @returns {Promise<{ ok, error?, method?, fileName?, fileType?, fileSize?, elapsedMs?, diagnostics? }>}
   */
  async function attachFileWithMenu(file, opts) {
    const startedAt = Date.now();
    const emit = (phase, info) => {
      try {
        if (opts && typeof opts.onProgress === "function") opts.onProgress(phase, info);
      } catch (_) {
        /* ignore */
      }
    };

    if (!file || typeof file !== "object" || typeof file.name !== "string") {
      return { ok: false, error: "No file provided" };
    }
    emit("start", { fileName: file.name, size: file.size, type: file.type });

    // 1. Ensure the menu is open.
    const openRes = await openAttachmentMenu();
    if (!openRes.ok) {
      return { ok: false, error: openRes.error, phase: "open-menu" };
    }
    emit("menu-open", { reason: openRes.reason });

    // 2. Make sure a file input is mounted. Some Gemini builds keep the
    //    input mounted after first open; others re-mount per click.
    let inputs = findFileInputs();
    if (inputs.length === 0) {
      const uploadItem = findUploadFilesMenuitem();
      if (!uploadItem) {
        return {
          ok: false,
          error: "Could not find 'Upload files' in the + menu.",
          phase: "find-upload-item",
        };
      }
      try {
        uploadItem.click();
      } catch (e) {
        return {
          ok: false,
          error: `Click on Upload files failed: ${e?.message ?? "unknown"}`,
          phase: "click-upload",
        };
      }
      const startInput = Date.now();
      while (Date.now() - startInput < ATTACH_MENU_OPEN_TIMEOUT_MS) {
        inputs = findFileInputs();
        if (inputs.length > 0) break;
        await sleep(80);
      }
      if (inputs.length === 0) {
        return {
          ok: false,
          error: "Click on Upload files did not mount a <input type='file'> within the timeout.",
          phase: "mount-input",
        };
      }
    }
    emit("input-mounted", { count: inputs.length });

    const input = inputs[0];

    // 3. Inject File via DataTransfer.
    let dataTransfer;
    try {
      dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
    } catch (e) {
      return {
        ok: false,
        error: `DataTransfer construction failed: ${e?.message ?? "unknown"}`,
        phase: "datatransfer",
      };
    }
    try {
      Object.defineProperty(input, "files", {
        value: dataTransfer.files,
        configurable: true,
      });
    } catch (e) {
      return {
        ok: false,
        error: `Could not assign file list to input: ${e?.message ?? "unknown"}`,
        phase: "assign-files",
      };
    }

    // 4. Snapshot the chip count in input-area-v2 BEFORE dispatching events.
    const area = document.querySelector("input-area-v2");
    const chipsBefore = countComposerAttachments(area);
    emit("pre-dispatch", { chipsBefore });

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // 5. Wait for the chip with our filename to appear.
    const timeoutMs = (opts && typeof opts.timeoutMs === "number") ? opts.timeoutMs : ATTACH_FILE_TIMEOUT_MS;
    const result = await waitForAttachmentOf(file.name, chipsBefore, timeoutMs);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        phase: result.phase,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        elapsedMs: Date.now() - startedAt,
        diagnostics: { chipsBefore, chipsAfter: result.chipsAfter ?? null },
      };
    }
    emit("attached", { chipsAfter: result.chipsAfter });

    return {
      ok: true,
      method: "datatransfer+menu",
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      elapsedMs: Date.now() - startedAt,
      chipIndex: result.chipIndex,
      diagnostics: { chipsBefore, chipsAfter: result.chipsAfter },
    };
  }

  /**
   * Count attachments currently in the composer (gem-media-attachment
   * inside input-area-v2).
   */
  function countComposerAttachments(area) {
    if (!area) return 0;
    return area.querySelectorAll("gem-media-attachment").length;
  }

  /**
   * Wait until the chip count in input-area-v2 grows AND a chip
   * containing the given filename appears.
   */
  function waitForAttachmentOf(fileName, chipsBefore, timeoutMs) {
    const start = Date.now();
    return new Promise((resolve) => {
      const area = document.querySelector("input-area-v2");
      if (!area) {
        resolve({ ok: false, error: "Composer not found.", phase: "no-area" });
        return;
      }
      let resolved = false;
      const finalize = (r) => {
        if (resolved) return;
        resolved = true;
        try {
          obs.disconnect();
        } catch (_) {
          /* ignore */
        }
        resolve(r);
      };
      const tick = () => {
        const chips = area.querySelectorAll("gem-media-attachment");
        const chipsAfter = chips.length;
        if (chipsAfter > chipsBefore) {
          // Look for our filename in any chip's text.
          for (let i = 0; i < chips.length; i++) {
            const text = (chips[i].textContent || "").trim();
            if (text.includes(fileName)) {
              finalize({
                ok: true,
                chipsAfter,
                chipIndex: i,
              });
              return;
            }
          }
        }
        if (Date.now() - start >= timeoutMs) {
          finalize({
            ok: false,
            error:
              "Gemini did not acknowledge the attachment within the timeout. " +
              "The chip with our filename did not appear.",
            phase: "wait-for-chip",
            chipsAfter: chips.length,
          });
          return;
        }
        // Schedule next tick.
        setTimeout(tick, 100);
      };
      const obs = new MutationObserver(() => {
        // Don't wait for the periodic tick if the DOM has changed.
        const chips = area.querySelectorAll("gem-media-attachment");
        if (chips.length > chipsBefore) {
          for (let i = 0; i < chips.length; i++) {
            const text = (chips[i].textContent || "").trim();
            if (text.includes(fileName)) {
              finalize({ ok: true, chipsAfter: chips.length, chipIndex: i });
              return;
            }
          }
        }
      });
      obs.observe(area, { childList: true, subtree: true });
      tick();
    });
  }

  /**
   * Public API: attach a single image File to the Gemini composer.
   * Does NOT submit. Does NOT remove existing attachments.
   *
   * @param {File} file
   * @returns {Promise<{ ok, error?, method?, fileName?, fileType?, fileSize?, diagnostics?, observedAttachment? }>}
   */
  async function attachFileToGemini(file) {
    if (!file || typeof file !== "object" || typeof file.name !== "string") {
      return { ok: false, error: "No file provided" };
    }

    log(`attachFileToGemini called (name=${file.name}, size=${file.size}, type=${file.type})`);

    // Pre-flight diagnostics so failures are loud.
    const diag = attachmentDiagnostics();
    const inputs = findFileInputs();
    if (inputs.length === 0) {
      // The input is most likely mounted only after the user opens the
      // attachment menu. We do NOT auto-click here; we tell the caller
      // what's missing so they can use the side panel's "Probe" button
      // to drive the activation flow in a user-visible way.
      const probe = attachmentProbe();
      const hint = probe.inputLikelyDynamic
        ? " Gemini mounts the <input type=\"file\"> only after the user opens the attachment menu. Use the Probe button in the side panel to surface the actual flow."
        : " Gemini's composer toolbar does not appear to expose an upload control right now.";
      return {
        ok: false,
        error: "Gemini upload control not found." + hint,
        diagnostics: probe,
        requiresActivation: probe.inputLikelyDynamic,
      };
    }
    const input = inputs[0];

    // Build a DataTransfer carrying the file. DataTransfer is supported
    // in all evergreen browsers and is the closest analog to "the user
    // picked this file from a system dialog".
    let dataTransfer;
    try {
      dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
    } catch (e) {
      return {
        ok: false,
        error: `DataTransfer construction failed: ${e?.message ?? "unknown"}`,
        diagnostics: diag,
      };
    }

    // Set the file list on the input. Some browsers (and some Gemini
    // versions) listen for either 'input' or 'change' or both.
    try {
      Object.defineProperty(input, "files", {
        value: dataTransfer.files,
        configurable: true,
      });
    } catch (e) {
      return {
        ok: false,
        error: `Could not assign file list to input: ${e?.message ?? "unknown"}`,
        diagnostics: diag,
      };
    }

    // Snapshot the upload area BEFORE firing events so we can detect
    // new attachments reliably (we already had a count; we want the
    // delta).
    const area = findPromptInputArea();
    const hintsBefore = countAttachmentHints(area);
    log(`attachment hints before fire: ${hintsBefore}`);

    // Fire the events Gemini's frontend is listening for. We dispatch on
    // the input directly; this matches what the native file picker does.
    const inputEvent = new Event("input", { bubbles: true });
    const changeEvent = new Event("change", { bubbles: true });
    input.dispatchEvent(inputEvent);
    input.dispatchEvent(changeEvent);

    // Observe the upload area for a new attachment chip / thumbnail.
    const ok = await waitForAttachment(area, hintsBefore);
    if (!ok.ok) {
      return {
        ok: false,
        error: ok.error,
        method: "datatransfer",
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        diagnostics: { ...diag, currentAttachmentHints: countAttachmentHints(area) },
      };
    }

    log(
      `attach success: name=${file.name} size=${file.size} ` +
        `hintsBefore=${hintsBefore} hintsAfter=${ok.hintsAfter}`,
    );
    return {
      ok: true,
      method: "datatransfer",
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      observedAttachment: ok.observed,
      diagnostics: { ...diag, currentAttachmentHints: ok.hintsAfter },
    };
  }

  /**
   * Wait up to ATTACH_TIMEOUT_MS for an attachment chip to appear.
   * Resolves with { ok: true, hintsAfter, observed } on success or
   * { ok: false, error } on timeout.
   *
   * Uses one MutationObserver (no polling). Disconnects on first
   * detection OR on timeout — no leftover observers.
   */
  function waitForAttachment(area, hintsBefore) {
    return new Promise((resolve) => {
      if (!area) {
        resolve({ ok: false, error: "Gemini did not acknowledge the attachment." });
        return;
      }
      let resolved = false;
      const finalize = (result) => {
        if (resolved) return;
        resolved = true;
        try {
          observer.disconnect();
        } catch (_) {
          // ignore
        }
        resolve(result);
      };

      const observer = new MutationObserver(() => {
        const hintsAfter = countAttachmentHints(area);
        if (hintsAfter > hintsBefore) {
          // Found a new attachment indicator. Capture the first one as
          // observed evidence (no content is logged, just structure).
          const observed = describeNewAttachment(area, hintsBefore);
          finalize({ ok: true, hintsAfter, observed });
        }
      });
      observer.observe(area, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "class"],
      });

      setTimeout(() => {
        const hintsAfter = countAttachmentHints(area);
        if (hintsAfter > hintsBefore) {
          const observed = describeNewAttachment(area, hintsBefore);
          finalize({ ok: true, hintsAfter, observed });
          return;
        }
        finalize({
          ok: false,
          error: "Gemini did not acknowledge the attachment within the timeout.",
        });
      }, ATTACH_TIMEOUT_MS);
    });
  }

  function describeNewAttachment(area, hintsBefore) {
    // Return a tiny structural snapshot of the first new attachment-ish
    // element. No file content, no base64. Just enough to debug.
    for (const sel of ATTACHMENT_HINT_SELECTORS) {
      const nodes = area.querySelectorAll(sel);
      if (nodes.length > hintsBefore) {
        const node = nodes[nodes.length - 1] || nodes[0];
        return {
          selector: sel,
          tag: node?.tagName?.toLowerCase() ?? null,
          srcPrefix:
            node?.getAttribute?.("src")?.slice(0, 12) ?? null,
          classHint: (node?.className || "").toString().slice(0, 80),
        };
      }
    }
    return null;
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

  // ---- Send + Preflight + Generation Detection (v0.6) -------------------

  /**
   * Find the Send button. Locale-aware: we accept any label from
   * SEND_BUTTON_LABEL_CANDIDATES that matches exactly (case-sensitive).
   */
  function findSendButtonLocalized() {
    const buttons = Array.from(document.querySelectorAll("button[aria-label]"));
    for (const b of buttons) {
      const label = (b.getAttribute("aria-label") || "").trim();
      if (SEND_BUTTON_LABEL_CANDIDATES.includes(label)) return b;
    }
    return null;
  }

  /**
   * Send the current composer. Idempotent: refuse if button disabled.
   */
  async function sendCurrentComposer() {
    const btn = findSendButtonLocalized();
    if (!btn) {
      return { ok: false, error: "Send button not found.", disabled: null };
    }
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
      return { ok: false, error: "Send button is disabled.", disabled: true };
    }
    const tb = document.querySelector('[role="textbox"]') || findPromptInput();
    if (tb) {
      const txt = ((tb.innerText || "") + (tb.textContent || "")).trim();
      if (txt.length === 0) {
        return { ok: false, error: "Composer is empty.", disabled: true };
      }
    }
    const baselineUserQueries = Array.from(
      document.querySelectorAll("user-query"),
    ).length;
    try {
      btn.click();
    } catch (e) {
      return { ok: false, error: `Send click failed: ${e?.message ?? "unknown"}` };
    }
    const start = Date.now();
    const SEND_DETECT_TIMEOUT_MS = 5000;
    while (Date.now() - start < SEND_DETECT_TIMEOUT_MS) {
      const now = Array.from(document.querySelectorAll("user-query")).length;
      if (now > baselineUserQueries) {
        return {
          ok: true,
          method: "click",
          baselineUserQueries,
          currentUserQueries: now,
          elapsedMs: Date.now() - start,
        };
      }
      await sleep(80);
    }
    return {
      ok: true,
      method: "click",
      baselineUserQueries,
      currentUserQueries: baselineUserQueries,
      elapsedMs: Date.now() - start,
      note: "send-detect-timeout",
    };
  }

  function findSendButtonDiagnostic() {
    const btn = findSendButtonLocalized();
    if (!btn) return { ok: false, found: false };
    return {
      ok: true,
      found: true,
      disabled: btn.disabled || btn.getAttribute("aria-disabled") === "true",
      label: btn.getAttribute("aria-label") || null,
    };
  }

  function captureConversationBaseline() {
    const allImgs = Array.from(document.querySelectorAll("img"));
    const generated = allImgs.filter((i) =>
      /ai generated|generated by ai|gerada por ia|générée par ia/i.test(
        i.getAttribute("alt") || "",
      ),
    );
    return {
      capturedAt: Date.now(),
      userQueryCount: document.querySelectorAll("user-query").length,
      modelResponseCount: document.querySelectorAll("model-response").length,
      generatedImageCount: generated.length,
      generatedImageSrcs: generated
        .map((i) => i.getAttribute("src"))
        .filter(Boolean),
    };
  }

  async function waitForNewGeneratedImage(baseline, timeoutMs) {
    const start = Date.now();
    const POLL_MS = 600;
    const initialUserQueries = baseline?.userQueryCount ?? 0;
    const initialGenerated = new Set(baseline?.generatedImageSrcs ?? []);
    while (Date.now() - start < timeoutMs) {
      const currentUserQueries = document.querySelectorAll("user-query").length;
      if (currentUserQueries <= initialUserQueries) {
        await sleep(POLL_MS);
        continue;
      }
      const responses = Array.from(
        document.querySelectorAll("model-response"),
      );
      if (responses.length === 0) {
        await sleep(POLL_MS);
        continue;
      }
      const newestResponse = responses[responses.length - 1];
      const imgs = Array.from(newestResponse.querySelectorAll("img"));
      const candidates = imgs.filter((i) => {
        const cls = (i.className || "").toString();
        if (!/(\s|^)image(\s|$|animate|loaded)/.test(cls)) return false;
        const alt = i.getAttribute("alt") || "";
        if (!/ai generated|generated by ai|gerada por ia|générée par ia/i.test(alt)) {
          return false;
        }
        if (!(i.naturalWidth > 0)) return false;
        const src = i.getAttribute("src") || "";
        if (!src) return false;
        if (initialGenerated.has(src)) return false;
        return true;
      });
      if (candidates.length === 1) {
        const img = candidates[0];
        const dlBtn = Array.from(
          newestResponse.querySelectorAll('button[aria-label*="Download" i]'),
        )[0];
        return {
          ok: true,
          imageSrc: img.getAttribute("src"),
          alt: img.getAttribute("alt"),
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          downloadControl: dlBtn
            ? { ariaLabel: dlBtn.getAttribute("aria-label") }
            : null,
        };
      }
      if (candidates.length > 1) {
        return {
          ok: false,
          error:
            "Multiple generated images detected. Manual selection required.",
          multipleCount: candidates.length,
        };
      }
      await sleep(POLL_MS);
    }
    return {
      ok: false,
      error: "No new generated image detected within the timeout.",
      timeoutMs,
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
    const attachment = attachmentProbe();
    const imageMode = imageModeProbe();
    const baseline = captureConversationBaseline();
    const sendBtn = findSendButtonDiagnostic();

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
      sendButtonLocalized: sendBtn,
      selected: selected ? describeEl(selected) : null,
      selectedQuillAttached: !!selectedQuill,
      contentLength,
      attachment,
      imageMode,
      baseline,
      candidates: scored,
    };
  }

  globalThis.RedSunDomAdapter = Object.freeze({
    insertPromptIntoGemini,
    attachFileToGemini,
    selfTest,
    describeEl,
    attachmentDiagnostics,
    attachmentProbe,
    activateAttachmentFlow,
    findAttachmentTrigger,
    findFileInputs,
    isAttachmentMenuOpen,
    // v0.6: image generation mode
    ensureImageGenerationMode,
    imageModeProbe,
    findPlusButton,
    findDeselectImagesToggle,
    findCreateImageMenuitem,
    // v0.6: attachment via menu
    attachFileWithMenu,
    openAttachmentMenu,
    findUploadFilesMenuitem,
    countComposerAttachments,
    ATTACH_FILE_TIMEOUT_MS,
    // v0.6: send + preflight + generation detection
    sendCurrentComposer,
    findSendButtonLocalized,
    findSendButtonDiagnostic,
    captureConversationBaseline,
    waitForNewGeneratedImage,
    // Locale candidates (read-only)
    CANDIDATE_SELECTORS,
    SEND_BUTTON_LABEL_CANDIDATES,
    PLUS_BUTTON_LABEL_CANDIDATES,
    CREATE_IMAGE_TEXT_CANDIDATES,
    DESELECT_IMAGE_LABEL_CANDIDATES,
    IMAGE_MODE_CONFIRM_TIMEOUT_MS,
    IMAGE_MODE_ACTIVATE_POLL_MS,
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
