# Gemini Assistant

Chrome extension (Manifest V3) PoC that assists the image generation
workflow by inserting prompts into the Gemini prompt field on
<https://gemini.google.com>.

This is a **deliberately minimal proof of concept**. It does not call the
Gemini API, does not click the Send button, and does not upload images.
It only:

1. Shows a popup with a textarea and an **Insert Prompt** button.
2. Locates the Gemini prompt field on the page.
3. Places the typed text into it.
4. Leaves the cursor focused so you can review, edit, and click Send manually.

The architecture is shaped so future automation (project manifest, scene
queue, reference upload, click Send, etc.) can be added without rewriting
the popup or content script.

---

## Project layout

```
.
├── manifest.json
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── src/
│   ├── popup/                  # Extension toolbar popup
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── content/                # Content script (runs inside gemini.google.com)
│   │   └── content.js
│   └── dom/
│       └── geminiDomAdapter.js # ⭐ Only file that touches Gemini's DOM
├── README.md
└── .gitignore
```

> **No build step.** Plain JavaScript, no bundler, no npm install required.
> Load the folder directly via Chrome's `Load unpacked`.

---

## Install (Load unpacked)

1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** on (top-right corner).
3. Click **Load unpacked**.
4. Select this folder (`gemini-assistant/`).
5. The extension **Gemini Assistant** should appear in the list.
   Pin it to the toolbar for easy access (puzzle icon → pin).

If you ever edit a file, hit the **Reload** icon on the extension's card
in `chrome://extensions/`. Content scripts are re-injected on the next
page navigation (or hard reload `Cmd/Ctrl + Shift + R` in the Gemini tab).

---

## Test the PoC

1. Sign in to Gemini at <https://gemini.google.com> and open or start a chat.
2. Click the **Gemini Assistant** icon in the Chrome toolbar.
3. Type a prompt in the textarea.
4. Click **Insert Prompt** (or press `Cmd/Ctrl + Enter`).
5. The Gemini prompt field on the page gets the text. **Nothing is sent.**
6. Review, edit, and press Enter (or click Send) on Gemini manually.

The popup status line shows:

- `Ready` — content script is alive and the tab is on Gemini.
- `Inserted (N chars). Review and send.` — success.
- `Gemini textbox not found. Are you signed in and on the chat screen?` — textbox isn't on the page.
- `Reload the Gemini tab to activate the extension.` — you opened the popup before the content script loaded.

---

## Debugging

### View extension logs

- **Service worker / extension errors:** `chrome://extensions/` → click
  **Service worker** under the extension.
- **Content script console logs (the most useful one):**
  1. Open Gemini in a tab.
  2. Open DevTools (`Cmd/Ctrl + Option + I` / `F12`).
  3. The content script runs in its own isolated world; you will see all
     its logs in the same DevTools console (not in a separate "top" frame).
  4. Filter by `[Gemini Assistant` to see only our logs.

Both scripts log with a prefix:

- `[Gemini Assistant:dom] ...` — DOM adapter (`src/dom/geminiDomAdapter.js`)
- `[Gemini Assistant:content] ...` — content script (`src/content/content.js`)

### Manual self-test in DevTools

While on a Gemini page, in the console, run:

```js
// The adapter lives in the content script's isolated world, so it is
// not directly visible from the page console. To check the DOM state:
// (paste in DevTools while on gemini.google.com)

document.querySelector('[aria-label="Enter a prompt for Gemini"]')?.innerText
```

If that returns `null`, the textbox is not on the page (signed out, or
still loading). If it returns a string, the adapter target is live.

### Re-run the headless validation

This PoC ships with a Python+Playwright smoke test that loads the extension
into a Chromium instance and verifies the content script is injected:

```bash
python3 /tmp/validate_extension.py
```

(The script lives outside the repo for now; it can be moved into a
`scripts/` folder if you want to keep it in version control.)

---

## How it works (architecture)

```
┌─────────────────────┐  chrome.tabs.sendMessage  ┌─────────────────────────┐
│ popup.html / popup.js│ ─────────────────────────►│ content.js              │
│                     │                            │  (isolated world)       │
│  - textarea + btn    │  sendResponse({ok, ...})   │  - onMessage listener   │
│  - status line       │ ◄─────────────────────────│  - delegates to adapter │
└─────────────────────┘                            └────────────┬────────────┘
                                                                │
                                                                ▼
                                                ┌─────────────────────────────┐
                                                │ geminiDomAdapter.js          │
                                                │  (also isolated world)       │
                                                │  - locator for textbox       │
                                                │  - locator for Quill __quill│
                                                │  - quill.insertText          │
                                                │  - quill.focus()             │
                                                └─────────────────────────────┘
```

### Why the DOM adapter is separate

The Gemini UI is a heavily SPA'd Angular app. Any selector we pick could
break tomorrow. We isolate **all** DOM access in
`src/dom/geminiDomAdapter.js`. A single constant block at the top of that
file holds the selectors and the strategy. When Gemini changes, that is
the **only** file we touch.

### Key implementation notes

- The Gemini prompt field is a `contenteditable` Quill editor wrapped in
  a custom `<rich-textarea>` Web Component. We use `quill.insertText(0,
  text)` instead of `Element.innerHTML = ...` because Gemini ships a
  strict CSP that blocks `TrustedHTML` assignment.
- **The prompt input is found using structural + semantic markers, not
  the localized `aria-label`.** The Gemini UI translates the
  `aria-label` per locale (e.g. `"Enter a prompt for Gemini"` in
  English, `"Insira um comando para o Gemini"` in Portuguese), so a
  literal selector would break for any non-English user. Instead, we
  collect candidates from three independent layers:
  1. `rich-textarea .ql-editor` — best, exploits the custom Web Component
  2. `div.ql-editor[contenteditable="true"][role="textbox"]` — semantic
  3. `[role="textbox"][contenteditable="true"]` — generic fallback
  Each candidate is scored for visibility, structural location, and
  proximity to the Send button. The highest-scoring one wins.
- We never touch the Send button. The PoC stops at "text in the box".

### Diagnostics

The popup's **Self-test** panel shows a live snapshot of what the
adapter sees on the current Gemini page:

- `htmlLang` — the inferred UI locale
- `qlEditorCount`, `richTextareaCount`, `inputAreaCount`, `textboxRoleCount`
- `sendButtonFound` — whether the adapter could locate the Send button
  (used as a structural validator)
- `selected` — the prompt input the adapter chose, plus its attributes
- `candidates` — every candidate with its score, so you can see why a
  particular node was chosen (or why none were)

If insertion fails, the popup status line also shows a one-line summary
of the diagnostics (candidate count, .ql-editor count, textbox role
count) so you can debug without opening DevTools.

---

## Roadmap (not implemented yet)

These are intentionally **out of scope** for the PoC. The architecture
above is shaped so they can be added without invasive changes:

- Side panel with project manifest
- Browser-local project store (JSON file + IDB)
- Scene queue with Previous / Next navigation
- Click Send and wait for response (requires "completion" detection)
- Auto-upload of reference images
- Per-scene status: Pending / Generated / Approved / Redo
- Retry and persistence of progress

---

## Permissions

`manifest.json` requests only:

- `host_permissions`: `https://gemini.google.com/*` — required to inject
  the content script.

No `activeTab`, no `storage`, no `<all_urls>`. The extension literally
cannot reach anything outside Gemini.

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 declaration. |
| `src/popup/popup.html` | Popup markup. |
| `src/popup/popup.css` | Popup styling. |
| `src/popup/popup.js` | Popup logic: tab query, sendMessage, status. |
| `src/content/content.js` | Message bridge between popup and adapter. |
| `src/dom/geminiDomAdapter.js` | Sole point of contact with Gemini's DOM. Locale-independent structural + semantic selectors. |
| `icons/icon*.png` | Toolbar and store icons. |
