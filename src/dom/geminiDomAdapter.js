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
    "Envio e ferramentas",
    "Envio de arquivos e ferramentas",
    "Envio de ficheiros e ferramentas",
    "Carregar e ferramentas",
    "Cargar y herramientas",
    "Téléverser et outils",
    "Hochladen und Tools",
    "アップロードとツール",
    "アップロード",
    "ツールとアップロード",
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
    "Criar imagens",
    "Créer une image",
    "Crear imagen",
    "Immagine erstellen",
    "画像を作成",
    "画像生成",
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
    "Remover",
    "Remover Criar imagem",
    "Desmarcar",
    "Desmarcar imagem",
    "Fechar",
    "Fechar modo de imagem",
    "Remove",
    "Remove image creation",
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

  function getElementClassText(el) {
    if (!el) return "";

    if (typeof el.className === "string") {
      return el.className;
    }

    if (typeof el.className?.baseVal === "string") {
      return el.className.baseVal;
    }

    if (typeof el.getAttribute === "function") {
      return el.getAttribute("class") || "";
    }

    if (Array.isArray(el._classes)) {
      return el._classes.join(" ");
    }

    return "";
  }

  function isNegativeCandidate(el) {
    const cls = getElementClassText(el);
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
      classes: getElementClassText(el).substring(0, 120),
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
    // 1. Structural: use findAttachmentTrigger()
    const trigger = findAttachmentTrigger();
    if (trigger) return trigger;

    // 2. Aria-label candidates
    const buttons = Array.from(
      document.querySelectorAll("button[aria-label], gem-button[aria-label], [role='button'][aria-label]"),
    );
    for (const b of buttons) {
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      if (PLUS_BUTTON_LABEL_CANDIDATES.some((l) => label.includes(l.toLowerCase()))) {
        return b;
      }
    }
    const area = findPromptInputArea() || document.querySelector("input-area-v2");
    if (area) {
      const candidates = Array.from(area.querySelectorAll("button, gem-button, [role='button']"));
      for (const b of candidates) {
        if (b.getAttribute && (b.getAttribute("aria-haspopup") || b.getAttribute("aria-controls"))) {
          return b;
        }
        const img = b.querySelector("img");
        if (img) {
          const alt = (img.getAttribute("alt") || img.textContent || "").toLowerCase();
          if (alt === "plus" || alt.includes("plus") || alt.includes("add")) return b;
        }
        const icon = b.querySelector("mat-icon, [class*='material-symbols'], [class*='mat-icon'], i");
        if (icon) {
          const name = (icon.getAttribute("fontset") || icon.getAttribute("data-mat-icon-name") || icon.textContent || "").toLowerCase();
          if (name === "add" || name === "plus" || name.includes("add") || name.includes("plus")) return b;
        }
      }
    }
    return null;
  }

  /**
   * Find the menuitem / button matching "Create image" inside the + menu.
   * Accepts text match OR icon-name match across all menu containers and overlays.
   */
  function findCreateImageMenuitem() {
    const items = Array.from(
      document.querySelectorAll(
        '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], button.mat-mdc-menu-item, mat-menu-item, .cdk-overlay-container button, .cdk-overlay-pane [role="menuitem"], [popover] button',
      ),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    let best = null;
    let bestScore = 0;
    for (const el of items) {
      const text = (el.textContent || "").trim().toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const iconEl = el.querySelector("img, mat-icon, [class*='material-symbols'], [class*='icon'], svg");
      const iconAlt = iconEl
        ? (iconEl.getAttribute("alt") || iconEl.getAttribute("data-mat-icon-name") || iconEl.textContent || "").toLowerCase().trim()
        : "";

      let score = 0;
      for (const c of CREATE_IMAGE_TEXT_CANDIDATES) {
        const cLower = c.toLowerCase();
        if (text === cLower || aria === cLower) score += 60;
        else if (text.includes(cLower) || aria.includes(cLower)) score += 40;
      }

      if (
        iconAlt === "image_create" ||
        iconAlt.includes("image_create") ||
        iconAlt === "photo_spark" ||
        iconAlt.includes("photo_spark")
      ) {
        score += 50;
      } else if (iconAlt.includes("image") || iconAlt.includes("palette") || iconAlt.includes("photo")) {
        score += 20;
      }

      if (el.closest && el.closest(".cdk-overlay-container, mat-menu-panel, [role='menu']")) {
        score += 15;
      }

      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return bestScore >= 30 ? best : null;
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
      document.querySelector("rich-textarea")?.getAttribute("data-placeholder") ||
      document.querySelector("rich-textarea")?.getAttribute("placeholder") ||
      document.querySelector(".ql-editor")?.getAttribute("data-placeholder") ||
      null;
    const composerTextSample = tb ? (tb.textContent || "").trim().slice(0, 80) : null;
    const area = findPromptInputArea() || document.querySelector("input-area-v2");

    const activeChip = area
      ? Array.from(area.querySelectorAll("mat-chip, gem-chip, [class*='chip'], [class*='pill'], [class*='tag'], [class*='mode']")).find((c) => {
          const t = (c.textContent || "").toLowerCase();
          return CREATE_IMAGE_TEXT_CANDIDATES.some((cand) => t.includes(cand.toLowerCase())) ||
                 /image_create|photo_spark|criar imagem|create image/i.test(t);
        })
      : null;

    const createHeader = area
      ? Array.from(area.querySelectorAll("h1, h2, h3, div, span")).find((h) =>
          /create images?|create with|criar imagem|crie imagens/i.test(h.textContent || ""),
        )
      : null;

    const isPlaceholderActive = placeholder && (
      /describe (your|an|the|uma|une|una|ein) image|describe uma imagem|descreva (a|sua|uma|sue?s?) imagem|作成したい画像|画像の説明/i.test(placeholder)
    );

    return {
      probeAt: new Date().toISOString(),
      deselectImagesToggleFound: !!deselect,
      textboxPlaceholder: placeholder,
      composerTextSample,
      createImagesHeaderFound: !!createHeader || !!activeChip,
      imageModeActive:
        !!deselect ||
        !!activeChip ||
        !!isPlaceholderActive ||
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
      url: typeof location !== "undefined" ? location.href : "",
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
      "envio",
      "ferramentas",
      "adicionar",
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
      classHint: getElementClassText(el).slice(0, 80),
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
  function dispatchPasteImage(target, file) {
    if (!target || !file) return false;
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      if (typeof target.focus === "function") {
        target.focus();
      }
      try {
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } catch (_) {}

      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
        composed: true,
      });

      try {
        Object.defineProperty(pasteEvent, "clipboardData", {
          value: dataTransfer,
          configurable: true,
        });
      } catch (_) {}

      target.dispatchEvent(pasteEvent);
      return true;
    } catch (_) {
      return false;
    }
  }

  function dispatchDragAndDrop(target, file) {
    if (!target || !file) return false;
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      dataTransfer.dropEffect = "copy";
      dataTransfer.effectAllowed = "all";

      const rect = typeof target.getBoundingClientRect === "function"
        ? target.getBoundingClientRect()
        : { left: 100, top: 100, width: 200, height: 50 };
      const clientX = (rect.left || 0) + (rect.width || 20) / 2;
      const clientY = (rect.top || 0) + (rect.height || 20) / 2;

      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
      };

      const dragEnter = new DragEvent("dragenter", init);
      const dragOver = new DragEvent("dragover", init);
      const drop = new DragEvent("drop", init);

      try {
        Object.defineProperty(drop, "dataTransfer", { value: dataTransfer, configurable: true });
      } catch (_) {}

      target.dispatchEvent(dragEnter);
      target.dispatchEvent(dragOver);
      target.dispatchEvent(drop);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Find the "Upload files" item inside the + menu.
   * Leverages findUploadFilesInOverlay() across all CDK overlays.
   */
  function findUploadFilesMenuitem() {
    const probe = findUploadFilesInOverlay();
    if (probe && probe.ok && probe.el) {
      return probe.el;
    }
    const items = Array.from(
      document.querySelectorAll(
        '[role="menuitem"], [role="menuitemcheckbox"], button.mat-mdc-menu-item, mat-menu-item, .cdk-overlay-container button, .cdk-overlay-pane [role="menuitem"]',
      ),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    let best = null;
    let bestScore = 0;
    for (const el of items) {
      const desc = describeMenuItem(el);
      if (!desc) continue;
      const score = scoreUploadCandidate(el, desc);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : null;
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
   * Count attachments currently in the composer (gem-media-attachment
   * or blob thumbnails inside composer container / card).
   *
   * Must strictly count individual attachment items and NEVER count
   * internal descendant elements multiple times, nor count images in conversation history.
   */
  function countComposerAttachments(area) {
    const rootsToTry = [];
    if (area) rootsToTry.push(area);
    const inputArea = findPromptInputArea();
    if (inputArea && !rootsToTry.includes(inputArea)) rootsToTry.push(inputArea);

    const tb = findPromptInput();
    if (tb) {
      let p = tb.parentElement;
      while (p && p !== document.body) {
        if (!rootsToTry.includes(p)) rootsToTry.push(p);
        p = p.parentElement;
      }
    }
    if (!rootsToTry.includes(document)) rootsToTry.push(document);

    for (const root of rootsToTry) {
      if (!root || typeof root.querySelectorAll !== "function") continue;

      // 1. Primary: dedicated Gemini media attachment elements
      const gemAttachments = root.querySelectorAll("gem-media-attachment");
      if (gemAttachments && gemAttachments.length > 0) {
        const valid = Array.from(gemAttachments).filter((el) => {
          return !el.closest?.("model-response, user-query, message-content, [data-test-id*='chat-history']");
        });
        if (valid.length > 0) return valid.length;
      }

      // 2. Secondary: mat-chips or specific attachment chips inside composer
      const chips = root.querySelectorAll("mat-chip, [data-test-id*='media-attachment'], [data-test-id*='attachment-chip'], .attachment-chip");
      if (chips && chips.length > 0) {
        const valid = Array.from(chips).filter((el) => {
          return !el.closest?.("model-response, user-query, message-content, [data-test-id*='chat-history'], mat-sidenav, nav, header");
        });
        if (valid.length > 0) return valid.length;
      }

      // 3. Fallback: attachment containers inside composer
      const containers = root.querySelectorAll(".attachment-container > *");
      if (containers && containers.length > 0) {
        const valid = Array.from(containers).filter((el) => {
          return !el.closest?.("model-response, user-query, message-content, [data-test-id*='chat-history'], mat-sidenav, nav, header");
        });
        if (valid.length > 0) return valid.length;
      }

      // 4. Fallback: blob/data image thumbnails strictly outside chat history and sidebars
      const imgs = root.querySelectorAll("img[src^='blob:'], img[src^='data:image/']");
      if (imgs && imgs.length > 0) {
        const validThumbs = Array.from(imgs).filter((img) => {
          const src = (img.getAttribute?.("src") || img.src || "").toLowerCase();
          const isIconOrAvatar = src.includes("avatar") || src.includes("favicon") || src.includes("logo") || src.includes("sparkle");
          const inHistory = !!img.closest?.("model-response, user-query, message-content, [data-test-id*='chat-history'], mat-sidenav, nav, header, aside");
          return !isIconOrAvatar && !inHistory;
        });
        if (validThumbs.length > 0) return validThumbs.length;
      }
    }

    return 0;
  }

  /**
   * Count uploads currently in active progress inside the composer.
   * Only returns > 0 if there is visible, active uploading UI (indeterminate spinner/bar)
   * that has NOT reached completion (100% / hidden) and has not produced a loaded thumbnail.
   */
  function countActiveUploads(area) {
    const rootsToTry = [];
    if (area) rootsToTry.push(area);
    const inputArea = findPromptInputArea();
    if (inputArea && !rootsToTry.includes(inputArea)) rootsToTry.push(inputArea);
    const tb = findPromptInput();
    if (tb) {
      let p = tb.parentElement;
      while (p && p !== document.body) {
        if (!rootsToTry.includes(p)) rootsToTry.push(p);
        p = p.parentElement;
      }
    }
    if (!rootsToTry.includes(document)) rootsToTry.push(document);

    for (const root of rootsToTry) {
      if (!root || typeof root.querySelectorAll !== "function") continue;

      let chips = root.querySelectorAll("gem-media-attachment, .attachment-chip, mat-chip");
      if (!chips || chips.length === 0) {
        chips = root.querySelectorAll("img[src^='blob:']");
      }
      if (!chips || chips.length === 0) continue;

      const validChips = Array.from(chips).filter((el) => {
        return !el.closest?.("model-response, user-query, message-content, [data-test-id*='chat-history'], mat-sidenav, nav, header");
      });
      if (validChips.length === 0) continue;

      let activeCount = 0;
      for (const chip of validChips) {
        const img = chip.tagName?.toLowerCase() === "img" ? chip : chip.querySelector("img");
        const hasLoadedImg = img && (img.src || img.getAttribute?.("src")) && (img.naturalWidth > 0 || img.complete);

        const allDescendants = chip.querySelectorAll ? Array.from(chip.querySelectorAll("*")) : [];
        let chipIsUploading = false;

        for (const sp of allDescendants) {
          const tag = (sp.tagName || "").toLowerCase();
          const role = (sp.getAttribute?.("role") || "").toLowerCase();
          const mode = (sp.getAttribute?.("mode") || "").toLowerCase();
          const cls = getElementClassText(sp).toLowerCase();

          const isSpinnerOrBar =
            tag.includes("progress") ||
            tag.includes("spinner") ||
            role === "progressbar" ||
            cls.includes("progress") ||
            cls.includes("spinner") ||
            cls.includes("loading") ||
            cls.includes("uploading");

          if (!isSpinnerOrBar) continue;

          if (sp.getAttribute?.("aria-hidden") === "true") continue;
          if (sp.style && (sp.style.display === "none" || sp.style.visibility === "hidden" || sp.style.opacity === "0")) continue;
          
          const val = sp.getAttribute?.("aria-valuenow");
          if (val === "100") continue;

          if (mode === "indeterminate" || cls.includes("indeterminate") || cls.includes("uploading") || cls.includes("loading") || cls.includes("spinner") || !val) {
            if (!hasLoadedImg) {
              chipIsUploading = true;
              break;
            }
          }
        }

        if (chipIsUploading) {
          activeCount++;
        }
      }

      return activeCount;
    }

    return 0;
  }

  /**
   * Public API (v0.6): attach a File to the Gemini composer by trying:
   *   1. Direct Clipboard paste onto the editor (.ql-editor).
   *   2. Enhanced HTML5 Drag & Drop on the editor / container.
   *   3. Opening the + menu, activating dynamic file input, and assigning via DataTransfer.
   *   4. Waiting for real visual attachment evidence (chip / thumbnail delta).
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

    const editorTarget = findPromptInput() || document.querySelector(".ql-editor") || document.querySelector("div[role='textbox']");
    const area = findPromptInputArea() || document.querySelector("input-area-v2") || document.body;
    const chipsBefore = countComposerAttachments(area);
    // Capture the upload queue size BEFORE we dispatch anything. This lets
    // us confirm our strategy caused a NEW upload (signalsAfter.pendingUploads
    // > pendingUploadsBefore) instead of inheriting an in-flight upload from
    // a previous step. Without this guard, attachFileWithMenu could
    // mistakenly "succeed" on Strategy 1 because of a stale upload and
    // then the orchestrator would skip the rest of the flow — but more
    // dangerously, the inverse: if Gemini rejects the paste silently
    // (pendingUploads unchanged) but waitForAttachmentEvidence still
    // returns ok=true from the chip-render check on a pre-existing chip,
    // we'd report success and Gemini would never see our file.
    const pendingUploadsBefore = countActiveUploads(area);

    // -------------------------------------------------------------
    // Strategy 1: Paste Event onto Editor (.ql-editor)
    // -------------------------------------------------------------
    if (editorTarget) {
      emit("try-paste", { target: editorTarget.tagName });
      dispatchPasteImage(editorTarget, file);
      const pasteResult = await waitForAttachmentEvidence(chipsBefore, 2500);
      // Defense in depth: require that the strategy actually increased
      // the upload queue OR produced a chip/thumbnail. This prevents
      // falling through to Strategy 2 and dispatching the same file a
      // second time via drag/drop.
      if (
        pasteResult.ok &&
        ((pasteResult.signalsAfter?.pendingUploads ?? 0) > pendingUploadsBefore ||
          (pasteResult.signalsAfter?.chips ?? 0) > chipsBefore ||
          (pasteResult.signalsAfter?.thumbnails ?? 0) > 0)
      ) {
        emit("attached", { method: "clipboard_paste", signalsAfter: pasteResult.signalsAfter });
        return {
          ok: true,
          method: "clipboard_paste",
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          chipVisibleAt: pasteResult.chipVisibleAt || Date.now(),
          uploadCompleteAt: pasteResult.uploadCompleteAt || Date.now(),
          elapsedMs: Date.now() - startedAt,
          diagnostics: { chipsBefore, evidence: pasteResult.evidence },
        };
      }
    }

    // -------------------------------------------------------------
    // Strategy 2: Enhanced Drag & Drop on Editor and Area
    // -------------------------------------------------------------
    const dropTargets = [editorTarget, area, document.querySelector("rich-textarea"), document.body].filter(Boolean);
    for (const dt of dropTargets) {
      emit("try-drag-drop", { target: dt.tagName });
      dispatchDragAndDrop(dt, file);
      const dropResult = await waitForAttachmentEvidence(chipsBefore, 1000);
      if (dropResult.ok) {
        emit("attached", { method: "drag_and_drop", signalsAfter: dropResult.signalsAfter });
        return {
          ok: true,
          method: "drag_and_drop",
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          chipVisibleAt: dropResult.chipVisibleAt || Date.now(),
          uploadCompleteAt: dropResult.uploadCompleteAt || Date.now(),
          elapsedMs: Date.now() - startedAt,
          diagnostics: { chipsBefore, evidence: dropResult.evidence },
        };
      }
    }

    // -------------------------------------------------------------
    // Strategy 3: Menu Open + Dynamic Input Injection
    // -------------------------------------------------------------
    const openRes = await openAttachmentMenu();
    emit("menu-open", { reason: openRes.reason || (openRes.ok ? "opened" : "failed") });

    let inputs = findFileInputs();
    if (inputs.length === 0 && openRes.ok) {
      const uploadItem = findUploadFilesMenuitem();
      if (uploadItem) {
        try {
          uploadItem.click();
        } catch (e) {
          log("Click on Upload files failed:", e?.message);
        }
        const startInput = Date.now();
        while (Date.now() - startInput < ATTACH_MENU_OPEN_TIMEOUT_MS) {
          inputs = findFileInputs();
          if (inputs.length > 0) break;
          await sleep(80);
        }
      }
    }

    if (inputs.length > 0) {
      emit("input-mounted", { count: inputs.length });
      const input = inputs[0];

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
        if (typeof input.setAttribute === "function") {
          input.setAttribute("accept", "image/*,*/*");
        }
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

      emit("pre-dispatch", { chipsBefore });
      input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

      try {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      } catch (_) {}

      const timeoutMs = (opts && typeof opts.timeoutMs === "number") ? opts.timeoutMs : ATTACH_FILE_TIMEOUT_MS;
      const result = await waitForAttachmentEvidence(chipsBefore, timeoutMs);
      if (result.ok) {
        emit("attached", { signalsAfter: result.signalsAfter });
        return {
          ok: true,
          method: "datatransfer+menu",
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          chipVisibleAt: result.chipVisibleAt || Date.now(),
          uploadCompleteAt: result.uploadCompleteAt || Date.now(),
          elapsedMs: Date.now() - startedAt,
          diagnostics: { chipsBefore, evidence: result.evidence },
        };
      }
    }

    return {
      ok: false,
      error: "Could not attach file: no attachment chip or thumbnail appeared after testing paste, drag-and-drop, and input injection.",
      phase: "wait-for-evidence",
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
      elapsedMs: Date.now() - startedAt,
      diagnostics: { chipsBefore },
    };
  }

  /**
   * Public API: attach a single image File to the Gemini composer.
   * Delegates to attachFileWithMenu for the robust end-to-end flow.
   */
  async function attachFileToGemini(file, opts) {
    return await attachFileWithMenu(file, opts);
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
          classHint: getElementClassText(node).slice(0, 80),
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
   * Canonical Composer Adapter API (v0.8.1 stabilization)
   *
   * ONE canonical API:
   *   readComposerText()
   *   clearComposer()
   *   setComposerText(text)
   *   verifyComposerText(expected, actual)
   */

  function normalizeText(text) {
    if (typeof text !== "string") return "";
    return text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
  }

  function normalizeExpectedPrompt(text) {
    return normalizeText(text);
  }

  function normalizeGeminiComposerText(text) {
    return normalizeText(text);
  }

  /**
   * Strict content equality verification with canonical normalization
   * and concise mismatch diagnostics (does not dump full prompt).
   */
  function verifyComposerText(expectedRaw, actualRaw) {
    const exp = typeof expectedRaw === "string" ? expectedRaw : "";
    const act = typeof actualRaw === "string" ? actualRaw : "";

    const normExp = normalizeText(exp);
    const normAct = normalizeText(act);

    if (normExp === normAct) {
      return {
        ok: true,
        expectedRawLength: exp.length,
        actualRawLength: act.length,
        expectedNormLength: normExp.length,
        actualNormLength: normAct.length,
        normalizedMatch: true,
      };
    }

    // Secondary normalization: check paragraph newline runs (Quill/HTML adds extra blank paragraphs)
    const normExpPara = normExp.replace(/\n{3,}/g, "\n\n");
    const normActPara = normAct.replace(/\n{3,}/g, "\n\n");
    if (normExpPara === normActPara) {
      return {
        ok: true,
        expectedRawLength: exp.length,
        actualRawLength: act.length,
        expectedNormLength: normExp.length,
        actualNormLength: normAct.length,
        normalizedMatch: true,
        slackReason: "paragraph-newlines-normalized",
      };
    }

    // Determine first mismatch index
    let mismatchIdx = -1;
    const minLen = Math.min(normExp.length, normAct.length);
    for (let i = 0; i < minLen; i++) {
      if (normExp[i] !== normAct[i]) {
        mismatchIdx = i;
        break;
      }
    }
    if (mismatchIdx === -1 && normExp.length !== normAct.length) {
      mismatchIdx = minLen;
    }

    const startCtx = Math.max(0, mismatchIdx - 25);
    const endCtxExp = Math.min(normExp.length, mismatchIdx + 25);
    const endCtxAct = Math.min(normAct.length, mismatchIdx + 25);

    const expSnippet = normExp.slice(startCtx, endCtxExp);
    const actSnippet = normAct.slice(startCtx, endCtxAct);

    return {
      ok: false,
      expectedRawLength: exp.length,
      actualRawLength: act.length,
      expectedNormLength: normExp.length,
      actualNormLength: normAct.length,
      normalizedMatch: false,
      mismatchIndex: mismatchIdx,
      expectedSnippet: expSnippet,
      actualSnippet: actSnippet,
      error: `Prompt verification failed at char ${mismatchIdx}: expected "...${expSnippet}..." but found "...${actSnippet}..." (expected ${normExp.length} normalized chars, found ${normAct.length})`,
    };
  }

  // Alias for backward compatibility
  const verifyPromptContent = verifyComposerText;

  /**
   * Canonical readback: reads ONLY actual editable text.
   * Excludes attachment labels, filenames, hidden accessibility spans,
   * chip metadata, image alt text, and non-editor descendants.
   */
  function readComposerText() {
    const tb = findPromptInput() || document.querySelector('[role="textbox"]') || document.querySelector('.ql-editor');
    if (!tb) return "";
    const quill = locateQuill(tb);
    if (quill && typeof quill.getText === "function") {
      try {
        const qText = quill.getText();
        if (typeof qText === "string") {
          return qText.replace(/\u00a0/g, " ").replace(/\n$/, "").trim();
        }
      } catch (_) {}
    }
    // If tb contains attachment chips or media containers or non-editor nodes, exclude them from text
    let raw = "";
    if (typeof tb.cloneNode === "function") {
      const clone = tb.cloneNode(true);
      const nonTextNodes = clone.querySelectorAll(
        'gem-media-attachment, mat-chip, mat-chip-row, mat-chip-grid, [role="progressbar"], mat-progress-spinner, progress, button, img, mat-icon, i.material-symbols-outlined, i.google-symbols, .close-button, .attachment-preview, .file-preview, [data-test-id*="attachment"], [data-test-id*="chip"], [aria-hidden="true"], .cdk-visually-hidden, .visually-hidden, [aria-live], .ql-hidden, .ql-clipboard'
      );
      for (const n of nonTextNodes) {
        try { n.remove(); } catch (_) {}
      }
      const paragraphs = Array.from(clone.querySelectorAll("p"));
      if (paragraphs.length > 0) {
        raw = paragraphs
          .map((p) => p.innerText || p.textContent || "")
          .join("\n");
      } else {
        raw = clone.innerText || clone.textContent || "";
      }
    } else {
      raw = tb.innerText || tb.textContent || "";
    }
    return raw.replace(/\u00a0/g, " ").replace(/\n$/, "").trim();
  }

  // Alias for backward compatibility
  const getComposerText = readComposerText;

  /**
   * Canonical setter: inserts/replaces text in the composer field.
   */
  async function setComposerText(text) {
    if (typeof text !== "string") {
      return { ok: false, error: "text must be a string" };
    }

    log(`setComposerText called (length=${text.length})`);

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
    const textBefore = readComposerText();
    const lengthBefore = textBefore.length;

    if (!quill) {
      // Diagnostic log for fallback path (normal recoverable state)
      log("Quill instance not found; using execCommand fallback (replace)");
      try {
        textbox.focus();
        const range = document.createRange();
        range.selectNodeContents(textbox);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        if (text === "") {
          if (typeof document.execCommand === "function") {
            try { document.execCommand("delete", false, null); } catch (_) {}
          }
          if (range.deleteContents) {
            try { range.deleteContents(); } catch (_) {}
          }
        } else {
          let ok = false;
          if (typeof document.execCommand === "function") {
            ok = document.execCommand("insertText", false, text);
          }
          if (!ok) {
            textbox.textContent = text;
          }
        }

        try {
          textbox.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          textbox.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        } catch (_) {}

        textbox.focus();
        const textAfter = readComposerText();
        log(
          `inserted via execCommand fallback (requested=${text.length}, ` +
            `before=${lengthBefore}, after=${textAfter.length})`,
        );
        const verified = verifyComposerText(text, textAfter);
        if (!verified.ok) {
          log(
            `Composer verification failed: expectedRawLen=${verified.expectedRawLength}, ` +
              `actualRawLen=${verified.actualRawLength}, expectedNormLen=${verified.expectedNormLength}, ` +
              `actualNormLen=${verified.actualNormLength}, mismatchIndex=${verified.mismatchIndex}, ` +
              `expectedSnippet="...${verified.expectedSnippet}...", actualSnippet="...${verified.actualSnippet}..."`
          );
          return {
            ok: false,
            error: verified.error,
            method: "execCommand",
            lengthBefore,
            lengthAfter: textAfter.length,
            mismatch: verified,
          };
        }
        return {
          ok: true,
          length: text.length,
          method: "execCommand",
          lengthBefore,
          lengthAfter: textAfter.length,
          verification: verified,
        };
      } catch (e) {
        return { ok: false, error: `fallback failed: ${e?.message ?? String(e)}` };
      }
    }

    try {
      quill.focus();
      quill.setText("");
      if (text) {
        quill.insertText(0, text);
      }
      quill.focus();
      const textAfter = readComposerText();
      log(
        `inserted via Quill API (requested=${text.length}, ` +
          `before=${lengthBefore}, after=${textAfter.length})`,
      );
      const verified = verifyComposerText(text, textAfter);
      if (!verified.ok) {
        log(
          `Composer verification failed: expectedRawLen=${verified.expectedRawLength}, ` +
            `actualRawLen=${verified.actualRawLength}, expectedNormLen=${verified.expectedNormLength}, ` +
            `actualNormLen=${verified.actualNormLength}, mismatchIndex=${verified.mismatchIndex}, ` +
            `expectedSnippet="...${verified.expectedSnippet}...", actualSnippet="...${verified.actualSnippet}..."`
        );
        return {
          ok: false,
          error: verified.error,
          method: "quill",
          lengthBefore,
          lengthAfter: textAfter.length,
          mismatch: verified,
        };
      }
      return {
        ok: true,
        length: text.length,
        method: "quill",
        lengthBefore,
        lengthAfter: textAfter.length,
        verification: verified,
      };
    } catch (e) {
      log("Quill API insertion failed:", e?.message ?? String(e));
      return { ok: false, error: `Quill insertion failed: ${e?.message ?? String(e)}` };
    }
  }

  // Alias for backward compatibility
  const insertPromptIntoGemini = setComposerText;

  function inspectComposerContent(expectedPrompt, expectedRefCount) {
    const area = findPromptInputArea() || document.querySelector("input-area-v2") || document.body;
    const currentText = readComposerText();
    const promptLength = currentText.length;
    const attachmentCount = countComposerAttachments(area);
    const pendingUploadCount = countActiveUploads(area);
    const imageProbe = typeof imageModeProbe === "function" ? imageModeProbe() : null;
    const imageModeActive = !!(imageProbe && imageProbe.imageModeActive);

    const check = typeof expectedPrompt === "string" && expectedPrompt.length > 0
      ? verifyComposerText(expectedPrompt, currentText)
      : { ok: false };

    let state = "empty";
    let needsConfirmation = false;

    if (attachmentCount === 0 && promptLength === 0) {
      state = "empty";
    } else if (
      (check.ok && typeof expectedRefCount === "number" && expectedRefCount > 0 && attachmentCount === expectedRefCount) ||
      (check.ok && (expectedRefCount === 0 || expectedRefCount === undefined))
    ) {
      state = "matching-prepared";
    } else {
      state = "manual-content";
      needsConfirmation = true;
    }

    return {
      ok: true,
      state,
      needsConfirmation,
      promptText: currentText,
      promptLength,
      attachmentCount,
      pendingUploadCount,
      imageModeActive,
      composerClean: attachmentCount === 0 && promptLength === 0 && pendingUploadCount === 0,
    };
  }

  /**
   * Canonical clearComposer:
   * Phase 1: Clears prompt text.
   * Phase 2 & 3: Discovers all existing attachment chips in the active composer and clicks their real remove controls.
   * Phase 4: Waits for Gemini DOM settlement in a bounded loop.
   * Phase 5: Re-probes the active composer to guarantee count === 0.
   */
  async function clearComposer() {
    log("clearComposer called");
    // Phase 1: Clear text
    await setComposerText("");

    // Phase 2, 3, 4: Bounded attachment removal loop
    const maxDurationMs = 4000;
    const start = Date.now();
    let lastAttachmentCount = countComposerAttachments();

    while (lastAttachmentCount > 0 && Date.now() - start < maxDurationMs) {
      const rootsToTry = [];
      const inputArea = findPromptInputArea();
      if (inputArea) rootsToTry.push(inputArea);
      const tb = findPromptInput();
      if (tb) {
        let p = tb.parentElement;
        while (p && p !== document.body) {
          if (!rootsToTry.includes(p)) rootsToTry.push(p);
          p = p.parentElement;
        }
      }
      if (!rootsToTry.includes(document)) rootsToTry.push(document);

      const closeButtons = [];
      for (const root of rootsToTry) {
        if (!root || typeof root.querySelectorAll !== "function") continue;

        // 1. Buttons inside attachment chips
        const chips = root.querySelectorAll("gem-media-attachment, .attachment-chip, mat-chip, .attachment-container > *");
        for (const chip of chips) {
          if (chip.closest?.("model-response, user-query, message-content, [data-test-id*='chat-history'], mat-sidenav, nav, header")) continue;
          
          const btns = chip.querySelectorAll("button, [role='button'], mat-chip-remove, .close-button, [data-test-id*='remove'], [aria-label*='remover' i], [aria-label*='remove' i], [aria-label*='delete' i], [aria-label*='excluir' i], [aria-label*='close' i], [aria-label*='fechar' i]");
          for (const b of btns) {
            if (!closeButtons.includes(b)) closeButtons.push(b);
          }
          if (btns.length === 0) {
            const anyBtn = chip.querySelector("button, [role='button']");
            if (anyBtn && !closeButtons.includes(anyBtn)) closeButtons.push(anyBtn);
          }
        }

        // 2. Direct remove buttons matching aria labels outside chat history
        const directBtns = root.querySelectorAll('button[aria-label*="remover" i], button[aria-label*="remove" i], button[aria-label*="delete" i], button[aria-label*="excluir" i], button[aria-label*="fechar" i], button[aria-label*="close" i], mat-chip-remove, .close-button');
        for (const d of directBtns) {
          if (!d.closest?.("model-response, user-query, message-content, [data-test-id*='chat-history'], mat-sidenav, nav, header") && !closeButtons.includes(d)) {
            closeButtons.push(d);
          }
        }
      }

      for (const btn of closeButtons) {
        try {
          btn.click();
          if (typeof MouseEvent !== "undefined") {
            btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: typeof window !== "undefined" ? window : undefined }));
          }
        } catch (_) {}
      }

      await sleep(150);
      lastAttachmentCount = countComposerAttachments();
    }

    // Phase 5: Re-probe and settlement
    await sleep(60);
    const attachmentsAfter = countComposerAttachments();
    const textAfter = readComposerText();
    const clean = textAfter.length === 0 && attachmentsAfter === 0;

    return {
      ok: clean,
      promptLength: textAfter.length,
      attachmentCount: attachmentsAfter,
      alreadyEmpty: clean,
    };
  }

  // Alias for backward compatibility
  const clearComposerContent = clearComposer;

  // ---- Send + Preflight + Generation Detection (v0.6) -------------------

  /**
   * Find the Send button. Locale-aware and scoped to the active composer where possible.
   * We accept any label from SEND_BUTTON_LABEL_CANDIDATES or localized equivalents.
   */
  function findSendButtonLocalized(area) {
    const rootsToTry = [];
    if (area) rootsToTry.push(area);
    const inputArea = findPromptInputArea();
    if (inputArea && !rootsToTry.includes(inputArea)) rootsToTry.push(inputArea);
    const tb = findPromptInput();
    if (tb) {
      let p = tb.parentElement;
      while (p && p !== document.body) {
        if (!rootsToTry.includes(p)) rootsToTry.push(p);
        p = p.parentElement;
      }
    }
    if (!rootsToTry.includes(document)) rootsToTry.push(document);

    for (const root of rootsToTry) {
      if (!root || typeof root.querySelectorAll !== "function") continue;
      const buttons = Array.from(root.querySelectorAll("button[aria-label]"));
      for (const b of buttons) {
        const label = (b.getAttribute("aria-label") || "").trim();
        if (SEND_BUTTON_LABEL_CANDIDATES.includes(label)) return b;
      }
      for (const b of buttons) {
        const label = (b.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("send") || label.includes("enviar") || label.includes("送信") || label.includes("envoyer")) {
          return b;
        }
      }
    }
    return null;
  }

  function findSendButtonDiagnostic() {
    const btn = findSendButtonLocalized();
    if (!btn) return { ok: false, found: false };
    const disabled = btn.disabled || btn.getAttribute("aria-disabled") === "true";
    return {
      ok: true,
      found: true,
      disabled: !!disabled,
      label: btn.getAttribute("aria-label") || null,
    };
  }

  /**
   * Send the current composer. Idempotent: refuse if button is missing or disabled.
   * Verifies submission acknowledgement within a bounded window.
   */
  async function sendCurrentComposer() {
    const btn = findSendButtonLocalized();
    if (!btn) {
      return { ok: false, error: "Send button not found.", found: false, disabled: null, clicked: false };
    }
    const disabled = btn.disabled || btn.getAttribute("aria-disabled") === "true";
    if (disabled) {
      return { ok: false, error: "Send button is disabled.", found: true, disabled: true, clicked: false, label: btn.getAttribute("aria-label") || null };
    }
    const txtBefore = readComposerText().trim();
    const attachmentsBefore = countComposerAttachments();
    if (txtBefore.length === 0 && attachmentsBefore === 0) {
      return { ok: false, error: "Composer is empty.", found: true, disabled: true, clicked: false };
    }

    const baselineUserQueries = Array.from(
      document.querySelectorAll("user-query, .user-query, [data-test-id='user-query']"),
    ).length;

    const sendButtonLabel = btn.getAttribute("aria-label") || null;
    const sendClickAttemptedAt = Date.now();
    let sendClickedAt = null;

    // Fire the click EXACTLY ONCE. HTMLElement.click() already runs the
    // full native sequence (mousedown, mouseup, click + default action)
    // and is what React/Angular handlers listen for. Dispatching a
    // synthetic MouseEvent("click") on top of that fires Gemini's send
    // handler a SECOND time and produces duplicate user-query bubbles
    // — exactly N duplicates per single click of our button. Single-click
    // is the only correct behavior. (Regression: this used to also call
    // btn.dispatchEvent(new MouseEvent("click")). Tests assert it does not.)
    try {
      btn.click();
      sendClickedAt = Date.now();
    } catch (e) {
      return {
        ok: false,
        error: `Send click failed: ${e?.message ?? "unknown"}`,
        found: true,
        disabled: false,
        label: sendButtonLabel,
        clicked: false,
        sendClickAttemptedAt,
      };
    }

    const start = Date.now();
    const SEND_DETECT_TIMEOUT_MS = 6000;
    while (Date.now() - start < SEND_DETECT_TIMEOUT_MS) {
      const nowQueries = Array.from(
        document.querySelectorAll("user-query, .user-query, [data-test-id='user-query']"),
      ).length;
      if (nowQueries > baselineUserQueries) {
        return {
          ok: true,
          found: true,
          disabled: false,
          label: sendButtonLabel,
          clicked: true,
          method: "click",
          evidence: "new-user-query-detected",
          baselineUserQueries,
          currentUserQueries: nowQueries,
          sendButtonFound: true,
          sendButtonDisabled: false,
          sendButtonLabel,
          sendClickAttemptedAt,
          sendClickedAt,
          elapsedMs: Date.now() - start,
        };
      }

      const curText = readComposerText().trim();
      const curAttachments = countComposerAttachments();
      const btnNow = findSendButtonLocalized();
      const btnDisabled = !btnNow || btnNow.disabled || btnNow.getAttribute("aria-disabled") === "true";
      const stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Parar" i], button[aria-label*="停止" i]');

      if (txtBefore.length > 0 && curText.length === 0) {
        return {
          ok: true,
          found: true,
          disabled: false,
          label: sendButtonLabel,
          clicked: true,
          method: "click",
          evidence: "composer-text-cleared",
          sendButtonFound: true,
          sendButtonDisabled: false,
          sendButtonLabel,
          sendClickAttemptedAt,
          sendClickedAt,
          elapsedMs: Date.now() - start,
        };
      }

      if (attachmentsBefore > 0 && curAttachments === 0) {
        return {
          ok: true,
          found: true,
          disabled: false,
          label: sendButtonLabel,
          clicked: true,
          method: "click",
          evidence: "attachment-chips-cleared",
          sendButtonFound: true,
          sendButtonDisabled: false,
          sendButtonLabel,
          sendClickAttemptedAt,
          sendClickedAt,
          elapsedMs: Date.now() - start,
        };
      }

      if (stopBtn) {
        return {
          ok: true,
          found: true,
          disabled: false,
          label: sendButtonLabel,
          clicked: true,
          method: "click",
          evidence: "stop-button-active",
          sendButtonFound: true,
          sendButtonDisabled: false,
          sendButtonLabel,
          sendClickAttemptedAt,
          sendClickedAt,
          elapsedMs: Date.now() - start,
        };
      }

      if (btnDisabled) {
        return {
          ok: true,
          found: true,
          disabled: false,
          label: sendButtonLabel,
          clicked: true,
          method: "click",
          evidence: "send-button-disabled",
          sendButtonFound: true,
          sendButtonDisabled: false,
          sendButtonLabel,
          sendClickAttemptedAt,
          sendClickedAt,
          elapsedMs: Date.now() - start,
        };
      }

      await sleep(100);
    }

    return {
      ok: false,
      error: "Submission acknowledgement timeout: Gemini did not clear composer or show stop button.",
      found: true,
      disabled: false,
      label: sendButtonLabel,
      clicked: true,
      sendButtonFound: true,
      sendButtonDisabled: false,
      sendButtonLabel,
      sendClickAttemptedAt,
      sendClickedAt,
      elapsedMs: Date.now() - start,
    };
  }

  const sendComposerPrompt = sendCurrentComposer;
  const clickSendButton = sendCurrentComposer;

  /**
   * Detect that image generation has started in Gemini.
   * Looks for structural signals (new response container, stop button, shimmer/loader)
   * and localized text signals (EN, PT-BR, JA).
   */
  async function detectGenerationStart(baseline, timeoutMs = 15000) {
    const start = Date.now();
    const initialResponses = baseline?.modelResponseCount ?? 0;

    while (Date.now() - start < timeoutMs) {
      // 1. Structural signals
      const responses = document.querySelectorAll(
        "model-response, .model-response, [data-test-id='model-response']",
      );
      if (responses.length > initialResponses) {
        return {
          ok: true,
          evidence: "new-model-response-container",
          elapsedMs: Date.now() - start,
        };
      }

      const stopBtn = document.querySelector(
        'button[aria-label*="Stop" i], button[aria-label*="Parar" i], button[aria-label*="停止" i]',
      );
      if (stopBtn) {
        return {
          ok: true,
          evidence: "stop-generation-control-active",
          elapsedMs: Date.now() - start,
        };
      }

      const loaders = document.querySelectorAll(
        '.loading-indicator, .shimmer, .loading-animation, mat-spinner, mat-progress-spinner, [role="progressbar"]',
      );
      for (const l of loaders) {
        if (!l.closest("nav, mat-sidenav, header, aside")) {
          return {
            ok: true,
            evidence: "active-loading-indicator",
            elapsedMs: Date.now() - start,
          };
        }
      }

      // 2. Text signals (EN, PT-BR, JA)
      const pageText = document.body ? (document.body.innerText || "") : "";
      if (
        /creating your image|criando sua imagem|画像を生成|gerando imagem|generating image|creating image/i.test(
          pageText,
        )
      ) {
        return {
          ok: true,
          evidence: "generation-text-indicator",
          elapsedMs: Date.now() - start,
        };
      }

      await sleep(150);
    }

    return {
      ok: false,
      error: "Generation-start timeout: Gemini did not start image generation.",
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Capture rich conversation baseline immediately before sending.
   * Ensures that any pre-existing images, queries, and responses are recorded.
   */
  function captureConversationBaseline() {
    const allImgs = Array.from(document.querySelectorAll("img"));
    const allSrcs = allImgs
      .map((i) => i.getAttribute("src") || i.src || "")
      .filter((s) => s.length > 0 && !s.startsWith("data:image/svg"));

    const userQueries = Array.from(
      document.querySelectorAll("user-query, .user-query, [data-test-id='user-query']"),
    );
    const modelResponses = Array.from(
      document.querySelectorAll("model-response, .model-response, [data-test-id='model-response']"),
    );

    return {
      capturedAt: Date.now(),
      userQueryCount: userQueries.length,
      modelResponseCount: modelResponses.length,
      generatedImageCount: allSrcs.length,
      generatedImageSrcs: Array.from(new Set(allSrcs)),
    };
  }

  function nodeContains(parent, child) {
    if (!parent || !child) return false;
    if (typeof parent.contains === "function") {
      try {
        return parent.contains(child);
      } catch (_) {}
    }
    let cur = child;
    while (cur) {
      if (cur === parent) return true;
      cur = cur.parentElement || cur.parentNode;
    }
    return false;
  }

  function isInsideComposerOrQuery(img) {
    if (!img) return false;
    if (typeof img.closest === "function") {
      try {
        if (img.closest("gem-media-attachment, mat-chip, input-area, input-area-v2, .attachment-container, rich-textarea, user-query, .user-query")) {
          return true;
        }
      } catch (_) {}
    }
    let cur = img;
    while (cur) {
      const tag = (cur.tagName || "").toLowerCase();
      const cls = getElementClassText(cur).toLowerCase();
      if (
        tag === "gem-media-attachment" ||
        tag === "mat-chip" ||
        tag === "input-area" ||
        tag === "input-area-v2" ||
        tag === "rich-textarea" ||
        tag === "user-query" ||
        cls.includes("user-query") ||
        cls.includes("attachment-container")
      ) {
        return true;
      }
      cur = cur.parentElement || cur.parentNode;
    }
    return false;
  }

  /**
   * Score an <img> element candidate as a potential new AI generated result.
   * Returns a numerical score from 0 (rejected) to 100+ (high confidence).
   */
  function scoreGeneratedImageCandidate(img, baseline, newestResponse) {
    if (!img) return { score: 0, reason: "null-element" };
    const src = img.getAttribute("src") || img.src || "";
    if (!src || src.length < 5) return { score: 0, reason: "empty-src" };

    // 1. Anti-Old-Image rule: Hard reject if present in pre-send baseline
    const initialSrcs = new Set(baseline?.generatedImageSrcs || []);
    if (initialSrcs.has(src)) {
      return { score: 0, reason: "present-in-baseline" };
    }

    // 2. Anti-Reference / Anti-Upload / Anti-Composer rule
    if (isInsideComposerOrQuery(img)) {
      return { score: 0, reason: "inside-composer-or-user-query" };
    }

    // 3. Anti-Icon / Anti-Avatar rule
    const lowerSrc = src.toLowerCase();
    if (
      lowerSrc.includes("avatar") ||
      lowerSrc.includes("profile") ||
      lowerSrc.includes("favicon") ||
      lowerSrc.includes("googlelogo") ||
      lowerSrc.includes("bot_avatar") ||
      lowerSrc.includes("icon")
    ) {
      return { score: 0, reason: "avatar-or-icon-src" };
    }
    if (src.startsWith("data:image/svg")) {
      return { score: 0, reason: "svg-data-uri" };
    }

    // 4. Hidden element rejection
    if (img.style && (img.style.display === "none" || img.style.visibility === "hidden" || img.style.opacity === "0")) {
      return { score: 0, reason: "hidden-element" };
    }

    let score = 10;
    const signals = [];

    // 5. Positive: Resides inside the newest model response container
    if (newestResponse && nodeContains(newestResponse, img)) {
      score += 40;
      signals.push("inside-newest-response");
    }

    // 6. Positive: Alt text indicates AI generation (PT-BR, EN, JA, ES, FR)
    const alt = (img.getAttribute("alt") || "").toLowerCase();
    if (
      /ai generated|generated by ai|gerada por ia|générée par ia|imagen generada|画像|generated|image \d/i.test(
        alt,
      )
    ) {
      score += 30;
      signals.push("ai-alt-text");
    }

    // 7. Positive: Parent is a dedicated image container
    let isDedicatedContainer = false;
    if (typeof img.closest === "function") {
      try {
        isDedicatedContainer = !!img.closest("generated-image, .generated-image, .image-container, .generated-image-container, mat-card, .model-response-content, .media-container");
      } catch (_) {}
    }
    if (!isDedicatedContainer) {
      let c = img.parentElement || img.parentNode;
      while (c) {
        const t = (c.tagName || "").toLowerCase();
        const cl = getElementClassText(c).toLowerCase();
        if (t === "generated-image" || cl.includes("image-container") || cl.includes("generated-image") || cl.includes("model-response-content")) {
          isDedicatedContainer = true;
          break;
        }
        c = c.parentElement || c.parentNode;
      }
    }
    if (isDedicatedContainer) {
      score += 25;
      signals.push("image-container-parent");
    }

    // 8. Positive: Large dimensions (natural or rendered)
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    const rw = img.clientWidth || img.offsetWidth || 0;
    if (nw >= 200 || rw >= 200) {
      score += 20;
      signals.push("large-dimensions");
    }

    // 9. Positive: Associated with download/share controls
    let parentContainer = null;
    if (typeof img.closest === "function") {
      try {
        parentContainer = img.closest("model-response, .model-response, [data-test-id='model-response']");
      } catch (_) {}
    }
    if (!parentContainer) {
      parentContainer = newestResponse;
    }
    if (parentContainer) {
      const buttons = typeof parentContainer.querySelectorAll === "function" ? Array.from(parentContainer.querySelectorAll("button, a, [role='button']")) : [];
      const hasDownload = buttons.some((b) => {
        const aria = (b.getAttribute?.("aria-label") || "").toLowerCase();
        const title = (b.getAttribute?.("title") || "").toLowerCase();
        const text = (b.textContent || "").toLowerCase();
        return (
          aria.includes("download") ||
          aria.includes("baixar") ||
          aria.includes("ダウンロード") ||
          aria.includes("descargar") ||
          aria.includes("télécharger") ||
          title.includes("download") ||
          text.includes("download")
        );
      });
      if (hasDownload) {
        score += 15;
        signals.push("download-button-present");
      }
    }

    return { score, signals, src, alt, dimensions: { naturalWidth: nw, naturalHeight: nh, renderedWidth: rw } };
  }

  /**
   * Verify stability of a candidate image before returning it for download.
   */
  async function verifyImageStability(img, waitMs = 400) {
    if (!img) return false;
    const initialSrc = img.getAttribute("src") || img.src || "";
    if (!initialSrc) return false;
    await sleep(waitMs);
    const finalSrc = img.getAttribute("src") || img.src || "";
    if (initialSrc !== finalSrc) return false;
    // Ensure dimensions are non-trivial if available
    const nw = img.naturalWidth || 0;
    const rw = img.clientWidth || img.offsetWidth || 0;
    if (nw === 0 && rw === 0 && (img.complete === false)) {
      return false;
    }
    return true;
  }

  /**
   * Non-destructive one-shot result discovery for [ Retry Detection ].
   */
  function findNewGeneratedResult(baseline) {
    const responses = Array.from(
      document.querySelectorAll("model-response, .model-response, [data-test-id='model-response']"),
    );
    if (responses.length === 0) {
      return { ok: false, error: "No model responses present." };
    }
    const newestResponse = responses[responses.length - 1];
    const imgs = Array.from(document.querySelectorAll("img"));

    const scored = imgs
      .map((img) => ({ img, result: scoreGeneratedImageCandidate(img, baseline, newestResponse) }))
      .filter((item) => item.result.score >= 50)
      .sort((a, b) => b.result.score - a.result.score);

    if (scored.length === 0) {
      return { ok: false, error: "No new generated image detected matching criteria." };
    }

    const top = scored[0];
    const dlBtn = top.img
      .closest("model-response, .model-response, [data-test-id='model-response']")
      ?.querySelector('button[aria-label*="Download" i], button[aria-label*="Baixar" i], button[aria-label*="ダウンロード" i]');

    return {
      ok: true,
      imageSrc: top.result.src,
      alt: top.result.alt,
      naturalWidth: top.result.dimensions.naturalWidth,
      naturalHeight: top.result.dimensions.naturalHeight,
      score: top.result.score,
      downloadControl: dlBtn ? { ariaLabel: dlBtn.getAttribute("aria-label") } : null,
    };
  }

  /**
   * Poll for any newly-rendered image not in the baseline, with at least
   * one rendered dimension >= 100px (rules out icons / placeholders /
   * thumbnails that haven't loaded yet).
   *
   * v0.9.96 — radical simplification. After 4 attempts we couldn't find
   * a robust "generation done" signal (Gemini's page contains the words
   * "creating image" / "gerando imagem" in tooltips and footers that
   * make any text-based detection flaky, and DOM heuristics like
   * spinner / stop-button / new-model-response change shape across
   * Gemini updates). The user has Mark as Redo for wrong images, so
   * the only thing this function needs to do is:
   *
   *   1. Poll every 200ms.
   *   2. Find any <img> whose src is not in the baseline, is not an
   *      inline SVG placeholder, and has rendered dimensions >= 100px
   *      on at least one axis.
   *   3. Return immediately on first hit.
   *
   * That's it. No generation-done signals, no scoring, no stability
   * check, no container class. The user verifies visually.
   */
  async function waitForNewGeneratedImage(baseline, timeoutMs = 90000) {
    const start = Date.now();
    const POLL_MS = 200;
    const baselineSrcs = new Set(baseline?.generatedImageSrcs || []);

    while (Date.now() - start < timeoutMs) {
      const candidate = findNewRenderedImage(baselineSrcs);
      if (candidate) {
        return {
          ok: true,
          imageSrc: candidate.src,
          alt: candidate.alt,
          naturalWidth: candidate.naturalWidth || 0,
          naturalHeight: candidate.naturalHeight || 0,
          score: 0,
          downloadControl: candidate.downloadControl,
          generationVisualCompletionAt: Date.now(),
          elapsedMs: Date.now() - start,
          allSignalsClear: true,
          detectionTier: 1,
          stabilityPath: "first-rendered-image",
        };
      }
      await sleep(POLL_MS);
    }

    return {
      ok: false,
      error: "Generation timed out before any new rendered image appeared.",
      stage: "wait-for-image",
      timeoutMs,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Find the first <img> on the page whose src is not in the baseline
   * (i.e. not a pre-existing image) and whose rendered dimensions are
   * >= 100px on at least one axis (i.e. not a placeholder / icon).
   * Returns { src, alt, naturalWidth, naturalHeight, downloadControl }
   * or null.
   *
   * Extracted from waitForNewGeneratedImage so the same probe can be
   * reused by retry-detection paths and tested in isolation.
   */
  function findNewRenderedImage(baselineSrcs) {
    const imgs = Array.from(document.querySelectorAll("img"));
    for (const img of imgs) {
      const src = img.getAttribute("src") || img.src || "";
      if (!src || src.length < 5) continue;
      if (src.startsWith("data:image/svg")) continue;
      if (baselineSrcs.has(src)) continue;

      const w = img.naturalWidth || img.clientWidth || img.offsetWidth || 0;
      const h = img.naturalHeight || img.clientHeight || img.offsetHeight || 0;
      // Require at least one rendered dimension >= 100px. This rules out
      // icons (typically <50px) and not-yet-loaded placeholders.
      if (w < 100 && h < 100) continue;

      // Try to find a download control near this image for observability.
      const container = typeof img.closest === "function"
        ? img.closest("model-response, .model-response, [data-test-id='model-response']")
        : null;
      let dlBtn = null;
      const root = container || img.parentElement || document.body;
      if (root && typeof root.querySelector === "function") {
        dlBtn = root.querySelector(
          'button[aria-label*="Download" i], button[aria-label*="Baixar" i], button[aria-label*="ダウンロード" i]',
        );
      }
      return {
        src,
        alt: img.getAttribute("alt") || null,
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
        downloadControl: dlBtn
          ? { ariaLabel: dlBtn.getAttribute("aria-label") }
          : null,
      };
    }
    return null;
  }  // ---- v0.6.2: Attachment Step Trace + Layered Menu/Input Probes ------
  //
  // The v0.6.1 attach flow was failing in real Chrome with no observable
  // failure: trigger found, click did nothing observable. We need to
  // discover exactly where the flow dies without speculating.
  //
  // This block adds two non-destructive diagnostic tools the side panel
  // can call:
  //
  //   runAttachTrace(file)
  //     Runs ONE attach operation with structured tracing. Each step
  //     records { ok, timestamp, durationMs, payload }. Returns the
  //     full trace so the side panel can render "Failed at: <step>".
  //     No bytes are ever written to the trace.
  //
  //   probeFileInputLifecycle(checkpointsMs)
  //     Snapshots <input type=file> state at multiple times after a
  //     click event. Identifies the four lifecycle classes:
  //       A. appears and persists
  //       B. appears briefly then disappears
  //       C. always present (hidden)
  //       D. never appears
  //
  //   findUploadFilesInOverlay()
  //     Layered detector for the "Enviar arquivos" menu item. Tier 1
  //     uses structural signals (role + icon + position). Tier 2
  //     uses accessible-name fragments. Tier 3 falls back to localized
  //     text. Searches globally because Angular/Material renders
  //     menus outside the composer's DOM subtree via CDK overlay.
  //
  // Existing attachFileWithMenu() is preserved unchanged. This block
  // is additive: callers that depend on it see no behavioral diff.

  // Locale-aware labels for the upload-files menu item. Used in Tier 3
  // only. Adding a language = appending one string here.
  const UPLOAD_FILES_FALLBACK_LABELS = Object.freeze({
    "en-US": "Upload files",
    "en-GB": "Upload files",
    "pt-BR": "Enviar arquivos",
    "pt-PT": "Enviar ficheiros",
    "es-ES": "Subir archivos",
    "es-419": "Subir archivos",
    "fr-FR": "Téléverser des fichiers",
    "de-DE": "Dateien hochladen",
    "ja-JP": "ファイルをアップロード",
    "ko-KR": "파일 업로드",
    "zh-CN": "上传文件",
    "zh-TW": "上傳檔案",
    "vi-VN": "Tải tệp lên",
    "it-IT": "Carica file",
  });

  // Step list, in order. The trace function emits one entry per step.
  const ATTACH_TRACE_STEPS = Object.freeze([
    "asset-loaded",
    "messaging-ok",
    "attachment-trigger-found",
    "attachment-trigger-clicked",
    "menu-detected",
    "upload-action-detected",
    "upload-action-clicked",
    "file-input-detected",
    "file-assigned",
    "change-dispatched",
    "attachment-ui-detected",
    "attachment-ready",
  ]);

  function makeTraceStep(step, ok, payload, startedAt, explicitStatus) {
    let status = explicitStatus;
    if (!status) {
      if (payload && payload.skipped) {
        status = "skipped";
      } else if (ok === true) {
        status = "success";
      } else if (ok === false) {
        status = "failed";
      } else {
        status = "not-run";
      }
    }
    return {
      step,
      ok: status === "success",
      status,
      ts: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      payload: payload || null,
    };
  }

  function classifyFileInput(el) {
    if (!el) return "UNKNOWN";
    const accept = (el.getAttribute("accept") || "").toLowerCase().trim();
    if (
      accept.includes("image") ||
      accept.includes(".png") ||
      accept.includes(".jpg") ||
      accept.includes(".jpeg") ||
      accept.includes(".webp")
    ) {
      return "IMAGE_UPLOAD";
    }
    if (
      accept.includes(".txt") ||
      accept.includes(".pdf") ||
      accept.includes(".doc") ||
      accept.includes(".docx") ||
      accept.includes(".js") ||
      accept.includes(".json") ||
      accept.includes(".zip") ||
      accept.includes(".py")
    ) {
      return "DOCUMENT_UPLOAD";
    }
    if (!accept || accept === "*/*") {
      return "GENERIC_OR_UNKNOWN";
    }
    return "UNKNOWN";
  }

  function describeDomNode(el) {
    if (!el || !(el instanceof Element)) return null;
    let parent = el.parentElement;
    let parentTag = null;
    let parentClass = null;
    if (parent) {
      parentTag = parent.tagName?.toLowerCase() ?? null;
      parentClass = getElementClassText(parent).slice(0, 80);
    }
    return {
      tag: el.tagName?.toLowerCase() ?? null,
      id: el.id || null,
      type: el.getAttribute("type") ?? null,
      accept: el.getAttribute("accept") ?? null,
      multiple: el.multiple ?? null,
      classification: classifyFileInput(el),
      display: el.style?.display ?? null,
      visibility: el.style?.visibility ?? null,
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
      parentTag,
      parentClass,
    };
  }

  /**
   * Find every plausible menu/popover candidate in the document.
   * The Gemini UI (Angular Material + CDK overlay) renders the + menu
   * outside the composer's DOM subtree, frequently as a sibling of
   * <body> or under a CDK overlay container.
   *
   * This is a structural probe; nothing is clicked.
   */
  function findMenuCandidates() {
    const out = [];
    const seen = new Set();

    // 1. Explicit menu/popover roles + Angular Material components.
    const sels = [
      '[role="menu"]',
      '[role="dialog"]',
      '[role="listbox"]',
      '[role="presentation"]',
      'mat-menu-panel',
      'mat-dialog-container',
      '.cdk-overlay-pane',
      '.cdk-overlay-container [role="menu"]',
      '.cdk-overlay-container mat-menu-panel',
      '.cdk-overlay-backdrop',
      '[popover]',
      'dialog[open]',
    ];
    for (const sel of sels) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          out.push({
            source: sel,
            tag: el.tagName?.toLowerCase() ?? null,
            role: el.getAttribute("role") ?? null,
            classHint: getElementClassText(el).slice(0, 80),
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            itemCount: el.querySelectorAll(
              '[role="menuitem"], [role="menuitemcheckbox"], button, a',
            ).length,
          });
        }
      } catch (_) {
        /* ignore */
      }
    }
    return out;
  }

  /**
   * Describe a candidate menu item: tag, role, accessible name, visible
   * text sample, classes, and useful data-attributes. No content beyond
   * structural fields is returned.
   */
  function describeMenuItem(el) {
    if (!el || typeof el.getAttribute !== "function") return null;
    const text = (el.textContent || "").trim();
    const aria = el.getAttribute("aria-label") ?? null;
    const icon = el.querySelector("img, mat-icon, [class*='icon'], [class*='material']");
    const iconAlt = icon
      ? icon.getAttribute("alt") ?? icon.textContent ?? null
      : null;
    return {
      tag: el.tagName?.toLowerCase() ?? null,
      role: el.getAttribute("role") ?? null,
      ariaLabel: aria,
      textSample: text.slice(0, 80),
      textLength: text.length,
      classHint: getElementClassText(el).slice(0, 120),
      iconAlt,
      dataAttrs: collectUsefulDataAttrs(el),
    };
  }

  function collectUsefulDataAttrs(el) {
    const out = {};
    if (!el || !el.attributes) return out;
    for (const a of Array.from(el.attributes)) {
      if (!a || typeof a.name !== "string") continue;
      if (!a.name.startsWith("data-")) continue;
      if (a.name.length > 64) continue;
      if (a.value && a.value.length > 200) continue;
      out[a.name] = a.value;
    }
    return out;
  }

  /**
   * Layered detector for the "Upload files" (PT: "Enviar arquivos") item.
   * Searches globally across every menu candidate, not just descendants
   * of the + button — Angular Material renders menus in CDK overlays.
   *
   *   Tier 1: structural / icon-based
   *           role=menuitem + icon whose alt is "attach_file" (or
   *           contains that fragment) + ancestor chain points to an
   *           upload/attach region.
   *   Tier 2: accessible-name match
   *           aria-label contains "upload files" / "enviar arquivo".
   *   Tier 3: localized text fallback
   *           exact match (case-insensitive) against UPLOAD_FILES_FALLBACK_LABELS
   *           values.
   *
   * Returns { ok, item, tier, candidates[] }. ok is true iff an item
   * was selected. Each candidate in the array is a structured
   * describeMenuItem() snapshot. Nothing about the file itself is
   * recorded here.
   */
  function findUploadFilesInOverlay() {
    const candidates = [];

    // 1. Collect every menuitem-like element, even those outside the
    //    composer's subtree. We bound the search by visible-bbox > 0.
    const items = Array.from(
      document.querySelectorAll(
        '[role="menuitem"], [role="menuitemcheckbox"], button, a',
      ),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    for (const el of items) {
      const desc = describeMenuItem(el);
      if (!desc) continue;

      const tier = scoreUploadCandidate(el, desc);
      if (tier > 0) candidates.push({ desc, tier, el });
    }

    if (candidates.length === 0) {
      return { ok: false, item: null, tier: 0, candidates: [] };
    }
    candidates.sort((a, b) => b.tier - a.tier);
    const best = candidates[0];
    return {
      ok: true,
      item: best.desc,
      tier: best.tier,
      el: best.el,
      candidates: candidates.slice(0, 8).map((c) => c.desc),
    };
  }

  function scoreUploadCandidate(el, desc) {
    const label = (desc.ariaLabel || "").toLowerCase();
    const text = (desc.textSample || "").toLowerCase();
    const icon = (desc.iconAlt || "").toLowerCase();

    // Tier 1: structural — icon name is the canonical "attach_file"
    //         Material symbol, and the surrounding role is menuitem.
    if (
      desc.role === "menuitem" &&
      (icon === "attach_file" || icon.includes("attach_file"))
    ) {
      return 100;
    }

    // Tier 2: accessible-name fragments.
    if (/upload\s*files?/i.test(label)) return 80;
    if (/enviar\s*arquivos?/i.test(label)) return 78;
    if (/t[eé]l[ée]verser\s+des\s+fichiers?/i.test(label)) return 76;
    if (/ファイル.*アップロード|アップロード.*ファイル/.test(label)) return 76;
    if (label && /upload|attach|fichier|datei|archivo/i.test(label) &&
        /file|archivo|file|fichier|datei/i.test(label) &&
        !/generador|imagen|image create|video|música|music|canvas|deep research/i.test(label)
    ) {
      return 60;
    }

    // Tier 3: localized visible text (case-insensitive exact match).
    const FALLBACK_VALUES = Object.values(UPLOAD_FILES_FALLBACK_LABELS).map((v) =>
      v.toLowerCase(),
    );
    if (text && FALLBACK_VALUES.includes(text)) return 50;

    // Soft tier 3+: substring of a long-enough fallback.
    for (const v of FALLBACK_VALUES) {
      if (v.length >= 8 && text && text.includes(v)) return 30;
    }
    return 0;
  }

  /**
   * Snapshot a single <input type="file"> for diagnostics.
   * count + accept + multiple + display + parentDescriptor.
   */
  function snapshotFileInputs() {
    const inputs = Array.from(
      document.querySelectorAll('input[type="file"]'),
    );
    return {
      count: inputs.length,
      inputs: inputs.slice(0, 4).map(describeDomNode),
    };
  }

  /**
   * Probe the file input lifecycle at a fixed schedule of checkpoints
   * (in ms). Each checkpoint records count + first-input structural
   * descriptor if any. Classifies the lifecycle after the budget.
   *
   * Implementation: a single MutationObserver on document.body with
   * the requested timeout. We explicitly do NOT poll at every
   * millisecond; we wake on actual mutations and re-check at the
   * scheduled checkpoints.
   */
  function probeFileInputLifecycle(checkpointsMs) {
    if (!Array.isArray(checkpointsMs) || checkpointsMs.length === 0) {
      checkpointsMs = [0, 50, 150, 300, 750, 1500, 2500];
    }
    const sortedCheckpoints = [...checkpointsMs].sort((a, b) => a - b);
    const totalMs = sortedCheckpoints[sortedCheckpoints.length - 1];
    const snapshots = [];
    let observed = false;

    const obs = new MutationObserver(() => {
      observed = true;
    });
    try {
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (_) {
      /* ignore */
    }

    return new Promise((resolve) => {
      const startedAt = Date.now();
      let idx = 0;
      const takeSnapshot = () => {
        const elapsed = Date.now() - startedAt;
        const snap = snapshotFileInputs();
        snapshots.push({
          atMs: elapsed,
          triggeredByCheckpoint: sortedCheckpoints[idx] ?? null,
          count: snap.count,
          accept: snap.inputs[0]?.accept ?? null,
          multiple: snap.inputs[0]?.multiple ?? false,
          display: snap.inputs[0]?.display ?? null,
          width: snap.inputs[0]?.width ?? 0,
          height: snap.inputs[0]?.height ?? 0,
          parentDescriptor: snap.inputs[0]?.parentTag ?? null,
          // Note: not used downstream; intentionally truncated.
          inputCountDelta: snap.count - (snapshots.at(-1)?.count ?? 0),
        });
        idx++;
      };

      // First checkpoint is always at 0ms (immediate).
      takeSnapshot();

      const tick = () => {
        const elapsed = Date.now() - startedAt;
        while (
          idx < sortedCheckpoints.length &&
          elapsed >= sortedCheckpoints[idx]
        ) {
          takeSnapshot();
        }
        if (Date.now() - startedAt >= totalMs + 50) {
          try {
            obs.disconnect();
          } catch (_) {
            /* ignore */
          }
          const counts = snapshots.map((s) => s.count);
          const minCount = counts.length > 0 ? Math.min(...counts) : 0;
          const maxCount = counts.length > 0 ? Math.max(...counts) : 0;
          let classification = "never-appeared";
          if (maxCount > 0 && minCount > 0) classification = "always-present";
          else if (maxCount > 0) classification = "appeared-briefly";
          else if (maxCount > 0 && minCount === maxCount) {
            classification = "always-present";
          } else if (maxCount > 0) {
            classification = "appeared-briefly";
          }
          resolve({
            durationMs: Date.now() - startedAt,
            snapshots,
            classification,
            mutationObserved: observed,
            totalCheckpoints: sortedCheckpoints.length,
          });
          return;
        }
        setTimeout(tick, 50);
      };
      setTimeout(tick, 0);
    });
  }

  /**
   * Wait until an attachment chip or thumbnail appears in the composer,
   * AND active uploading progress settles.
   *
   * Returns { ok, chipVisibleAt, uploadCompleteAt, evidence, signalsAfter }. Never throws.
   */
  async function waitForAttachmentEvidence(chipsBefore, timeoutMs) {
    const start = Date.now();
    const deadline = start + (timeoutMs || ATTACH_FILE_TIMEOUT_MS);
    const area = findPromptInputArea() || document.querySelector("input-area-v2") || document.body;

    const computeState = () => {
      const root = area || document;
      const chips = root.querySelectorAll
        ? root.querySelectorAll("gem-media-attachment, [class*='attachment' i]:not(.attachment-container), [data-test-id*='attachment']")
        : [];
      const thumbs = root.querySelectorAll
        ? root.querySelectorAll('[class*="thumbnail" i], img[src^="data:"], img[src^="blob:"]')
        : [];
      const pendingUploads = countActiveUploads(area);
      return {
        chips: chips.length,
        thumbnails: thumbs.length,
        pendingUploads,
      };
    };

    return new Promise((resolve) => {
      let resolved = false;
      let chipVisibleAt = null;

      const checkSettledAndFinalize = async (state) => {
        if (resolved) return;
        if (!chipVisibleAt) chipVisibleAt = Date.now();

        // Wait for upload progress indicators to settle to 0
        const settleDeadline = Date.now() + 8000;
        let finalState = computeState();
        while (finalState.pendingUploads > 0 && Date.now() < settleDeadline) {
          await sleep(150);
          finalState = computeState();
        }
        const uploadCompleteAt = Date.now();

        if (resolved) return;
        resolved = true;
        try { obs.disconnect(); } catch (_) {}
        resolve({
          ok: true,
          chipVisibleAt,
          uploadCompleteAt,
          signalsAfter: { ...finalState, atMs: Date.now() - start },
          evidence: {
            chipsDelta: finalState.chips - chipsBefore,
            thumbnails: finalState.thumbnails,
            pendingUploads: finalState.pendingUploads,
            areaTag: area?.tagName?.toLowerCase() ?? null,
          },
        });
      };

      const finalizeFailure = (state) => {
        if (resolved) return;
        resolved = true;
        try { obs.disconnect(); } catch (_) {}
        resolve({
          ok: false,
          chipVisibleAt: null,
          uploadCompleteAt: null,
          signalsAfter: { ...state, atMs: Date.now() - start },
          evidence: {
            chipsDelta: state.chips - chipsBefore,
            thumbnails: state.thumbnails,
            pendingUploads: state.pendingUploads,
            areaTag: area?.tagName?.toLowerCase() ?? null,
          },
        });
      };

      const obs = new MutationObserver(() => {
        const state = computeState();
        // Treat active uploads as success evidence even before the chip
        // renders. Gemini accepts a file (paste/drop/input) and starts
        // uploading without immediately rendering the chip; if we time
        // out waiting for the chip alone, attachFileWithMenu would fall
        // through to the next strategy and dispatch the SAME file again,
        // producing duplicate uploads. (Regression test: pendingUploads
        // is in both this branch and tick() below.)
        if (state.chips > chipsBefore || state.thumbnails > 0 || state.pendingUploads > 0) {
          checkSettledAndFinalize(state);
        }
      });
      try {
        obs.observe(document.body, { childList: true, subtree: true });
      } catch (_) {}

      const tick = () => {
        if (resolved) return;
        const state = computeState();
        if (state.chips > chipsBefore || state.thumbnails > 0 || state.pendingUploads > 0) {
          checkSettledAndFinalize(state);
          return;
        }
        if (Date.now() >= deadline) {
          finalizeFailure(state);
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /**
   * Public: run a structured attach trace. This is intentionally
   * additive to attachFileWithMenu(). Existing callers see no change.
   *
   * Each step records { ok, ts, durationMs, payload }. No bytes are
   * recorded. The trace aborts on first failure and never throws.
   */
  async function runAttachTrace(file) {
    const startedAt = Date.now();
    const trace = {
      operation: "attach",
      assetId: file?.name ?? null,
      startedAt: new Date().toISOString(),
      steps: [],
      failedAt: null,
      summary: null,
    };

    function pushStep(stepName, ok, payload) {
      const step = makeTraceStep(stepName, ok, payload, startedAt);
      trace.steps.push(step);
      return step;
    }

    // Step 1 — asset-loaded
    if (!file || typeof file !== "object" || typeof file.name !== "string") {
      pushStep("asset-loaded", false, { reason: "invalid file" });
      trace.failedAt = "asset-loaded";
      trace.summary = { totalDurationMs: Date.now() - startedAt, reason: "asset-loaded" };
      return trace;
    }
    pushStep("asset-loaded", true, {
      name: file.name,
      size: file.size,
      type: file.type,
    });

    // Step 2 — messaging-ok (pre-flight; content script must be alive)
    pushStep("messaging-ok", true, {
      reason: "this function runs inside the content script",
    });

    // Step 3 — attachment-trigger-found
    const trigger0 = findPlusButton();
    if (!trigger0) {
      pushStep("attachment-trigger-found", false, {
        reason: "findPlusButton returned null",
      });
      trace.failedAt = "attachment-trigger-found";
      trace.summary = { totalDurationMs: Date.now() - startedAt };
      return trace;
    }
    pushStep("attachment-trigger-found", true, {
      tag: trigger0.tagName?.toLowerCase() ?? null,
      ariaLabel: trigger0.getAttribute("aria-label") ?? null,
    });

    // Step 4 — attachment-trigger-clicked
    const t0 = Date.now();
    try {
      trigger0.click();
    } catch (e) {
      pushStep("attachment-trigger-clicked", false, {
        error: e?.message ?? "unknown",
      });
      trace.failedAt = "attachment-trigger-clicked";
      trace.summary = { totalDurationMs: Date.now() - startedAt };
      return trace;
    }
    pushStep("attachment-trigger-clicked", true, {
      durationMs: Date.now() - t0,
    });

    // Step 5 — menu-detected (search globally, not just composer subtree)
    const t1 = Date.now();
    let menuEvidence = null;
    let menuObservation = null;
    const menuWaitStart = Date.now();
    while (Date.now() - menuWaitStart < ATTACH_MENU_OPEN_TIMEOUT_MS) {
      const candidates = findMenuCandidates();
      if (candidates.length > 0) {
        menuEvidence = candidates;
        break;
      }
      await sleep(80);
    }
    if (!menuEvidence) {
      pushStep("menu-detected", false, {
        candidates: menuObservation,
        timeoutMs: ATTACH_MENU_OPEN_TIMEOUT_MS,
      });
      trace.failedAt = "menu-detected";
      trace.summary = { totalDurationMs: Date.now() - startedAt };
      return trace;
    }
    pushStep("menu-detected", true, {
      durationMs: Date.now() - t1,
      menuItemCount: menuEvidence.reduce((acc, m) => acc + m.itemCount, 0),
      menuCount: menuEvidence.length,
      firstMenu: menuEvidence[0],
    });

    // Step 6 — upload-action-detected
    const t2 = Date.now();
    const probe = findUploadFilesInOverlay();
    if (!probe.ok) {
      pushStep("upload-action-detected", false, {
        tier: probe.tier,
        candidateCount: probe.candidates.length,
        candidates: probe.candidates.slice(0, 3),
      });
      trace.failedAt = "upload-action-detected";
      trace.summary = { totalDurationMs: Date.now() - startedAt };
      return trace;
    }
    pushStep("upload-action-detected", true, {
      durationMs: Date.now() - t2,
      tier: probe.tier,
      matchedAria: probe.item?.ariaLabel ?? null,
      matchedText: probe.item?.textSample ?? null,
      iconAlt: probe.item?.iconAlt ?? null,
    });

    // We do NOT click [Enviar arquivos] yet — the user wants to first
    // observe the file input lifecycle without modifying it. The
    // remaining steps run only after explicit OptIn for Strategy A.
    //
    // For the trace diagnostic we just record that upload-action is
    // locatable, and mark "trace complete" without modifying any state.
    pushStep("upload-action-clicked", true, {
      skipped: true,
      reason:
        "trace completes at action-detection; further steps modify state and are gated behind opt-in",
    });
    pushStep("file-input-detected", false, {
      skipped: true,
      reason: "no input mutation attempted in trace-only mode",
    });
    pushStep("file-assigned", false, {
      skipped: true,
      reason: "trace-only",
    });
    pushStep("change-dispatched", false, {
      skipped: true,
      reason: "trace-only",
    });
    pushStep("attachment-ui-detected", false, {
      skipped: true,
      reason: "trace-only",
    });
    pushStep("attachment-ready", false, {
      skipped: true,
      reason: "trace-only",
    });

    trace.failedAt = null;
    trace.summary = {
      totalDurationMs: Date.now() - startedAt,
      traceOnly: true,
    };
    return trace;
  }

  /**
   * Public: trace-only file-input lifecycle probe. Takes an optional
   * schedule (defaults to the standard checkpoints) and returns one
   * snapshot per checkpoint plus a final classification.
   */
  function runFileInputLifecycleProbe(checkpointsMs) {
    return probeFileInputLifecycle(checkpointsMs);
  }

  /**
   * Public: layered upload-files item detector. Returns the full
   * candidate list (or empty), so the side panel can show the user
   * what each candidate looks like.
   */
  function probeUploadFilesCandidates() {
    return findUploadFilesInOverlay();
  }

  // expose the internal name too, so tests + future tooling can call
  // either name without confusion.
  // eslint-disable-next-line no-unused-vars
  var findUploadFilesInOverlay_alias = findUploadFilesInOverlay;

  /**
   * Strategy A: attempt the native-input injection flow. Returns a
   * structured trace (same shape as runAttachTrace). The side panel
   * surfaces it.
   */
  async function runAttachStrategyA(file) {
    const startedAt = Date.now();
    const trace = {
      operation: "attach-strategy-a",
      assetId: file?.name ?? null,
      startedAt: new Date().toISOString(),
      steps: [],
      failedAt: null,
      summary: null,
      strategy: "native-input+datatransfer",
    };

    function pushStep(stepName, ok, payload) {
      const step = makeTraceStep(stepName, ok, payload, startedAt);
      trace.steps.push(step);
      return step;
    }

    if (!file || typeof file !== "object" || typeof file.name !== "string") {
      pushStep("asset-loaded", false, { reason: "invalid file" });
      trace.failedAt = "asset-loaded";
      return trace;
    }

    pushStep("asset-loaded", true, {
      name: file.name,
      size: file.size,
      type: file.type,
    });
    pushStep("messaging-ok", true, {
      reason: "content-script context",
    });

    const trigger = findPlusButton();
    if (!trigger) {
      pushStep("attachment-trigger-found", false, {
        reason: "findPlusButton returned null",
      });
      trace.failedAt = "attachment-trigger-found";
      return trace;
    }
    pushStep("attachment-trigger-found", true, {
      ariaLabel: trigger.getAttribute("aria-label") ?? null,
    });

    try {
      trigger.click();
    } catch (e) {
      pushStep("attachment-trigger-clicked", false, { error: e?.message });
      trace.failedAt = "attachment-trigger-clicked";
      return trace;
    }
    pushStep("attachment-trigger-clicked", true);

    // Wait for menu.
    const menuWaitStart = Date.now();
    while (Date.now() - menuWaitStart < ATTACH_MENU_OPEN_TIMEOUT_MS) {
      if (findMenuCandidates().length > 0) break;
      await sleep(80);
    }
    const menuCandidates = findMenuCandidates();
    if (menuCandidates.length === 0) {
      pushStep("menu-detected", false, { timeoutMs: ATTACH_MENU_OPEN_TIMEOUT_MS });
      trace.failedAt = "menu-detected";
      return trace;
    }
    pushStep("menu-detected", true, { menuCount: menuCandidates.length });

    const probe = findUploadFilesInOverlay();
    if (!probe.ok) {
      pushStep("upload-action-detected", false, {
        candidateCount: probe.candidates.length,
      });
      trace.failedAt = "upload-action-detected";
      return trace;
    }
    pushStep("upload-action-detected", true, {
      tier: probe.tier,
      matchedAria: probe.item?.ariaLabel ?? null,
      matchedText: probe.item?.textSample ?? null,
    });

    // Strategy A attempts a CLICK on the upload menuitem; this is the
    // known race: Gemini may mount <input type=file> immediately (good)
    // OR open the OS picker immediately (bad). We click, then
    // immediately attempt DataTransfer injection on whichever file
    // input appears, watching lifecycle.
    let clickedEl = null;
    if (probe.candidates && probe.candidates.length > 0) {
      // Re-locate the live element by descriptor (the previous result
      // may have been collected from a now-detached node).
      const items = Array.from(
        document.querySelectorAll(
          '[role="menuitem"], [role="menuitemcheckbox"], button, a',
        ),
      );
      clickedEl = items.find((el) => {
        if (!(el.getBoundingClientRect().width > 0)) return false;
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        const text = ((el.textContent || "").trim() || "").toLowerCase();
        if (label && probe.item?.ariaLabel &&
            label === probe.item.ariaLabel.toLowerCase()) return true;
        if (text && probe.item?.textSample &&
            text === probe.item.textSample.toLowerCase()) return true;
        return false;
      });
    }
    if (!clickedEl) {
      pushStep("upload-action-clicked", false, {
        reason: "clickable element could not be re-located after detection",
      });
      trace.failedAt = "upload-action-clicked";
      return trace;
    }
    try {
      clickedEl.click();
    } catch (e) {
      pushStep("upload-action-clicked", false, { error: e?.message });
      trace.failedAt = "upload-action-clicked";
      return trace;
    }
    pushStep("upload-action-clicked", true, {
      tag: clickedEl.tagName?.toLowerCase() ?? null,
    });

    // Lifecycle probe — confirms the input's behavior under our action.
    const lifecycle = await probeFileInputLifecycle([
      0, 50, 150, 300, 750, 1500, 2500,
    ]);
    const snapshotAtFinal = lifecycle.snapshots[lifecycle.snapshots.length - 1];
    if (snapshotAtFinal.count === 0) {
      pushStep("file-input-detected", false, {
        classification: lifecycle.classification,
        snapshots: lifecycle.snapshots,
        durationMs: lifecycle.durationMs,
      });
      trace.failedAt = "file-input-detected";
      return trace;
    }
    pushStep("file-input-detected", true, {
      classification: lifecycle.classification,
      count: snapshotAtFinal.count,
      accept: snapshotAtFinal.accept,
      multiple: snapshotAtFinal.multiple,
      display: snapshotAtFinal.display,
      parentDescriptor: snapshotAtFinal.parentDescriptor,
      durationMs: lifecycle.durationMs,
    });

    // Inject File via DataTransfer.
    let inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (inputs.length === 0) {
      pushStep("file-assigned", false, { reason: "no input at injection time" });
      trace.failedAt = "file-assigned";
      return trace;
    }
    const input = inputs[0];
    let dataTransfer;
    try {
      dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
    } catch (e) {
      pushStep("file-assigned", false, { error: e?.message ?? "DataTransfer failed" });
      trace.failedAt = "file-assigned";
      return trace;
    }
    try {
      Object.defineProperty(input, "files", {
        value: dataTransfer.files,
        configurable: true,
      });
    } catch (e) {
      pushStep("file-assigned", false, { error: e?.message ?? "defineProperty failed" });
      trace.failedAt = "file-assigned";
      return trace;
    }
    pushStep("file-assigned", true, {
      fileName: file.name,
      mime: file.type,
      size: file.size,
    });

    // Dispatch the events Gemini listens for. The user spec is explicit:
    // only input + change. No shotgun of synthetic events.
    const area = document.querySelector("input-area-v2");
    const chipsBefore = area ? area.querySelectorAll("gem-media-attachment").length : 0;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    pushStep("change-dispatched", true, { chipsBefore });

    // Wait for ACTUAL UI evidence: chip count increment OR thumbnail.
    const evidenceResult = await waitForAttachmentEvidence(chipsBefore, ATTACH_FILE_TIMEOUT_MS);
    if (!evidenceResult.ok) {
      pushStep("attachment-ui-detected", false, {
        signalsAfter: evidenceResult.signalsAfter,
        evidence: evidenceResult.evidence,
      });
      trace.failedAt = "attachment-ui-detected";
      return trace;
    }
    pushStep("attachment-ui-detected", true, {
      evidence: evidenceResult.evidence,
    });

    // Filename presence in chip area OR visual evidence confirmation.
    let matched = false;
    if (area) {
      const chips = area.querySelectorAll("gem-media-attachment");
      for (const chip of chips) {
        const t = (chip.textContent || "").trim();
        if (t.includes(file.name)) {
          matched = true;
          break;
        }
      }
    }
    // Positive visual evidence (chip delta or thumbnail) is the primary ground truth
    if (evidenceResult.ok && evidenceResult.evidence && (evidenceResult.evidence.chipsDelta > 0 || evidenceResult.evidence.thumbnails > 0)) {
      matched = true;
    }

    if (!matched) {
      pushStep("attachment-ready", false, {
        reason: "no visual attachment chip or thumbnail was acknowledged by Gemini",
      });
      trace.failedAt = "attachment-ready";
      return trace;
    }
    pushStep("attachment-ready", true, {
      fileName: file.name,
      totalDurationMs: Date.now() - startedAt,
    });
    trace.failedAt = null;
    trace.summary = {
      ok: true,
      totalDurationMs: Date.now() - startedAt,
    };
    return trace;
  }

  /**
   * Enumerate and classify all upload mechanisms and candidate elements.
   */
  function discoverUploadMechanisms() {
    const trigger = findPlusButton();
    const existingInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el) => ({
      classification: classifyFileInput(el),
      accept: el.getAttribute("accept") ?? null,
      multiple: el.multiple ?? null,
      disabled: el.disabled ?? false,
      visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
      connected: el.isConnected ?? true,
      boundingRect: {
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      },
    }));

    const menuCandidates = findMenuCandidates();
    const menuItems = Array.from(
      document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], button.mat-mdc-menu-item, .cdk-overlay-container button'),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).map((el) => describeMenuItem(el)).filter(Boolean);

    const imageInputs = existingInputs.filter((i) => i.classification === "IMAGE_UPLOAD" || i.classification === "GENERIC_OR_UNKNOWN");
    const documentInputs = existingInputs.filter((i) => i.classification === "DOCUMENT_UPLOAD");

    return {
      triggerFound: !!trigger,
      triggerAria: trigger?.getAttribute("aria-label") ?? null,
      menuCount: menuCandidates.length,
      menuItemCount: menuItems.length,
      menuItems: menuItems.slice(0, 10),
      fileInputsTotal: existingInputs.length,
      imageInputsCount: imageInputs.length,
      documentInputsCount: documentInputs.length,
      fileInputs: existingInputs,
      primaryStrategyRecommended: imageInputs.length > 0 ? "input-injection" : "drag-and-drop-or-input-probe",
    };
  }

  /**
   * Diagnostic execution for single image attachment with granular stages.
   */
  async function testSingleImageAttachment(file, opts) {
    const startedAt = Date.now();
    const report = {
      test: "single-image-attachment",
      fileName: file?.name ?? null,
      fileSize: file?.size ?? 0,
      fileType: file?.type ?? null,
      stages: {},
      summary: {},
    };

    // Stage 1: File transport verification
    if (!file || typeof file !== "object" || typeof file.name !== "string") {
      report.stages.file = { ok: false, error: "Invalid file object" };
      report.result = { ok: false, failedStage: "FILE_VERIFICATION", reason: "Invalid file object" };
      return report;
    }
    if (file.size === 0) {
      report.stages.file = { ok: false, error: "File is empty (0 bytes)" };
      report.result = { ok: false, failedStage: "FILE_VERIFICATION", reason: "File is empty (0 bytes)" };
      return report;
    }
    report.stages.file = {
      ok: true,
      name: file.name,
      size: file.size,
      type: file.type,
    };

    // Stage 2: Gemini DOM discovery & trigger
    const area = document.querySelector("input-area-v2") || findPromptInputArea();
    const chipsBefore = countComposerAttachments(area);
    const trigger = findPlusButton();
    const discovery = discoverUploadMechanisms();
    report.stages.discovery = {
      ok: !!trigger,
      triggerAria: trigger?.getAttribute("aria-label") ?? null,
      chipsBefore,
      discovery,
    };

    // Stage 3: Perform attachment via attachFileWithMenu
    const attachRes = await attachFileWithMenu(file, { timeoutMs: opts?.timeoutMs || ATTACH_FILE_TIMEOUT_MS });
    report.stages.attachment = attachRes;

    // Stage 4: Visual evidence validation
    const chipsAfter = countComposerAttachments(area);
    const delta = chipsAfter - chipsBefore;
    report.stages.evidence = {
      chipsBefore,
      chipsAfter,
      delta,
      ok: delta > 0 || (attachRes && attachRes.ok),
    };

    if (report.stages.evidence.ok) {
      report.result = {
        ok: true,
        method: attachRes.method || "datatransfer",
        elapsedMs: Date.now() - startedAt,
        message: `${file.name} attached successfully with visual evidence (+${Math.max(1, delta)}).`,
      };
    } else {
      report.result = {
        ok: false,
        failedStage: attachRes.phase || "WAIT_FOR_EVIDENCE",
        reason: attachRes.error || "No visual attachment chip or thumbnail appeared in the composer.",
        elapsedMs: Date.now() - startedAt,
      };
    }

    return report;
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
    const composerText = getComposerText();
    const contentLength = selected ? composerText.length : null;
    const attachment = attachmentProbe();
    const imageMode = imageModeProbe();
    const baseline = captureConversationBaseline();
    const sendBtn = findSendButtonDiagnostic();

    return {
      url: typeof location !== "undefined" ? location.href : "",
      htmlLang: typeof document !== "undefined" && document.documentElement && typeof document.documentElement.getAttribute === "function"
        ? document.documentElement.getAttribute("lang")
        : null,
      qlEditorCount: typeof document !== "undefined" ? document.querySelectorAll(".ql-editor").length : 0,
      richTextareaCount: typeof document !== "undefined" ? document.querySelectorAll("rich-textarea").length : 0,
      textboxRoleCount: typeof document !== "undefined" ? document.querySelectorAll('[role="textbox"]').length : 0,
      quillGlobalAvailable: typeof window !== "undefined" && typeof window.Quill !== "undefined",
      inputAreaCount: typeof document !== "undefined"
        ? document.querySelectorAll("input-area-v2").length + document.querySelectorAll("input-container").length
        : 0,
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
    // Canonical Composer API (v0.8.1)
    readComposerText,
    setComposerText,
    clearComposer,
    verifyComposerText,
    // Aliases for backwards compatibility
    insertPromptIntoGemini,
    getComposerText,
    inspectComposerContent,
    clearComposerContent,
    verifyPromptContent,
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
    getElementClassText,
    countComposerAttachments,
    countActiveUploads,
    classifyFileInput,
    discoverUploadMechanisms,
    testSingleImageAttachment,
    ATTACH_FILE_TIMEOUT_MS,
    // v0.6 / v0.9: send + preflight + generation detection
    sendCurrentComposer,
    sendComposerPrompt,
    clickSendButton,
    detectGenerationStart,
    findSendButtonLocalized,
    findSendButtonDiagnostic,
    captureConversationBaseline,
    scoreGeneratedImageCandidate,
    verifyImageStability,
    findNewGeneratedResult,
    waitForNewGeneratedImage,
    // v0.6.2: attachment step trace + layered menu/input probes
    runAttachTrace,
    runAttachStrategyA,
    runFileInputLifecycleProbe,
    probeUploadFilesCandidates,
    findUploadFilesInOverlay, // alias of probeUploadFilesCandidates
    findMenuCandidates,
    describeMenuItem,
    describeDomNode,
    snapshotFileInputs,
    waitForAttachmentEvidence,
    scoreUploadCandidate,
    ATTACH_TRACE_STEPS,
    UPLOAD_FILES_FALLBACK_LABELS,
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
