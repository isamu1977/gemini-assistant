# Batch Processing (v0.9.0+)

The batch processing workflow lets a user generate and download every
pending task in a project with one click, instead of clicking through
each task manually. The orchestrator drives the full lifecycle
(Prepare → Generate → Wait → Reset Chat) for every task and reports
progress in real time.

## User Flow

1. **Import a Project JSON** — single-project or multi-scene (Schema v3).
2. **Bind a local folder** containing the `references/` directory.
3. **Click `🚀 Generate All Pending`** in the workflow card.
4. A confirmation dialog lists the number of pending tasks.
5. The batch starts. The side panel surfaces a live progress card:
   - Header: `Batch: N/M` and current phase (`preparing` →
     `generating` → `downloading` → `resetting`).
   - Animated progress bar.
   - Stats: `✓ N completed`, `✕ N failed`, `↷ N skipped`.
   - A collapsible `<details>` with per-task results (filename,
     download id, error message if any).
   - `Cancel Batch` button — stops the batch cleanly after the current
     task finishes.
6. If a task fails, a 3-step native confirm prompt appears:
   - **OK** → Stop the batch.
   - **Cancel** → Skip this task and continue with the next.
   - **Esc** → Retry the same task once.
7. After the batch finishes, the status line shows the summary:
   - All green: `Batch complete: 5/5 (87s)`.
   - With errors: `Batch done with errors: 3 ok, 2 failed, 1 skipped`.
   - Cancelled: `Batch stopped: 3 done, 2 failed (54s)`.

## Architecture

### Orchestrator (`src/workflow/orchestrator.js`)

`runBatch(params)` is the single entry point.

```js
const summary = await orchestrator.runBatch({
  taskIds: ["scene-001", "scene-002", /* ... */],
  resetConversation: async () => true,
  shouldContinue: () => true,
  maxRetries: 1,           // default 2
  onBatchProgress: (e) => {},
  onBatchTaskComplete: (e) => {},
  onBatchPauseRequested: (e) => "stop" | "skip" | "retry",
  onBatchComplete: (summary) => {},
});
```

**Lifecycle per task:**
1. `reset({ id: taskId })` — clear execution-scoped state.
2. `prepareTask({ taskId, prompt: null })` — load references and prompt.
3. `generateTask({...})` — preflight, send, wait for image.
4. Poll `state.download.ok === true && status === "complete" &&
   Number.isInteger(downloadId)` (90s timeout).
5. `markTaskComplete()` — idempotent with the SW apply path.
6. `await resetConversation()` — side-panel-supplied callback that
   closes the current Gemini tab and opens a fresh one. Best-effort:
   a failed reset does not fail the task (image is already on disk).

**State (`state.batch`):**
```js
{
  active: true,            // batch is currently running
  paused: false,
  cancelled: false,
  taskIds: [...],
  currentIndex: -1,        // index of the currently-active task
  currentTaskId: null,
  currentPhase: "idle",    // preparing | generating | downloading | resetting
  completed: [{ taskId, index, downloadId, finalFilename, resetOk }],
  failed:    [{ taskId, index, error, attempts }],
  skipped:   [{ taskId, index, error }],
  startedAt: ms,
  finishedAt: ms | null,
  results: [{ taskId, status, downloadId, finalFilename, resetOk, error? }],
}
```

**Failure path:** when a task exhausts `maxRetries`, the orchestrator
calls `onBatchPauseRequested({ taskId, index, total, error })`. The
return value is interpreted as:

| Return | Effect |
|---|---|
| `"stop"` | Set `cancelled=true`, break the loop, fail the task. |
| `"skip"` | Mark as skipped, run `resetConversation` (best-effort), continue. |
| `"retry"` | Decrement `i`, retry the same task one more time. |

If the hook returns `null`/`undefined`, default is `"stop"`.

**Summary returned:**
```js
{
  ok: boolean,             // true when failed.length === 0 && !cancelled
  total: number,
  completed: number,
  failed: number,
  skipped: number,
  cancelled: boolean,
  cancelledReason: string | null,
  results: [...],
  startedAt: ms,
  finishedAt: ms,
  durationMs: number,
}
```

### Side Panel (`src/sidepanel/sidepanel.js`)

**New DOM refs:**
- `#generate-all-btn` — primary button (🚀 Generate All Pending).
- `#cancel-batch-btn` — ghost button (Cancel Batch), shown only while a
  batch is running.
- `#batch-progress` — panel with title, phase, bar, stats, results list.

**New functions:**
- `renderGenerateAllButton()` — show/hide based on
  `state.source.project && !orchestrator.state.batch.active`.
- `renderBatchProgress(info)` — updates the panel from a progress event.
- `renderBatchResults(info)` — rebuilds the `<ul>` from
  `orchestrator.state.batch.results`.
- `promptBatchFailure(info)` — 3-step confirm; returns
  `"stop" | "skip" | "retry"`.
- `onGenerateAll()` — collects pending tasks and calls
  `orchestrator.runBatch(...)`. Wires the Cancel Batch listener to flip
  `batchCancelled = true`; `shouldContinue` polls that flag.

### Reset callback wiring

The orchestrator does not own the "new tab" reset logic (that lives in
the Service Worker via `GEMINI_ASSISTANT_OPEN_NEW_TAB`). The side panel
supplies a `resetConversation` async function that wraps
`resetConversationAndAdvance({ advanceToNext: false, source: "batch-reset" })`
and returns `true` on success.

This keeps `runBatch` decoupled from the SW / side panel layering.

### HTML / CSS

- `src/sidepanel/sidepanel.html` — adds the `#generate-all-btn`,
  `#cancel-batch-btn`, and `#batch-progress` block under
  `.workflow-actions`.
- `src/sidepanel/sidepanel.css` — adds the `.batch-progress*` rules
  (animated bar, semantic colors for completed / failed / skipped).

### Tests (`tests/run.js`)

Five new tests cover the batch lifecycle:

1. **Happy path** — 3-task batch completes, 3 reset calls, summary
   shape correct.
2. **shouldContinue=false** — batch halts cleanly mid-flight.
3. **Pause returns stop** — handler that always returns "stop" causes
   the batch to halt on the first failure.
4. **Empty task list** — returns `{ ok:false, reason:"no-tasks" }`.
5. **Already-running guard** — second call returns
   `{ ok:false, reason:"batch-already-running" }`.

Result: **444/444 pass**.

## Operational Notes

- **Prepare Task prerequisite**: v0.9.10+ refuses to start a batch if
  `resolvedRefsCache` is empty. The user must run Prepare Task once on
  any task (binds the references folder, populates the ref cache) before
  Generate All Pending will function correctly. The button still
  triggers, but a confirmation dialog warns and recommends the user
  cancel, run Prepare Task, and try again.
- **Mid-batch cancellation**: the user can press Cancel Batch at any
  time. The orchestrator checks `batch.cancelled` between every
  internal phase transition (before each task, before each retry,
  during the download polling loop). The currently-running task always
  finishes before the batch exits.

- **State on batch failure**: if the batch is stopped on a task failure,
  the orchestrator's `state.batch` stays populated (with `active=false`)
  until the next `reset()` is called. The next batch can run normally.

- **Why sequential, not parallel**: the Gemini chat can only host one
  active generation at a time. Running tasks in parallel would conflict
  with the chat. The "new tab per task" reset trick only works
  sequentially.

- **Memory bounds**: `state.batch.results` retains every task's
  outcome. For very large projects (100+ tasks) this could grow large,
  but for typical Red Sun Japan projects (5-30 tasks per video) it's
  fine.

## Debugging

Open the Side Panel's debug card to see live `logWorkflow` events:

```
[info] Batch starting total=5 taskIds=["scene-001", ...]
[info] Batch task completed taskId="scene-001" status="completed" resetOk=true
[warn] Batch task completed taskId="scene-002" status="failed" error="..."
[info] Batch finished total=5 completed=4 failed=1 durationMs=87340
```

For each task, the SW traces the download flow with the usual
`chrome.downloads.onCreated-fired`, `chrome-download-complete`, etc.
