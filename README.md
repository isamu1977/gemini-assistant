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

## Project JSON (schema version 1 and 2)

Both versions are accepted. **v1** projects are valid forever — no
migration is required to use the asset catalog. **v2** adds an
optional asset catalog and optional per-task references.

### v1 (legacy)

```jsonc
{
  "schemaVersion": 1,
  "project": {
    "id": "example-project",
    "name": "Example Project",
    "description": "optional"
  },
  "tasks": [
    {
      "id": "task-001",
      "title": "First task",        // optional
      "prompt": "..."               // required, non-empty
    }
  ]
}
```

### v2 (asset catalog + references)

```jsonc
{
  "schemaVersion": 2,
  "project": { "id": "...", "name": "...", "description": "..." },
  "assets": {                       // optional; absent treated as {}
    "asset-id": {
      "label": "Human-readable name",   // required, non-empty
      "type": "character",                // character | environment | style | object | other
      "file": "refs/asset.png"           // required, non-empty
    },
    ...
  },
  "tasks": [
    {
      "id": "task-001",
      "title": "First task",               // optional
      "prompt": "...",                    // required
      "references": ["asset-id", "..."]   // optional; absent treated as []
    }
  ]
}
```

Rules enforced by the validator:
- `schemaVersion` must be 1 or 2.
- `project.id` and `project.name` are required and non-empty.
- `tasks` is a non-empty array; each task has a unique `id` and a
  non-empty `prompt`.
- For v2:
  - Each asset has a unique `id`, a non-empty `label`, a `type` from
    the 5-value enum above, and a non-empty `file`.
  - Each task's `references` (if present) is an array of strings,
    unique within the task, and every referenced id must exist in
    `assets`.

The `file` field is **metadata only**. The extension does not read
the filesystem in this milestone. Future milestones will resolve the
file path against a project package and upload the bytes to Gemini.

The order of `references` is preserved — that is the order the
extension will eventually upload images to Gemini.

### Examples in the repo

- `examples/example-project-v1.json` — minimal v1 (regression / compat)
- `examples/example-project-v2.json` — 5 tasks, 5 assets, shared asset,
  one task without references

## Asset types

`character`, `environment`, `style`, `object`, `other`.

These are metadata for organization only. The extension does not
interpret them — Gemini's prompt semantics drive how they are used.
Add new types later by extending the `ASSET_TYPES` array in
`src/lib/project.js` and bumping schema version.

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

## Bug history

### v0.3.0 — Asset catalog + per-task references

The Project JSON schema evolved to **v2** to carry a central asset
catalog and per-task references. v1 projects remain fully supported
and are treated as having no assets and no references — no migration
required.

The popup shows, for the current task:
- `References · N` header
- One row per reference with a type badge (`character`,
  `environment`, `style`, `object`, `other`), label, and file path
- An `Assets · N` collapsible catalog of every asset in the project

`Insert Prompt` continues to send only the prompt text — references
are metadata at this milestone. The next milestone will resolve
`asset.file` paths to actual bytes and upload them in declared order
before sending.

### v0.2.3 — Insert Prompt appends instead of replacing

**Symptom:** clicking Insert Prompt twice (or for two different tasks) left
both prompts concatenated in the Gemini editor. Dangerous because the
user could accidentally send multiple tasks' prompts at once.

**Root cause:** the `execCommand('insertText')` fallback in
`src/dom/geminiDomAdapter.js` was setting up a Range with
`range.collapse(false)`, which positions the caret at the **end** of
the existing content. `execCommand('insertText')` then inserts at the
caret — so each call appended. The primary Quill path (`setText('') +
insertText(0, text)`) was correct, but the fallback wasn't.

**Fix:** drop the `range.collapse(false)` call. Without it, the
range covers the entire editor content; `execCommand('insertText')`
then **replaces** the selection.

Also:

- Validate the result: if `lengthAfter` is much greater than
  `lengthRequested`, return `{ ok: false, error: "...likely appended
  instead of replaced" }` so a future regression is loud.
- Add `lengthBefore` / `lengthAfter` to the result for debugging.
- Add `contentLength` to the self-test diagnostic.

**Regression guard:** `tests/e2e_replace.py` exercises both the Quill
path and the fallback path against the live `gemini.google.com` editor
in Portuguese. Scenario 7a asserts the buggy pattern still appends;
scenario 7b asserts the fix replaces.

### v0.2.2 — Insert Prompt button does nothing

**Symptom:** clicking *Insert Prompt* had no effect, no log, no status
update. `Cmd/Ctrl+Enter` still worked, and the self-test still found
the Gemini editor correctly.

**Root cause:** when the popup was rewritten for the Project & Task
Manager, the line `insertBtn.addEventListener("click", onInsert)` was
dropped. The button existed but no handler was attached to it.

**Fix:** added the missing listener. Also tightened the status messages:

- success → `Prompt inserted into Gemini (N chars via <method>). Review and send.`
- failure → `Failed to insert prompt: <reason>`.

No more lingering "Prompt edit saved locally." after an Insert attempt.

Added minimal instrumentation logs at `[Gemini Assistant:popup]` so future
breakages in the popup→content→adapter chain are easier to localize.

**Regression guard:** `tests/e2e_insert.py` mocks `chrome.tabs.sendMessage`,
clicks the button, and asserts the captured message matches the popup's
current textarea. Reverting the listener makes 8/9 scenarios fail.

### v0.2.1 — Replace modal stuck open

**Symptom:** the "Replace current project?" modal was visible the whole
time, including after the first import and after Cancel/Replace.

**Root cause:** `src/popup/popup.css` declared `.overlay { display: flex }`.
The HTML attribute `hidden` applies `display: none` via the UA
stylesheet, but the author rule had the same specificity and came later
in source order, so it won. The modal was rendered at all times.

**Fix:** a single generic rule at the top of `popup.css`:

```css
[hidden] { display: none !important; }
```

**Regression guard:** `tests/e2e_modal.py` inspects `getComputedStyle(...).display`
on every scenario, so a regression that re-introduces the same problem
will fail the test (verified — 5/6 scenarios fail when the rule is removed).

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
