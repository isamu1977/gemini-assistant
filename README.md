# Gemini Assistant

Chrome extension (Manifest V3) that turns `gemini.google.com` into a
scriptable target for any workflow driven by a **Project JSON** and a
**list of tasks**. The first use case is image generation, but the core
is generic.

It does not call the Gemini API. It does not click Send. It does not
upload images. It only:

1. Loads a Project JSON from disk.
2. Shows the tasks, status, and editable prompts.
3. Lets you navigate, edit, mark status, and insert the current task's
   prompt into Gemini's textbox for manual review and sending.

The Gemini DOM is touched only by `src/dom/geminiDomAdapter.js` — one
file, isolated, language-independent (validated in EN and PT).

---

## Project layout

```
.
├── manifest.json
├── icons/                        16/48/128.png
├── src/
│   ├── popup/                    popup.html, popup.css, popup.js
│   ├── content/
│   │   └── content.js            bridges popup <-> adapter
│   ├── dom/
│   │   └── geminiDomAdapter.js   ⭐ only file that touches Gemini's DOM
│   └── lib/
│       ├── project.js            Project JSON schema + validation
│       └── storage.js            chrome.storage.local wrapper
├── examples/
│   └── example-project.json      5 tasks for manual testing
└── tests/
    ├── run.js                    pure-Node test runner
    ├── fixtures/                 validation fixtures
    └── README.md                 test docs
```

> **No build step.** Plain JavaScript, no bundler, no npm install
> required. Load the folder directly via Chrome's `Load unpacked`.

---

## Project JSON (schema version 1)

```jsonc
{
  "schemaVersion": 1,
  "project": {
    "id": "example-project",      // stable id
    "name": "Example Project",     // required
    "description": "optional"
  },
  "tasks": [
    {
      "id": "task-001",           // unique within project, required
      "title": "First task",      // optional
      "prompt": "..."             // required, non-empty
    }
  ]
}
```

Rules enforced by the validator:
- `schemaVersion` must equal `1`.
- `project.id` and `project.name` are required and non-empty.
- `tasks` is a non-empty array.
- Each task has a unique `id` and a non-empty `prompt`.
- `title` is optional (defaults to empty string).

## Task status

Four values, fixed for v1: `pending` (default), `generated`, `approved`, `redo`.

Statuses are **manually set** — the extension does not detect them from Gemini.

---

## Install (Load unpacked)

1. `chrome://extensions/` → toggle **Developer mode** on.
2. Click **Load unpacked** → select this folder.
3. Pin the extension to the toolbar for easy access.

After editing any source file, hit the **Reload** icon on the extension's
card in `chrome://extensions/`, then hard-reload any Gemini tab
(`Cmd/Ctrl + Shift + R`).

---

## Usage

1. Open `https://gemini.google.com` and sign in.
2. Click the **Gemini Assistant** icon.
3. Click **Import Project** and pick a JSON file (try
   `examples/example-project.json`).
4. Use the dropdown or **Prev / Next** to navigate.
5. Edit the prompt if needed — saves locally with a 350 ms debounce.
6. Click **Insert Prompt** — the text lands in Gemini's prompt field.
   Send manually.
7. Change the task's status via the dropdown.

If you re-import while a project is already loaded, a confirmation modal
appears. Re-importing **discards the current progress and prompt edits**.

State persists across popup close and Chrome restart. Closing and
reopening the extension at any time resumes where you left off.

### Keyboard shortcuts (in the prompt textarea)

- `Cmd/Ctrl + Enter` → Insert Prompt
- `Alt + ArrowLeft` / `Alt + ArrowRight` → Prev / Next

---

## Debugging

### View extension logs

- **Service worker / popup errors:** `chrome://extensions/` → click
  **Service worker** under the extension.
- **Content script logs (most useful):** Open DevTools on the Gemini tab.
  Filter the console by `[Gemini Assistant`.

Prefixes used:
- `[Gemini Assistant:dom]` — DOM adapter (`src/dom/geminiDomAdapter.js`)
- `[Gemini Assistant:content]` — content script (`src/content/content.js`)

### Self-test panel

The popup's **Self-test** disclosure shows a live snapshot of the
adapter's view of the current page (locale, candidate count, send-button
location, ranked candidates). Open it whenever the Insert Prompt fails.

### Run the test suite

```bash
node tests/run.js
```

25 tests cover the project parser, validation, navigation helpers,
storage roundtrip, and the shipped example file. See `tests/README.md`.

---

## Architecture (who knows what)

```
popup (UI)
  ↓ uses projectLib + storageLib
  ↓ invokes content.js via chrome.tabs.sendMessage
content.js (isolated world, runs in gemini.google.com)
  ↓ delegates to geminiDomAdapter
geminiDomAdapter.js
  ↓ only file that touches Gemini's DOM
```

The popup knows nothing about Gemini's DOM. The DOM adapter knows
nothing about projects, status, or storage. The protocol between the
popup and the content script is documented in
`src/content/content.js`.

---

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 declaration. Adds `storage` permission in v0.2. |
| `src/popup/popup.html` | Popup markup (empty + loaded states). |
| `src/popup/popup.css` | Popup styling. |
| `src/popup/popup.js` | UI orchestration: storage, navigation, status, Insert Prompt. |
| `src/content/content.js` | Message bridge between popup and adapter. |
| `src/dom/geminiDomAdapter.js` | Sole point of contact with Gemini's DOM. |
| `src/lib/project.js` | Project JSON schema, validation, helpers. |
| `src/lib/storage.js` | `chrome.storage.local` wrapper with in-memory shim. |
| `examples/example-project.json` | 5-task example for manual testing. |
| `tests/run.js` | Pure-Node test runner. |
| `tests/fixtures/*.json` | Validation fixtures. |
| `icons/icon*.png` | Toolbar and store icons. |
