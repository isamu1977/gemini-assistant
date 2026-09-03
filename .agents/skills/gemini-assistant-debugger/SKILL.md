---
name: gemini-assistant-debugger
description: Use when debugging gemini-assistant Chrome extension runtime bugs — workflow stuck, attachment failed, image not detected, download broken, batch loop hangs. Triggers on phrases like "gemini assistant not working", "attachment failed", "image not detected", "download stuck", "batch hung", "task stuck on X phase". Reproduces via chrome-devtools MCP, walks Side Panel → Orchestrator → Messaging → Service Worker → Content Script → DOM Adapter → Gemini DOM, locates FIRST EXPECTED ≠ OBSERVED divergence, then proposes a minimal fix. Never edits code before evidence.
---

# gemini-assistant-debugger

Project-specific debugging skill for **Gemini Assistant** v0.9.16 (Manifest V3 Side Panel).

**This skill is a complement, not a replacement, for `chrome-devtools` and `chrome-extensions`.** It assumes those skills are already loaded for generic Chrome/MCP knowledge (CDP commands, MCP tools, extension manifest basics). It only documents the **specific architecture of this codebase** and the **evidence-first debugging discipline** required here.

---

## When to use this skill

Load this skill when the user reports a bug **at runtime** in gemini-assistant:

- "Generate Task" stuck on a phase forever
- Attachment probe says `fileInputCount: 0` even after menu open
- `generatedImageCount` wrong (e.g. counts avatars / UI assets)
- Download claimed but file never arrives
- Batch (`Generate All`) hangs between tasks
- Conversation reset never reaches `idle` phase
- Composer inspection reports wrong attachment count

**Do NOT use this skill for:**
- Generic Chrome extension development questions → `chrome-extensions`
- Raw CDP / MCP usage → `chrome-devtools`
- Schema / Project JSON design → `AGENTS.md`

---

## 1. Architecture (specific to this repo)

### 4 layers, 8 files

| Layer | File | Responsibility |
|---|---|---|
| **UI** | `src/sidepanel/sidepanel.js` (5902 LOC) | All UI, project import, folder binding, orchestator lifecycle owner |
| **State machine** | `src/workflow/orchestrator.js` (2097 LOC) | Linear phase transitions, batch processing |
| **Bridge (page)** | `src/content/content.js` (1054 LOC) | Single switch dispatcher for 25+ message types |
| **DOM Adapter** | `src/dom/geminiDomAdapter.js` (4907 LOC) | **ONLY file that touches Gemini's DOM** |
| **Service Worker** | `src/background/service-worker.js` (714 LOC) | `chrome.sidePanel` + `chrome.downloads` bridge |
| **Lib messaging** | `src/lib/messaging.js` (383 LOC) | Tab resolution + Promise wrapper |
| **Lib storage** | `src/lib/storage.js` (190 LOC) | `chrome.storage.local` + in-memory shim |
| **Lib project** | `src/lib/project.js` (773 LOC) | Schema v1/v2/v3 + prompt composition |

**Rule:** any DOM change happens in `geminiDomAdapter.js` only. Any state-machine change happens in `orchestrator.js` only. Never sprinkle DOM access across files.

### Communication boundaries (where bugs hide)

```
Side Panel
  │  chrome.tabs.sendMessage(tabId, msg)       ← messaging.js:getTargetGeminiTab
  │  ⚠ tabId resolution + structured-clone
  ↓
Content Script (content.js)
  │  switch(msg.type)                          ← 25+ cases
  │  delegates to globalThis.RedSunDomAdapter
  ↓
DOM Adapter (geminiDomAdapter.js)             ← MAIN world
  │  all selectors + MutationObservers
  ↓
gemini.google.com (Quill + Angular)

Side Panel → Service Worker → chrome.downloads (parallel)
```

**Three failure-prone boundaries:**
1. **Side Panel → Content Script**: `messaging.js` must resolve a real Gemini tab; payload must be structured-cloneable (no functions, no DOM nodes, no cyclic refs).
2. **Content Script → DOM Adapter**: `geminiDomAdapter.js` loads BEFORE `content.js` per `manifest.json:41-46`. Verify `globalThis.RedSunDomAdapter` exists at PING.
3. **Side Panel → SW → `chrome.downloads`**: Blob → ArrayBuffer transfer. `ARM_DOWNLOAD` precedes `DOWNLOAD_BLOB`. `onDeterminingFilename` rewrites the path; if missing, file lands in default Downloads.

---

## 2. Canonical message types

All type strings live in `src/lib/messaging.js:MESSAGE_TYPES` (single source of truth). The content script (`content.js:279-1010`) handles them; the orchestrator / side panel send them.

### Side Panel → Content Script
| Type | When |
|---|---|
| `GEMINI_ASSISTANT_PING` | First contact; verifies adapter is loaded |
| `GEMINI_ASSISTANT_IMAGE_MODE_PROBE` / `ENSURE_IMAGE_MODE` | Create Image mode toggle |
| `GEMINI_ASSISTANT_ATTACH` / `ATTACH_WITH_MENU` | Reference upload |
| `GEMINI_ASSISTANT_ATTACH_PROBE` / `ATTACH_ACTIVATE` / `ATTACH_TRACE` / `ATTACH_STRATEGY_A` | Attachment lifecycle |
| `GEMINI_ASSISTANT_DISCOVER_UPLOADS` | Find uploaded chips |
| `GEMINI_ASSISTANT_TRANSPORT_TEST` | Verify File survives structured-clone |
| `GEMINI_ASSISTANT_COMPOSER_STATE` / `INSPECT_COMPOSER` / `CLEAR_COMPOSER` | Composer contents |
| `GEMINI_ASSISTANT_INSERT_PROMPT` | Paste prompt text via Quill API |
| `GEMINI_ASSISTANT_SEND_COMPOSER` / `FIND_SEND_BUTTON` / `CLICK_SEND_BUTTON` | Submission |
| `GEMINI_ASSISTANT_CAPTURE_BASELINE` | Snapshot user-query / model-response / image counts |
| `GEMINI_ASSISTANT_DETECT_GENERATION_START` | Wait for "creating image" text indicator |
| `GEMINI_ASSISTANT_WAIT_FOR_GENERATED_IMAGE` / `FIND_NEW_RESULT` / `DETECT_GENERATION_IMAGE` | New image detection |
| `GEMINI_ASSISTANT_FETCH_IMAGE` | Return Blob for download |
| `GEMINI_ASSISTANT_CLICK_OFFICIAL_DOWNLOAD` | Click the in-page download button |
| `GEMINI_ASSISTANT_RESET_TO_CLEAN_CONVERSATION` / `WAIT_FOR_CLEAN_CONVERSATION` | Conversation reset (Next Task) |
| `GEMINI_ASSISTANT_START_EXECUTION` | Begin an isolated execution (AbortController) |
| `GEMINI_ASSISTANT_TEST_*` | Diagnostic tests (TEST_SINGLE_ATTACH, A_BUNDLED, B_SYNTHETIC, C_PROJECT) |

### Side Panel → Service Worker
| Type | When |
|---|---|
| `GEMINI_ASSISTANT_ARM_DOWNLOAD` | Subscribe side-panel to `onChanged` for a downloadId |
| `GEMINI_ASSISTANT_GET_DOWNLOAD_TRACE` | Read last N download events |
| `GEMINI_ASSISTANT_DOWNLOAD_PROBE` | Inspect download internals |
| `GEMINI_ASSISTANT_RELOAD_TAB` / `OPEN_NEW_TAB` | Force fresh Gemini tab |
| `GEMINI_ASSISTANT_DOWNLOAD_BLOB` | Send Blob (as ArrayBuffer) for `chrome.downloads.download` |

### Service Worker → Side Panel
| Type | Source |
|---|---|
| `GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED` | `chrome.downloads.onChanged` / `onDeterminingFilename` |
| `GEMINI_ASSISTANT_DOWNLOAD_TRACE_RESPONSE` | reply to `GET_DOWNLOAD_TRACE` |

---

## 3. Orchestrator phases (single linear state machine)

Defined in `src/workflow/orchestrator.js:46-67`. **19 phases.**

```
idle
 → clearing-composer                   (optional, forceClear=true)
 → preparing-image-mode                (idempotent toggle)
 → preparing-attachments               (sequential per ref)
 → preparing-prompt                    (insert prompt via INSERT_PROMPT)
 → ready                               (stops here for user review in Prepare-only flow)

Continue Generate flow:
 → waiting-for-uploads
 → preflight
 → sending
 → submitted
 → waiting-for-generation              (poll "creating image" text)
 → generating
 → downloading                         (FETCH_IMAGE → ARM_DOWNLOAD → DOWNLOAD_BLOB)
 → complete
 → task-complete                       (v0.10: marker before reset)
 → resetting-conversation              (RESET_TO_CLEAN_CONVERSATION → WAIT_FOR_CLEAN_CONVERSATION)
 → idle

Terminal on any failure: error / cancelled
```

`orchestrator.runBatch(params)` (v0.10.x) wraps the above for `Generate All`. Failure callback `onBatchPauseRequested` returns `"skip" | "stop" | "retry"` (default `"stop"`).

**State fields** worth inspecting live (`orchestrator.state`):
- `phase`, `taskId`, `executionId`, `preparationSessionId`, `cancelled`
- `imageMode`, `attachments[]`, `promptInserted`, `preflight`, `send`
- `generation` (with `imageSrc`, `alt`, `evidence`)
- `download` (with `status`, `downloadId`, `finalFilename`, `relativePath`)
- `error`, `lastTransitionInfo`

---

## 4. chrome.storage schema

Single key: `state_v1` (`storage.js:22`). Schema version `1`.

```jsonc
{
  "schemaVersion": 1,
  "source": { "project": <Project JSON>, "importedAt": <ms> } | null,
  "tasks": {
    "<taskId>": { "status": "pending|generated|approved|redo", "prompt": string }
  } | null,
  "currentTaskId": string | null,
  "attachUnlocked": boolean   // v0.6.2 gate (legacy data: false)
}
```

**In-memory shim** activates when `chrome.storage` unavailable (Node tests).

**Inspect via MCP:** `evaluate_script` in SW context:
```js
chrome.storage.local.get('state_v1', s => console.log(s))
```

---

## 5. DOM Adapter probes (non-destructive)

All return structured objects; **never click anything**.

| Probe | Function | File:Line |
|---|---|---|
| `imageModeProbe()` | `{probeAt, imageModeActive, activeChipText, placeholder, ...}` | `geminiDomAdapter.js:504` |
| `attachmentProbe()` | `{probeAt, triggerFound, fileInputCount, menuOrPopoverOpen, attachmentAreaFound, ...}` | `geminiDomAdapter.js:780` |
| `captureConversationBaseline()` | `{capturedAt, userQueryCount, modelResponseCount, generatedImageCount, generatedImageSrcs[]}` | `geminiDomAdapter.js:2328` |
| `probeFileInputLifecycle(checkpointsMs)` | Observes `<input type=file>` mount over time | `geminiDomAdapter.js:3608` |
| `probeUploadFilesCandidates()` | Candidates in upload overlay | `geminiDomAdapter.js:3981` |
| `selfTest()` | Combined diagnostics (called from PING) | `geminiDomAdapter.js` |

**Reach them via PING** — content script's `GEMINI_ASSISTANT_PING` handler returns `{ok, url, selfTest}`.

---

## 6. End-to-end image generation flow (the master sequence)

```
1. sidepanel.js: user clicks "Generate Task"
2. sidepanel.js → sendToGemini(START_EXECUTION, {executionId, taskId, force:true})
   → content.js: creates activeExecution (AbortController + observers + timers)
3. sidepanel.js → orch.generateTask(taskId)
4. orchestrator: preflight() → send() → captureBaseline()
5. sidepanel.js → sendToGemini(INSERT_PROMPT)
   → RedSunDomAdapter.insertPromptIntoGemini(text)   [Quill API]
6. sidepanel.js → sendToGemini(SEND_COMPOSER)
   → click Send button
7. sidepanel.js → sendToGemini(DETECT_GENERATION_START)
   → poll body.innerText for /creating your image|criando sua imagem|画像を生成/
8. sidepanel.js → sendToGemini(WAIT_FOR_GENERATED_IMAGE)
   → scoreGeneratedImageCandidate(): reject src ∈ baseline, ignore if inside
     gem-media-attachment / mat-chip / input-area / rich-textarea
9. sidepanel.js → sendToGemini(FETCH_IMAGE) → returns Blob
10. sidepanel.js → sendToGemini(CLICK_OFFICIAL_DOWNLOAD) → blob-fallback
    OR  sidepanel.js → chrome.runtime.sendMessage(ARM_DOWNLOAD)
    then → sendMessage(DOWNLOAD_BLOB, ArrayBuffer)
11. SW: chrome.downloads.download({url: blob:..., filename, conflictAction})
    SW: onDeterminingFilename → rewrites to Downloads/Gemini Assistant/<project-id>/
    SW: onChanged → DOWNLOAD_STATE_CHANGED → side panel updates UI
12. sidepanel.js: on "complete" → task.status = "generated"
```

---

## 7. Next Task flow (v0.10.x)

```
1. orchestrator: complete → task-complete (markTaskComplete)
2. sidepanel.js receives phase=task-complete
3. beginConversationReset() → phase=resetting-conversation
4. sendToGemini(RESET_TO_CLEAN_CONVERSATION)
   → 3-tier fallback: _OPEN_NEW_TAB → _RELOAD_TAB → in-place location.assign
5. sendToGemini(WAIT_FOR_CLEAN_CONVERSATION)
   → re-probe composer until attachmentCount === 0 AND prompt === ""
6. endConversationReset() → phase=idle
7. sidepanel.js: advance currentTaskId to next task
8. runBatch: next loop iteration
```

**Watchdog timing:** 8s normal, 30s when `activeBlobFallback` is set (4s blob fetch + margin).

---

## 8. Known limitations (do NOT fix in a "drive-by" PR)

### `generatedImageCount` overcounts in `captureConversationBaseline`

**File:** `src/dom/geminiDomAdapter.js` (function `captureConversationBaseline`, ~line 2328)

```js
const allImgs = Array.from(document.querySelectorAll("img"));
const allSrcs = allImgs
  .map((i) => i.getAttribute("src") || i.src || "")
  .filter((s) => s.length > 0 && !s.startsWith("data:image/svg"));
// ...
generatedImageCount: allSrcs.length,
```

**Symptom:** baseline reports `generatedImageCount: 4` while `userQueryCount: 0` and `modelResponseCount: 0`. Likely includes:
- Gemini sparkle SVG (inline `data:image/svg+xml` — properly filtered)
- **Avatar do usuário** (raster `<img>`)
- Anexo placeholder thumbnail
- Histórico sidebar thumbnails
- Logos decorativos

**Downstream impact:** NONE for the actual generation flow — `scoreGeneratedImageCandidate` (line ~2378) compares the exact `src` string against `baseline.generatedImageSrcs`, so false positives in the count don't cause spurious "new image" matches.

**But:** the count is **misleading for diagnostics**. When reporting state in the side panel or to logs, this overcount can make a "no generation yet" page look like it has 4 baseline images.

**Module responsible:** `src/dom/geminiDomAdapter.js` — `captureConversationBaseline` and the `isInsideComposerOrQuery` helper that the score function relies on for filtering.

**Document, do NOT fix.** A proper fix would require maintaining a denylist of well-known UI assets (avatar selectors, history thumb selectors), which is fragile and Gemini-side. Track as a known limitation in this skill.

### Other known limitations (MEMORY)
- Lazy-init trap: `orchestrator` is module-scoped `let`, must be created via `createOrchestrator`. Forgetting `await ensureOrchestrator()` → "Orchestrator not ready".
- 3-tier reset race: if 8s watchdog fires while 4s blob-fallback is in flight, the reset aborts the download. Fix: 30s watchdog when `activeBlobFallback` set.
- After fixing any phase, **always ask the user to reload the extension** — Isamu routinely forgets to.

---

## 9. Evidence-first debugging discipline

**THE CENTRAL RULE of this codebase.** When a bug is reported:

### 1. Reproduce first — never edit code on hypothesis alone

Use the `chrome-devtools` skill + MCP to:

1. `install_extension` (if not loaded) at `/Users/isamumatsuyama/Documents/development/gemini-assistant`
2. `list_pages` to find the Gemini tab
3. `evaluate_script` in the Gemini tab's MAIN world to invoke probes directly:
   ```js
   globalThis.RedSunDomAdapter.selfTest()
   globalThis.RedSunDomAdapter.captureConversationBaseline?.()
   ```
4. `evaluate_script` in SW context to inspect `orchestrator.state` and `chrome.storage.local`:
   ```js
   const k = (await chrome.storage.local.get('state_v1')).state_v1;
   return {phase: window.__orchestratorState, storage: k};
   ```

### 2. Walk the chain to find FIRST divergence

Trace the suspect boundary in this order; **stop at the first EXPECTED ≠ OBSERVED**:

```
Side Panel UI
  ↓ onPhaseChange fired? phase matches intent?
Orchestrator
  ↓ state.phase correct? state.error set?
messaging.js sendToTab
  ↓ tabId resolved? payload serialized?
Content Script switch
  ↓ case matched? handler returned {ok:true}?
DOM Adapter probe
  ↓ candidate found? MutationObserver attached?
Gemini DOM
  ↓ selector matches? element visible?
Generation detection
  ↓ baseline captured correctly? score > threshold?
Download bridge
  ↓ blob OK? downloadId returned? onChanged fired?
State update
  ↓ task.status set? storage persisted?
Next Task
  ↓ conversation reset? phase → idle?
```

### 3. AVOID these anti-patterns

These only ever land as **workarounds for a misdiagnosed root cause**:

- ❌ Bumping timeouts / adding `setTimeout` / `await sleep(...)` to mask polling failures
- ❌ Adding new CSS selectors as "fallback" without explaining why the primary selector stopped matching
- ❌ Adding a second `if (probe)` branch alongside the existing one
- ❌ Modifying two files at once for a single reported symptom
- ❌ Increasing retry counts instead of finding the underlying race
- ❌ Editing `manifest.json` "just to add a permission" without verifying it solves the specific symptom

These are acceptable **only when justified by runtime evidence** (a log, a probe output, an MCP observation).

### 4. Required bug-report format

For every debugging session, fill this template before proposing a fix:

```yaml
BUG:                  <one-sentence symptom>
EXPECTED:             <what should happen per spec / docs>
OBSERVED:             <what actually happens, with concrete numbers>
LAST SUCCESSFUL STEP: <phase / probe / action that produced the last ok:true>
FIRST FAILED STEP:    <the very first place where EXPECTED ≠ OBSERVED>
RUNTIME EVIDENCE:
  - chrome-devtools MCP logs:
  - orchestrator.state snapshot:
  - chrome.storage.state_v1 snapshot:
  - DOM adapter selfTest() output:
  - Gemini DOM selector match counts:
ROOT CAUSE / TESTABLE HYPOTHESIS:
FILES INVOLVED:       <exact file:line ranges>
MINIMAL FIX:          <smallest change that addresses the divergence>
VERIFICATION:         <how to confirm the fix without rolling forward to "looks good">
```

`LAST SUCCESSFUL STEP` and `FIRST FAILED STEP` are the two most important fields — they pinpoint where the chain broke. If you cannot name both, you have not yet reproduced the bug.

### 5. Then — and only then — propose the fix

1. State the hypothesis in one sentence.
2. List the **exact** files + line ranges you'll change.
3. List the **verification steps** the user can run via `chrome-devtools` MCP to confirm.
4. Mention what existing test (`tests/run.js`) you should add a fixture for.

---

## 10. Quick triage commands (copy-paste)

### "Is the adapter alive?"
```js
// MCP evaluate_script in the Gemini tab
globalThis.RedSunDomAdapter?.selfTest?.()
```
Returns `{ok, url, ...probes}`. If undefined → adapter didn't load → check `manifest.json` order + console errors.

### "What phase is the orchestrator in?"
```js
// MCP evaluate_script in SW context
// (requires the side panel to have set window.__orchestratorState,
//  or use chrome.storage to read last-known phase)
chrome.storage.local.get('state_v1', s => console.log(JSON.stringify(s.state_v1, null, 2)))
```

### "Did the download actually fire?"
```js
// MCP evaluate_script in SW context
chrome.downloads.search({limit: 5}, list => console.log(JSON.stringify(list, null, 2)))
```

### "What did the content script see?"
```js
// MCP evaluate_script in the Gemini tab
globalThis.RedSunDomAdapter?.captureConversationBaseline?.()
```
Returns the overcounting baseline (see §8 limitation).

### "Is the file input mounted?"
```js
// MCP evaluate_script in the Gemini tab
Array.from(document.querySelectorAll('input[type="file"]')).map(i => ({
  accept: i.accept, multiple: i.multiple, hidden: i.hidden, parent: i.parentElement?.tagName
}))
```

---

## 11. Files this skill MUST NOT duplicate

This skill is a complement. It does not replace:

- **`chrome-devtools`** (loaded on demand): generic Chrome DevTools Protocol, MCP tool reference
- **`chrome-extensions`** (loaded on demand): generic MV3 patterns, manifest fields, lifecycle
- **`AGENTS.md`** (in repo root): Project JSON schema, asset folder rules, prompt composition

**Do NOT document in this skill:**
- CDP method names or MCP tool signatures → use `chrome-devtools`
- MV3 permission semantics → use `chrome-extensions`
- Schema v1/v2/v3 details for project.json → use `AGENTS.md`

**DO document here only:**
- This repo's specific architecture (§1-7)
- This repo's known limitations with file:line references (§8)
- The debugging discipline required here (§9)
- Project-specific probe names and their file:line locations (§5, §10)