# Gemini Assistant

Chrome extension (Manifest V3) that turns `gemini.google.com` into a
scriptable target for any workflow driven by a **Project JSON**, a
**bound project folder**, and a **list of tasks**. The first use case is
image generation, but the core is generic.

It does **not** call the Gemini API. It does **not** require a backend.
All interaction happens through the Gemini DOM, structured by a single
adapter file. The Side Panel owns a small state machine that drives
Prepare → Generate → Send → Wait → Download for **one task at a time**.

What v0.6 does for one selected task:

1. Activates **Create Image** mode on Gemini (no auto-send yet).
2. Attaches all references in the declared order.
3. Inserts the prompt into the composer.
4. (Stops here for review — Prepare Task.)
5. On Generate Task: runs a preflight, clicks Send exactly once, waits
   for the new image to appear in the response, fetches it, and downloads
   it to `Downloads/Gemini Assistant/<project-id>/<basename>.<ext>`.
6. Marks the task as `generated`.

**v0.6 deliberately does not** (deferred to future milestones):

- Auto-advance to the next task.
- Batch generation.
- Automatic approval.
- Image editing / watermark handling.
- Direct write into the project folder.

The Gemini DOM is touched only by `src/dom/geminiDomAdapter.js` — one
file, isolated, language-independent (validated in EN and PT).

---

## Project layout

```
.
├── manifest.json
├── icons/                        16/48/128.png
├── src/
│   ├── sidepanel/                sidepanel.html, sidepanel.css, sidepanel.js
│   ├── background/
│   │   └── service-worker.js     sidePanel registration + chrome.downloads bridge
│   ├── content/
│   │   └── content.js            bridges side panel <-> adapter (Insert, Attach, Probe, Image Mode, Send, Fetch, Baseline)
│   ├── dom/
│   │   └── geminiDomAdapter.js   ⭐ only file that touches Gemini's DOM
│   ├── lib/
│   │   ├── project.js            Project JSON schema + validation (v1, v2)
│   │   ├── storage.js            chrome.storage.local wrapper
│   │   ├── assets.js             asset resolver + wrong-root detection
│   │   └── output.js             v0.6: sanitize output.basename, build download filenames
│   └── workflow/
│       └── orchestrator.js       v0.6: Prepare/Generate state machine (in-memory)
├── examples/
│   ├── example-project.json
│   ├── example-project-v1.json
│   └── example-project-v2.json   (now with `output.basename` per task)
└── tests/
    ├── run.js                    pure-Node test runner (115 tests)
    ├── fixtures/                 validation fixtures
    ├── e2e_*.py                  Playwright DOM tests (mocked)
    └── MANUAL_TESTS_V0_6.md      manual test plan A/B/C/D
```

> **No build step.** Plain JavaScript, no bundler, no npm install
> required. Load the folder directly via Chrome's `Load unpacked`.

---

## Chrome Side Panel

The UI is now a **Chrome Side Panel** (Manifest V3, Chrome 116+). The
toolbar icon opens the side panel directly. There is no popup.

- Click the **Gemini Assistant** toolbar icon on a `gemini.google.com`
  tab → the side panel opens.
- The side panel host resizes to the available width (default ~320 px,
  user-resizable). It uses the full viewport height.
- The side panel is scoped to the active tab. While it's open, you can
  switch tabs without losing the project state (the state is in
  `chrome.storage.local`).

If a future Chrome version requires a fallback, the side panel is
loaded from `src/sidepanel/sidepanel.html` and the service worker
(`src/background/service-worker.js`) registers the behavior. See
`manifest.json` for the `side_panel.default_path` and the `sidePanel`
permission.

---

## Generation workflow (v0.6)

```
┌─ Side Panel ──────────────────────────────────────────────────┐
│                                                                │
│   [ Ensure Image Mode ]   ← idempotent                         │
│   [ Prepare Task ]        ← image mode + 3 refs + prompt        │
│   [ Generate Task ]       ← preflight + send + wait + download  │
│   [ Cancel ]              ← mid-flight                          │
│                                                                │
│   After complete:                                            │
│     [ Mark Approved ]                                         │
│     [ Mark Redo ]   ← re-run generates (1).png via uniquify   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

State machine: see `src/workflow/orchestrator.js`. Phases:

```
idle → preparing-image-mode → preparing-attachments
    → preparing-prompt → ready → preflight → sending
    → waiting-for-generation → downloading → complete
                                       │
                                       └─ any failure ─→ error
                                       └─ user cancel  ─→ cancelled
```

`Downloads/Gemini Assistant/<project-id>/<basename>.<ext>` is where
files land. The basename comes from `task.output.basename` (sanitized)
or, when absent, from `task.id`.

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

In v0.6 the extension transitions `pending → generated` automatically
when a Generate Task run completes successfully (download started).

Statuses `approved` and `redo` are **still manually set** — review the
downloaded image yourself before approving.

---

## Install (Load unpacked)

1. `chrome://extensions/` → toggle **Developer mode** on.
2. Click **Load unpacked** → select this folder.
3. Pin the extension to the toolbar for easy access.

After editing any source file, hit the **Reload** icon on the extension's
card in `chrome://extensions/`, then hard-reload any Gemini tab
(`Cmd/Ctrl + Shift + R`).

> **Minimum Chrome version:** 116. The Side Panel API
> (`chrome.sidePanel`) requires Chrome 114+; we declare 116 to be safe.

---

## Usage

### v0.6 — End-to-end single task

1. Open `https://gemini.google.com` and sign in.
2. Click the **Gemini Assistant** toolbar icon. The Side Panel opens.
3. Click **Import Project** and pick a JSON file (use
   `examples/example-project-v2.json`).
4. Click **Bind folder…** under *Project Files* and pick the folder that
   contains your reference images. Binding is session-only.
5. Navigate to **scene-001**.
6. In the **Generation** card, click **Ensure Image Mode**. The Gemini
   page now shows the "Create image" toggle active.
7. Click **Prepare Task**. The orchestrator attaches each reference in
   order, inserts the prompt, and stops at `ready`. **Nothing is sent
   yet.** Review the composer on the Gemini page.
8. Click **Generate Task**. The orchestrator runs the preflight, clicks
   Send, waits for the image, and starts downloading to
   `Downloads/Gemini Assistant/yuki-video-001/scene-001.png`.
9. After success, the task status moves to `generated`. **Mark
   Approved** or **Mark Redo**.

The workflow locks navigation while running. Use **Cancel** to abort
local polling (an in-flight Gemini generation cannot be cancelled).

### v0.6.2 — Attachment tracing + manual gate

Attachment in real Chrome was failing silently. v0.6.2 ships an
**instrumentation-only** patch — no behavioral change to the existing
`attachFileWithMenu` flow — so we can identify the exact step at which
the flow dies before attempting any fix.

What is new:

- **Trace attachment** button inside the *Attachment* card. Runs a
  structured 12-step trace and renders the result inline. Each step
  reports `ok` / `ts` / `durationMs` and a small structural payload
  (no file bytes).
- **Try Strategy A** button (disabled until the trace reaches
  `upload-action-detected`). Triggers the native-input + DataTransfer
  flow end-to-end and waits for a chip delta.
- **Mark attach verified** button. Until toggled, *Prepare Task* and
  *Generate Task* stay disabled — the user must manually confirm the
  trace succeeded end-to-end in real Gemini before the workflow can
  run. This gate resets on project import.
- The *Debug* card now appends the last trace JSON under
  `--- last attach trace ---` so the full structured report is
  preserved.

Until the trace step `attachment-ready` turns true in real Gemini, do
not assume attach works. The trace is the only contract test we have
left; automated Playwright tests cannot substitute for the real
Angular/Material DOM.

### v0.5.1 — Manual attach + insert

Still supported. You can use the old flow:

1. Bind folder, navigate to a task with references.
2. Click **Attach** per reference.
3. Click **Insert Prompt**.
4. **Send manually** on the Gemini page.

The **Debug** panel shows the raw JSON self-test (collapsed by default).

If you re-import while a project is already loaded, a confirmation modal
appears. Re-importing **discards the current progress, prompt edits, and
the bound folder**.

Project state (project, tasks, edits, status) persists across side
panel close and Chrome restart. Folder binding and the resolved-file
cache are session-only.

### Keyboard shortcuts (in the prompt textarea)

- `Cmd/Ctrl + Enter` → Insert Prompt
- `Alt + ArrowLeft` / `Alt + ArrowRight` → Previous / Next

---

## Debugging

### View extension logs

- **Service worker / side panel errors:** `chrome://extensions/` →
  click **Service worker** under the extension.
- **Content script logs (most useful):** Open DevTools on the Gemini
  tab. Filter the console by `[Gemini Assistant`.

Prefixes used:
- `[Gemini Assistant:dom]` — DOM adapter (`src/dom/geminiDomAdapter.js`)
- `[Gemini Assistant:content]` — content script (`src/content/content.js`)
- `[Gemini Assistant:sp]` — side panel (`src/sidepanel/sidepanel.js`)
- `[Gemini Assistant:sw]` — service worker (`src/background/service-worker.js`)

### Self-test panel

The side panel's **Debug** disclosure shows a live snapshot of the
adapter's view of the current page (locale, candidate count, send-button
location, ranked candidates). Open it whenever the Insert Prompt fails.

### Attachment diagnostics

The side panel's **Attachment** disclosure shows the live state of the
upload affordance:

- `Trigger` — did we find a likely "+" / upload button?
- `Input mounted` — is the `<input type="file">` currently in the DOM?
- `Menu open` — is a popover / menu visible?
- `Attachment area` — could we localize the upload area?
- `Current hints` — count of attachment thumbnail hints
- `Likely dynamic` — Gemini's input is most likely mounted only after
  the user opens the attachment menu.

Click **Probe attachment** to re-run the probe on demand. The probe
does NOT auto-attach; it only inspects state.

### Run the test suite

```bash
node tests/run.js
```

69 tests cover the project parser, validation, navigation helpers,
storage roundtrip, the asset resolver, and the new wrong-root detection.

The e2e Python suite (Playwright) covers the side panel DOM contract:
modal, references, insert, attach, diagnostics, and wrong-root. Run
with `python3 tests/e2e_*.py` (each file is independent).

---

## Architecture (who knows what)

```
sidepanel (UI)
  ↓ uses projectLib + storageLib
  ↓ invokes content.js via chrome.tabs.sendMessage
content.js (isolated world, runs in gemini.google.com)
  ↓ delegates to geminiDomAdapter
geminiDomAdapter.js
  ↓ only file that touches Gemini's DOM
```

The side panel knows nothing about Gemini's DOM. The DOM adapter knows
nothing about projects, status, or storage. The protocol between the
side panel and the content script is documented in
`src/content/content.js`.

## Bug history

### v0.6.1 — Messaging stabilization (Side Panel → Gemini)

**Symptom**: clicking *Ensure Image Mode* or *Prepare Task* failed
immediately with

```
Error in invocation of tabs.sendMessage(
  integer tabId,
  any message,
  optional object options,
  optional function callback
):
No matching signature.
```

The state machine recorded `[phase] idle -> preparing-image-mode ->
error` before any DOM logic ran. The Side Panel's self-test
(`GEMINI_ASSISTANT_PING`) and *Insert Prompt* still worked, so the bug
was specific to the v0.6 workflow.

**Root cause**: the v0.6 orchestrator held a closure variable
`let tabId = null;` that was never assigned. Every `sendToTab(tabId,
msg)` call therefore invoked `chrome.tabs.sendMessage(null, msg,
callback)`, which Chrome rejects because `null` is not an integer.

**Fix**:

- New `src/lib/messaging.js` is the single source of truth for
  `chrome.tabs.sendMessage` calls. It exposes:
  - `getTargetGeminiTab(chrome)` — resolves the Gemini tab, prefers
    `active + currentWindow`, falls back to scanning every window,
    throws a clear error when no Gemini tab is open.
  - `sendTabMessage(chrome, tabId, message)` — validates that
    `tabId` is a positive integer (rejects `null`, `undefined`,
    strings, floats, negatives), validates that the message has a
    non-empty `type` and is structured-cloneable, then calls
    `chrome.tabs.sendMessage(tabId, message, callback)` with strict
    3-arg discipline (never 4-arg with `undefined` options).
  - `sendToGemini(chrome, type, payload)` — convenience wrapper used
    by the orchestrator.
  - `pingGemini(chrome)` — returns `{ ok, targetTabId, targetTabUrl,
    targetTabActive, targetTabWindowId }` for the UI's
    *Messaging ✓/✕* row.
  - `MESSAGE_TYPES` — frozen map of canonical message type strings,
    shared between side panel and content script.
- The orchestrator no longer accepts a `tabId`. Its `sendToTab` dep
  is `(message) => Promise<response>`, eliminating the whole class
  of "forgot to pass tabId" bugs. A wrapper inside the orchestrator
  normalises errors to the friendly text
  `Could not communicate with Gemini content script: …` that the
  UI surfaces.
- The Side Panel UI gained a *Messaging* row in the Generation card
  and a *Ping Gemini* button. Failures show `✕ Error` with the full
  reason in the Debug card; the main UI never shows a raw
  `Error in invocation of tabs.sendMessage(...)` line.
- PT-BR fallback added to `findUploadFilesMenuitem`
  (UPLOAD_FILES_TEXT_CANDIDATES, including *Enviar arquivos*). The
  existing *Criar imagem* fallback for Create Image was preserved.

**Regression coverage** (`tests/run.js`, +20 tests):

- `messaging`:
  - `isGeminiUrl`, `isPositiveInteger`, `isMessageSerializable` shape checks.
  - `sendTabMessage` rejects `null`/`undefined`/string/float/zero/negative
    `tabId`; rejects messages without `type`; rejects non-serializable
    payloads (functions, symbols, DOM nodes).
  - 3-arg `chrome.tabs.sendMessage` invocation is verified by the mock
    harness (`args.length === 3`).
  - `getTargetGeminiTab` prefers active+currentWindow and falls back
    to a full-window scan.
  - `sendToGemini` rejects bad `type` and bad payload shape.
  - `pingGemini` returns the structured diagnostic.
  - `chrome.runtime.lastError` is propagated as a real Error.
- `orchestrator`:
  - `sendToTab` is called with exactly one argument (the message).
  - Messaging failure at *preparing-image-mode* halts the workflow
    and surfaces a friendly error.
  - Messaging failure at *preparing-attachments* does NOT advance
    to *preparing-prompt*.
  - Messaging failure at *preparing-attachments* does NOT advance
    to *sending*.
  - Messaging failure at *send* does NOT advance to
    *waiting-for-generation*.

**What did NOT change**:

- Project / Task manager, folder binding, asset resolver, Insert
  Prompt, single Attach — all still work as in v0.6.0.
- The orchestrator's PHASES list, preflight checks, and download
  pipeline are untouched.
- No batch, no auto-next, no retry, no JingJing integration.

### v0.6.0 — End-to-End Single Task Image Generation

- New `task.output.basename` optional field for download filenames. Sanitized at parse time; path traversal rejected.
- New Image Generation mode adapter (`ensureImageGenerationMode`) detects the "Deselect Images" toggle that appears only when active.
- New `attachFileWithMenu` opens the + menu, clicks Upload files, injects via DataTransfer, waits for the chip with the expected filename.
- New orchestrator (`src/workflow/orchestrator.js`) drives Prepare → Generate → Send → Wait → Download.
- New service-worker download bridge (`chrome.downloads` with `conflictAction: "uniquify"`).
- New task auto-transition `pending → generated` after successful download start.
- Operation lock disables navigation during a run.
- Composer non-clean safety check before Prepare.
- Side Panel: new **Generation** card with workflow buttons + phase log.
- New diagnostics: imageMode, baseline, attachment menu state.

### v0.5.1 — Wrong-root selection + Attachment diagnostics + Side Panel

**Root cause of `Missing` when the user selects the wrong folder:**

The resolver treats `directoryHandle` as a literal project root. If
the user picks `references/` directly, the resolver tries
`references/references/character-main.png` → `NotFoundError` →
`missing`. The behavior is deterministic and correct; the missing
piece was the UX that **detects** the mis-selection.

**Fix:** `src/lib/assets.js` got a new helper, `detectWrongRootSelection`,
which fires only when:

1. Every asset's relative path begins with the same first segment.
2. That first segment equals the bound folder's name.
3. **A spot-check I/O confirms it:** looking up the basename (the part
   after the first segment) inside the bound folder SUCCEEDS.

When the three conditions hold, the side panel shows a **Wrong
folder selected** banner with the message:

> The selected folder is "references".
> That looks like the project subfolder "references", not the project root.
> Select the project root folder that contains:
>   references/

The banner never auto-fixes. The user must click **Rebind** and pick
the correct folder.

**Missing asset card:** when a ref is missing, the card shows a
compact `Missing` badge. The full diagnostic (assetId, expectedRelativePath,
selectedRootName, matched: false) is in the card's tooltip and the
Debug JSON panel. The resolver never logs absolute filesystem paths.

**Attachment file input lifecycle (v0.5.1):**

The v0.5.0 self-test reported `fileInputCount: 0` on the idle composer.
That was NOT a bug — Gemini's `<input type="file">` is dynamically
mounted only after the user opens the attachment menu. Gemini's SPA
keeps the input out of the DOM until it is needed.

**Diagnostic additions** (`src/dom/geminiDomAdapter.js`):

- `attachmentProbe()` — structured snapshot of the upload surface:
  triggerFound, fileInputCount, menuOrPopoverOpen, attachmentAreaFound,
  currentHints, inputLikelyDynamic, notes.
- `activateAttachmentFlow()` — best-effort: finds the trigger, clicks
  it, polls for a menu/input to appear, then sends Escape to close the
  menu. Never errors.
- `attachFileToGemini()` now distinguishes "input not found" from
  "input permanently missing" — when `inputLikelyDynamic` is true, the
  error message tells the user to use the Probe button.

**Single attachment flow:** unchanged in v0.5.1. It still requires the
file input to be mounted at the moment of the click. The next
milestone will wire Attach All / Prepare Task using the activation
probe.

**Side Panel migration:**

The main UI moved from `src/popup/popup.html` to
`src/sidepanel/sidepanel.html`. The toolbar icon now opens the side
panel directly via `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.

- `manifest.json` gains `"sidePanel"` permission and
  `side_panel.default_path`.
- `src/background/service-worker.js` registers the behavior on install
  and on startup.
- `src/popup/` is deleted.
- The side panel reuses `projectLib`, `storageLib`, `assetsLib`, and
  the `content.js` message bridge. Only the UI shell changed.
- All e2e tests now target `src/sidepanel/sidepanel.html`.

The side panel layout: PROJECT, PROJECT FILES, TASK, PROMPT, PROGRESS
(collapsible), ASSETS (collapsible), ATTACHMENT (collapsible), DEBUG
(collapsible). Sections collapse independently; Debug is closed by
default.

### v0.5.0 — Single reference attachment (PoC)

A resolved reference image can now be attached to Gemini's composer one
at a time:

1. The popup binds a local folder via `window.showDirectoryPicker`
   (File System Access API, Chrome/Edge 86+).
2. Each task's references resolve against the bound folder. The
   resolver distinguishes three states:
   - `resolved` — file found and is a PNG/JPEG/WEBP we support
   - `missing` — file not found in the bound folder
   - `unsupported` — file found but type not supported
   - `unbound` — no folder bound yet
3. The popup shows a per-row **Attach** button, enabled only when the
   ref is `resolved`.
4. Clicking **Attach** sends `{ type: "GEMINI_ASSISTANT_ATTACH", file }`
   to the content script. The `File` crosses the `chrome.tabs.sendMessage`
   boundary by structured clone — no base64, no `chrome.storage`, no
   byte duplication outside the ephemeral message envelope.
5. The DOM adapter finds Gemini's `<input type="file">`, builds a
   `DataTransfer` with the file, sets `input.files`, and dispatches
   `input` + `change` events.
6. The adapter watches the upload area via a one-shot
   `MutationObserver` (no polling) for up to 4 s, looking for a new
   thumbnail (`<img src="data:...">` or attachment-class hints).
7. Success → `Attached <name> (<size>) to Gemini. Review and send.`
   Failure → `Attachment failed: <reason>` (loud and structured).

**What v0.5 deliberately does NOT do:**

- Attach All (multi-reference batch)
- automatic Prepare Task / Send
- queueing, retry, rename, download
- image processing (no resize, no compression, no conversion — the
  original bytes go through)
- formats beyond PNG / JPEG / WEBP (everything else is `unsupported`)
- persisting attachment state to disk (it is ephemeral — a reload of
  Gemini, a Send, or removing the chip manually invalidates it; the
  popup will not pretend otherwise)

**Folder binding limitation:** the `FileSystemDirectoryHandle` cannot
be reliably rehydrated across a popup close without re-prompting the
user. v0.5 keeps the handle in popup memory only. Closing the popup and
reopening it requires re-binding. This is documented in the UI.

**File transfer note:** `File` is a `Blob`, and `Blob` is
structured-cloneable. `chrome.tabs.sendMessage` uses structured clone
in MV3 (since Chrome 80+), so the File travels as a single pass-by-value
object. There is no byte copying into `chrome.storage.local`. The
bytes only exist once on the heap: in the popup's `File` reference,
then in the content script's `File` reference, then handed to the
adapter. The mock in `tests/e2e_attach.py` confirms this end-to-end
by reading `msg.file.name` / `.size` / `.type` after the message has
crossed the boundary.

### v0.4.0 — Project folder binding + asset resolver (inline with v0.5)

Folder binding and asset resolution shipped inline with v0.5 because
the attachment PoC depends on them. The resolver (`src/lib/assets.js`)
is pure and unit-tested (15 new cases in `tests/run.js`). The popup
adds a per-row state badge and an Attach button gated on
`state === "resolved"`.

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
| `manifest.json` | Manifest V3 declaration (sidePanel, service worker). |
| `src/sidepanel/sidepanel.html` | Side Panel markup. |
| `src/sidepanel/sidepanel.css` | Side Panel styling. |
| `src/sidepanel/sidepanel.js` | UI orchestration: storage, navigation, status, Insert Prompt, Attach, folder binding, wrong-root banner, attachment diagnostics. |
| `src/background/service-worker.js` | Registers `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`. |
| `src/content/content.js` | Message bridge between side panel and adapter (Insert + Attach + Probe + Activate). |
| `src/dom/geminiDomAdapter.js` | Sole point of contact with Gemini's DOM. |
| `src/lib/project.js` | Project JSON schema, validation, helpers. |
| `src/lib/storage.js` | `chrome.storage.local` wrapper with in-memory shim. |
| `src/lib/assets.js` | Asset resolver + wrong-root detection + missing diagnostic. |
| `examples/example-project.json` | 5-task example for manual testing. |
| `examples/example-project-v2.json` | 5-task v2 example with 5 assets. |
| `tests/run.js` | Pure-Node test runner (69 tests). |
| `tests/fixtures/*.json` | Validation fixtures. |
| `tests/e2e_*.py` | Playwright DOM tests (mocked). |
| `icons/icon*.png` | Toolbar and store icons. |
