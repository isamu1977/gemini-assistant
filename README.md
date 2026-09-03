# Gemini Assistant

> [!WARNING]
> **Status:** Projeto estacionado provisoriamente / Project temporarily on hold.
> O desenvolvimento deste projeto está pausado no momento.

> **Tech:** Plain JavaScript (Manifest V3 Side Panel) — no build step or bundler required.

**Gemini Assistant** is a Chrome extension that turns `gemini.google.com` into a structured, scriptable target for multi-scene creative workflows. It is driven by a **Project JSON**, a **bound local project folder**, and a **list of tasks**. 

It does **not** call the Gemini API and requires no backend. All interaction occurs directly through the Gemini web interface via a dedicated DOM adapter, controlled from a native Chrome Side Panel.

---

## Key Features

- **Full Single-Task Workflow:** 
  - Activates **Create Image** mode idempotently.
  - Automatically attaches reference images in the exact declared order.
  - Composes and inserts prompts (`masterPrompt` + aspect ratio + scene prompt).
  - **Prepare Task:** Prepares the composer and halts for user review.
  - **Generate Task:** Clicks Send, monitors generation progress, detects the official download button, downloads the result, and tracks file download completion via `chrome.downloads`.
- **Project & Asset Management:**
  - Local directory binding via File System Access API with automatic **wrong-root detection**.
  - Centralized asset catalog (`character`, `environment`, `style`, `object`, `other`).
- **Prompt Architecture (Schema v3):**
  - Central `masterPrompt` for art style, medium, and negative exclusions combined seamlessly with scene-specific prompts.
- **Task Lifecycle:**
  - Statuses: `pending` → `generated` (automatic upon download) → `approved` / `redo` (manual user review).
- **Diagnostics & Safety:**
  - Built-in DOM probe, attachment tracing, messaging validation, and acquisition watchdogs.

---

## Project Layout

```text
.
├── manifest.json                 # Manifest V3 configuration (Side Panel, permissions)
├── AGENTS.md                     # Specification guide for AI agents (Hermes Agent)
├── icons/                        # Extension icons (16, 48, 128 px)
├── src/
│   ├── sidepanel/                # Side Panel UI (HTML, CSS, JS orchestration)
│   ├── background/
│   │   └── service-worker.js     # Side Panel registration & chrome.downloads bridge
│   ├── content/
│   │   └── content.js            # Message bridge between Side Panel & DOM Adapter
│   ├── dom/
│   │   └── geminiDomAdapter.js   # ⭐ Sole point of contact with Gemini's DOM
│   ├── lib/
│   │   ├── project.js            # Project JSON schema (v1, v2, v3) & prompt composition
│   │   ├── messaging.js          # Tab discovery & structured message dispatch
│   │   ├── assets.js             # Asset resolver & wrong-root detection
│   │   ├── output.js             # Filename sanitization, slugification & path builder
│   │   └── storage.js            # chrome.storage.local persistence wrapper
│   └── workflow/
│       └── orchestrator.js       # Prepare/Generate state machine & lifecycle engine
├── examples/
│   ├── project-yuki-test.json    # Full Schema v3 test project with masterPrompt
│   ├── example-project-v2.json   # Schema v2 example with asset catalog
│   ├── example-project-v1.json   # Minimal legacy Schema v1 example
│   └── example-project.json      # Standard 5-task example
└── tests/
    ├── run.js                    # Pure-Node test runner (439 unit/regression tests)
    ├── fixtures/                 # JSON schema validation fixtures
    ├── e2e_*.py                  # Playwright DOM contract tests (mocked)
    └── MANUAL_TESTS_V0_6.md      # Manual test matrix
```

---

## Quick Start & Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (top right toggle).
4. Click **Load unpacked** and select this project directory.
5. Pin the **Gemini Assistant** extension icon to your toolbar.

> **Requirements:** Google Chrome 116+ (requires native `chrome.sidePanel` support).

---

## User Workflow

```text
┌─ Side Panel ──────────────────────────────────────────────────┐
│                                                                │
│   1. [ Import Project ]   ← Select your project.json (Schema v3)│
│   2. [ Bind folder... ]   ← Select folder containing references/│
│   3. [ Prepare Task ]     ← Mode + Attachments + Prompt → Review│
│   4. [ Generate Task ]    ← Preflight + Send + Detect + Download│
│                                                                │
│   Post-Generation:                                             │
│     [ Mark Approved ]  or  [ Mark Redo ]                       │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

1. Open `https://gemini.google.com` and sign in.
2. Click the **Gemini Assistant** icon to open the Side Panel.
3. Click **Import Project** and select a project JSON (e.g. `examples/project-yuki-test.json`).
4. Click **Bind folder…** and select the local project folder containing the `references/` directory.
5. Navigate through tasks with **Previous** / **Next** (or `Alt + ArrowLeft` / `Alt + ArrowRight`).
6. Click **Prepare Task** to mount the references and composite prompt in the composer without sending.
7. Click **Generate Task** to generate the image. The extension waits for the output, triggers the official download, saves the file to `Downloads/Gemini Assistant/<project-id>/<filename>.<ext>`, and marks the task `generated`.

---

## Project JSON Schemas

Gemini Assistant supports **Schema Versions 1, 2, and 3**. 

### Schema v3 (Current & Recommended)

Schema v3 introduces the `generation` block, enabling global style definitions that are automatically concatenated with per-task prompts:

```jsonc
{
  "schemaVersion": 3,
  "project": {
    "id": "yuki-onna-vol1",
    "name": "Yuki-onna Series",
    "description": "5-scene story"
  },
  "generation": {
    "masterPrompt": "Cinematic semi-realistic dark fantasy, muted charcoal and indigo palette...",
    "aspectRatio": "16:9",
    "sceneSeparator": "\n\nSCENE:\n"
  },
  "assets": {
    "char-yuki": {
      "label": "Yuki-onna Portrait",
      "type": "character", // character | environment | style | object | other
      "file": "references/character-main.png"
    }
  },
  "tasks": [
    {
      "id": "scene-001",
      "title": "First Snowfall",
      "prompt": "Wide establishing shot of a remote snowed-in mountain village at dusk...",
      "references": ["char-yuki"],
      "output": {
        "fileName": "scene-001-first-snowfall" // Optional (defaults to <id>-<slugified-title>)
      }
    }
  ]
}
```

> [!TIP]
> For a full specification on generating project files with AI Agents (such as **Hermes Agent**), see [AGENTS.md](file:///Users/isamumatsuyama/Documents/development/gemini-assistant/AGENTS.md).

---

## Architecture Overview

```text
Side Panel (UI)
  │  Uses projectLib, storageLib, assetsLib, outputLib, orchestratorLib
  │  Per-task state machine: idle → preparing → ready → generating → downloading → complete
  │  Batch (v0.9.0+): Generate All Pending drives runBatch() across all pending tasks
  ▼
Service Worker (Background)
  │  Manages Side Panel registration, chrome.downloads lifecycle,
  │  new-tab reset (GEMINI_ASSISTANT_OPEN_NEW_TAB), force-reload reset
  │  (GEMINI_ASSISTANT_RELOAD_TAB)
  ▼
Content Script (Runs in gemini.google.com)
  │  Message bridge (GEMINI_ASSISTANT_*) via src/lib/messaging.js
  ▼
Gemini DOM Adapter (src/dom/geminiDomAdapter.js)
  │  ⭐ Isolated DOM manipulation: composer input, file upload DataTransfer,
  │  mode toggle, response detection, official download button triggering
```

For details on the batch processing architecture (lifecycle, callbacks,
state, error handling, debugging), see [`docs/BATCH_PROCESSING.md`](docs/BATCH_PROCESSING.md). When the batch -> download -> rename pipeline breaks, start with [`docs/DIAGNOSTICO_BATCH_DOWNLOAD.md`](docs/DIAGNOSTICO_BATCH_DOWNLOAD.md) for an end-to-end flowchart and trace inspection guide..

---

## Testing & Verification

Run the comprehensive unit and regression suite:

```bash
node tests/run.js
```

**439 tests** verify:
- Project validation, schema parsing (v1, v2, v3), and composite prompt builder.
- Asset resolution, relative path safety, and wrong-root detection.
- Filename sanitization, title slugification, and path traversal rejection.
- Messaging protocol, watchdog timers, download lifecycle, and race condition recovery.

---

## Documentation

- **[`docs/BATCH_PROCESSING.md`](docs/BATCH_PROCESSING.md)** — Detailed architecture, lifecycle, and operational notes for the v0.9.0 Generate All Pending workflow.
- **[`AGENTS.md`](AGENTS.md)** — Authoritative specification for AI agents generating Project JSON packages for Gemini Assistant.
- **[`tests/MANUAL_TESTS_V0_6.md`](tests/MANUAL_TESTS_V0_6.md)** — Manual test matrix for end-to-end verification in a real Chrome browser.

## Release History Summary

- **v0.9.0 (Batch processing + per-task reliability):**
  - **Generate All Pending** — one-click batch that runs every pending task end-to-end (Prepare → Generate → Download → Reset chat) without manual intervention.
  - Live progress panel: counter, current task, current phase, animated progress bar, per-task results list, cancel button.
  - Three-tier conversation reset (new Gemini tab → force reload → in-place) for clean state between tasks.
  - Parallel blob-extraction fallback runs alongside the official Gemini download click so a broken Angular host still downloads the image.
  - 8s acquisition watchdog extends to 30s while the blob fallback is in flight.
  - 3-step confirm prompt (Stop / Skip / Retry) on per-task failure during the batch.
  - Structured `logWorkflow` entries everywhere (Debug panel surfaces real errors with stack traces).
  - Single canonical download path — removed the v0.6 `downloadImageViaServiceWorker` and `orch.download()` code paths.
  - Fixed long-standing `ReferenceError: cur is not defined` in `renderPreparationChecklist`.
- **v0.8.0+ / v0.9.x / v0.10.x:**
  - Official Gemini download button detection (`download-generated-image-button`) with synthetic events and blob fallback.
  - Automatic download completion tracking via `chrome.downloads.onChanged`.
  - Schema v3 support (`masterPrompt`, `aspectRatio`, `sceneSeparator`, composite prompt builder).
  - Filename slugification (`output.fileName` preference) and download watchdog timeouts.
- **v0.6.x:**
  - Automated single-task workflow (Prepare → Generate → Download).
  - Messaging stabilization with `src/lib/messaging.js`.
  - 12-step attachment diagnostics and tracing.
- **v0.5.x:**
  - Migration to Chrome Side Panel (`chrome.sidePanel`).
  - Folder binding with File System Access API and wrong-root detection.
- **v0.1.x – v0.4.x:**
  - Core DOM adapter, Quill editor replacement, asset catalog (Schema v2), and base state management.
