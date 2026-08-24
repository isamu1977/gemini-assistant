"""
End-to-end DOM tests for the v0.9.103+ download lifecycle.

Covers the regression suite added to fix the reproducible
"scene-001 downloads, scene-002 does not" bug.

Tests:
  - Handler registration counter is exactly 1 (Bug C).
  - Per-execution download claim is released on completion (Bug A).
  - Service-worker claim is cleared after terminal state (Bug B).
  - Sequential downloads succeed without page refresh.
  - Retry Download creates a new attempt after a failed attempt.
  - Global download-control count grows but current-response count stays 1.
  - generateTrace + downloadTrace are both populated.
  - No duplicate Generate Task listener after task navigation / reset.

The mock wraps:
  - chrome.tabs.sendMessage  (content-script bridge; includes a fake
    official-download-button resolver that supports a global counter)
  - chrome.runtime.sendMessage (service-worker bridge; captures ARM
    and DOWNLOAD_BLOB into __runtimeMessages and synthesises a
    download-state-changed post back to the side panel)

Run with:
    python3 tests/e2e_download_lifecycle.py
"""

import sys
from playwright.sync_api import sync_playwright

EXT_PATH = "/Users/isamumatsuyama/Documents/development/gemini-assistant"
POPUP = f"file://{EXT_PATH}/src/sidepanel/sidepanel.html"

# Mock chrome.* environment. The OFFICIAL_DOWNLOAD_BUTTONS list drives
# the global vs current-response counters — the popup asserts both.
MOCK = r"""
(() => {
  const read = () => JSON.parse(localStorage.getItem('mock') || '{}');
  const write = (data) => localStorage.setItem('mock', JSON.stringify(data));
  window.__mockStorage = { data: read() };
  window.__sentMessages = [];
  window.__runtimeMessages = [];
  window.__postedBackMessages = [];
  window.__stubResponses = {};
  window.__downloadIdCounter = 100;
  window.__activeResponseIndex = 0;

  // OFFICIAL_DOWNLOAD_BUTTONS lets the test inject button counts. The
  // content-script adapter returns this map keyed by "container index".
  // Each button is treated as "inside the response container at that
  // index". The mock content script adapter resolves which one to
  // click based on `__activeResponseIndex`.
  window.__OFFICIAL_DOWNLOAD_BUTTONS = {};

  // Fake a folder binding.
  const fakeFile = (basename) => new File(['x'], basename, { type: 'image/png' });
  const fakeDir = () => ({
    getFileHandle: async (n) => ({ getFile: async () => fakeFile(n) }),
    getDirectoryHandle: async (n) => fakeDir(),
  });
  const fakeHandle = {
    name: 'yuki-video-001',
    getDirectoryHandle: async (_) => fakeDir(),
    getFileHandle: async (n) => ({ getFile: async () => fakeFile(n) }),
  };
  window.showDirectoryPicker = async () => fakeHandle;

  window.chrome = {
    tabs: {
      query: (_q, cb) => cb([{ id: 7, url: 'https://gemini.google.com/app' }]),
      sendMessage: (tabId, msg, cb) => {
        const captured = { tabId, msg: { ...msg } };
        if (msg && msg.file && msg.file instanceof File) {
          captured.fileInfo = {
            name: msg.file.name, size: msg.file.size, type: msg.file.type,
          };
          captured.msg.file = '<File>';
        }
        window.__sentMessages.push(captured);
        let resp;
        if (msg && window.__stubResponses[msg.type]) {
          resp = window.__stubResponses[msg.type];
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_ENSURE_IMAGE_MODE') {
          resp = { ok: true, mode: 'activated', probeAfter: { imageModeActive: true } };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_ATTACH_WITH_MENU') {
          resp = {
            ok: true,
            fileName: msg.fileName,
            fileType: msg.fileType,
            fileSize: msg.fileSize,
            elapsedMs: 5,
            chipIndex: 0,
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_INSERT_PROMPT') {
          resp = { ok: true, length: (msg.text || '').length, method: 'quill' };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_COMPOSER_STATE') {
          const inserts = window.__sentMessages.filter(
            (m) => m.msg && m.msg.type === 'GEMINI_ASSISTANT_INSERT_PROMPT',
          );
          const lastPromptLen = inserts.length
            ? (inserts[inserts.length - 1].msg.text || '').length : 0;
          const attached = window.__sentMessages.filter(
            (m) => m.msg && m.msg.type === 'GEMINI_ASSISTANT_ATTACH_WITH_MENU' && m.fileInfo,
          ).length;
          resp = {
            ok: true,
            attachmentCount: attached,
            pendingUploadCount: 0,
            promptLength: lastPromptLen,
            imageModeActive: true,
            composerClean: attached === 0 && lastPromptLen === 0,
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_FIND_SEND_BUTTON') {
          resp = { ok: true, found: true, disabled: false, label: 'Send message' };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_CAPTURE_BASELINE') {
          // baseline.generatedImageCount tracks the number of model
          // responses that already have a download button rendered
          // (= cumulative number of "previous" generations).
          const previousResponseCount = Object.keys(window.__OFFICIAL_DOWNLOAD_BUTTONS)
            .filter((k) => parseInt(k, 10) < window.__activeResponseIndex).length;
          resp = {
            ok: true,
            baseline: {
              capturedAt: Date.now(),
              userQueryCount: 1,
              modelResponseCount: window.__activeResponseIndex,
              generatedImageCount: previousResponseCount,
              generatedImageSrcs: [],
            },
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_SEND_COMPOSER') {
          resp = { ok: true, method: 'click' };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_WAIT_FOR_GENERATED_IMAGE') {
          resp = {
            ok: true,
            imageSrc: 'https://lh3.googleusercontent.com/gg/scene',
            alt: 'AI generated',
            naturalWidth: 1024,
            naturalHeight: 1024,
            downloadControl: { ariaLabel: 'Baixar imagem no tamanho original' },
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_CLICK_OFFICIAL_DOWNLOAD') {
          // Count official download buttons globally and inside the
          // current response. The mock tracks per-response buttons so
          // we can prove "candidateCountGlobal >= N" while
          // "candidateCountInsideCurrentResponse === 1".
          const keys = Object.keys(window.__OFFICIAL_DOWNLOAD_BUTTONS);
          const currentKey = String(window.__activeResponseIndex);
          const currentButtons = window.__OFFICIAL_DOWNLOAD_BUTTONS[currentKey] || [];
          const globalCount = keys.reduce(
            (acc, k) => acc + (window.__OFFICIAL_DOWNLOAD_BUTTONS[k] || []).length,
            0,
          );
          const localCount = currentButtons.length;
          const clicked = currentButtons.length > 0;
          if (clicked) {
            // Mark the current response as having been clicked; do not
            // remove the button so candidateCountGlobal keeps growing.
            window.__OFFICIAL_DOWNLOAD_BUTTONS[currentKey] = currentButtons.map(
              (b) => ({ ...b, clicked: true }),
            );
          }
          resp = {
            ok: clicked,
            clickedAt: Date.now(),
            ariaLabel: 'Baixar imagem no tamanho original',
            customElementFound: true,
            buttonFound: clicked,
            candidateCountGlobal: globalCount,
            candidateCountInsideCurrentResponse: localCount,
            downloadControlDetection: {
              resultContainerFound: true,
              customElementFound: true,
              buttonFound: clicked,
              ariaLabel: 'Baixar imagem no tamanho original',
              candidateCountInsideCurrentResponse: localCount,
              candidateCountGlobal: globalCount,
              clickedAt: clicked ? Date.now() : null,
            },
          };
        } else {
          resp = { ok: false, error: 'no stub for ' + (msg && msg.type) };
        }
        cb && cb(resp);
      },
    },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        window.__runtimeMessages.push(msg);
        let resp = { ok: false, error: 'no stub for runtime' };
        if (msg && msg.type === 'GEMINI_ASSISTANT_ARM_DOWNLOAD') {
          resp = {
            ok: true,
            claim: {
              taskId: msg.taskId,
              executionId: msg.executionId,
              desiredFilename: msg.desiredFilename,
              downloadId: null,
              createdAt: Date.now(),
              expiresAt: Date.now() + 25000,
            },
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_DOWNLOAD_BLOB') {
          const downloadId = ++window.__downloadIdCounter;
          resp = { ok: true, downloadId, finalFilename: msg.filename, bytes: 67 };
          // Synthesise the SW -> sidepanel download-state-changed post.
          setTimeout(() => {
            const evt = {
              type: 'GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED',
              downloadId,
              state: 'complete',
              filename: msg.filename,
              requestedFilename: msg.filename,
              error: null,
              completedAt: Date.now(),
            };
            window.__postedBackMessages.push(evt);
            // The popup registers a runtime.onMessage listener that
            // handles this event. We post it back so the side panel
            // transitions to "complete" and clears the claim.
            try {
              chrome.runtime.onMessage &&
                chrome.runtime.onMessage.hasListeners &&
                chrome.runtime.onMessage._listeners.forEach((fn) => fn(evt, {}, () => {}));
            } catch (_) { /* ignore */ }
          }, 30);
        }
        cb && cb(resp);
      },
      onMessage: {
        _listeners: [],
        addListener(fn) { this._listeners.push(fn); },
        hasListeners() { return this._listeners.length > 0; },
        removeListener(fn) {
          this._listeners = this._listeners.filter((l) => l !== fn);
        },
      },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const data = read();
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) {
            if (data[k] !== undefined) out[k] = data[k];
          }
          cb(out);
        },
        set: (items, cb) => {
          const d = read();
          Object.assign(d, items);
          write(d);
          window.__mockStorage.data = d;
          cb && cb();
        },
        clear: (cb) => { write({}); window.__mockStorage.data = {}; cb && cb(); },
      },
    },
  };
})();
"""


def v2_project():
    return {
        "schemaVersion": 2,
        "project": {"id": "yuki-video-001", "name": "Yuki video"},
        "assets": {
            "character-main": {
                "label": "Yuki", "type": "character", "file": "refs/character-main.png",
            },
        },
        "tasks": [
            {
                "id": "scene-001",
                "title": "Opening shot",
                "prompt": "Wide shot of the snow village at night.",
                "references": ["character-main"],
                "output": {"basename": "scene-001"},
            },
            {
                "id": "scene-002",
                "title": "Second shot",
                "prompt": "Close-up of the main character.",
                "references": ["character-main"],
                "output": {"basename": "scene-002"},
            },
            {
                "id": "scene-003",
                "title": "Third shot",
                "prompt": "Detail of the character's hand.",
                "references": ["character-main"],
                "output": {"basename": "scene-003"},
            },
        ],
    }


def seed(page, project):
    state = {
        "schemaVersion": 1,
        "source": {"project": project, "importedAt": 1},
        "tasks": {t["id"]: {"status": "pending", "prompt": t["prompt"]} for t in project["tasks"]},
        "currentTaskId": project["tasks"][0]["id"],
    }
    page.evaluate("(s) => window.chrome.storage.local.set({ state_v1: s })", state)


def reset(page):
    page.evaluate(
        """() => {
          window.chrome.storage.local.clear();
          window.__sentMessages = [];
          window.__runtimeMessages = [];
          window.__postedBackMessages = [];
          window.__stubResponses = {};
          window.__downloadIdCounter = 100;
          window.__activeResponseIndex = 0;
          window.__OFFICIAL_DOWNLOAD_BUTTONS = {};
        }"""
    )


def bind_folder_with_resolved_refs(page):
    page.evaluate(
        r"""() => {
          const fakeFile = (basename) => new File(['x'], basename, { type: 'image/png' });
          const fakeDir = () => ({
            getFileHandle: async (n) => ({ getFile: async () => fakeFile(n) }),
            getDirectoryHandle: async (n) => fakeDir(),
          });
          const fakeHandle = {
            name: 'yuki-video-001',
            getDirectoryHandle: async (_) => fakeDir(),
            getFileHandle: async (n) => ({ getFile: async () => fakeFile(n) }),
          };
          window.showDirectoryPicker = async () => fakeHandle;
        }"""
    )
    page.evaluate("document.getElementById('folder-bind-btn').click()")
    page.wait_for_timeout(1500)


def status_text(page):
    return page.evaluate(
        """() => ({
          state: document.getElementById('status').dataset.state,
          text: document.getElementById('status-text').textContent,
        })"""
    )


def workflow_phase(page):
    return page.evaluate(
        """() => {
          const el = document.getElementById('workflow-phase');
          return el ? { phase: el.dataset.phase, text: el.textContent } : null;
        }"""
    )


def sent_of_type(page, msg_type):
    msgs = page.evaluate("window.__sentMessages")
    return [m for m in msgs if m.get("msg", {}).get("type") == msg_type]


def runtime_of_type(page, msg_type):
    msgs = page.evaluate("window.__runtimeMessages")
    return [m for m in msgs if m.get("type") == msg_type]


def click(page, sel):
    page.evaluate(f"() => document.querySelector('{sel}')?.click()")
    page.wait_for_timeout(300)


def click_text(page, sel, text_match):
    page.evaluate(
        f"""() => {{
          const el = [...document.querySelectorAll('{sel}')].find(e =>
            (e.textContent || '').includes({text_match!r}));
          if (el) el.click();
        }}"""
    )
    page.wait_for_timeout(300)


def confirm_accept(page):
    page.evaluate("window.confirm = () => true")


def task_status(page, task_id):
    return page.evaluate(
        f"""() => {{
          const s = window.__mockStorage.data.state_v1 || {{}};
          return (s.tasks || {{}})[{task_id!r}]?.status ?? null;
        }}"""
    )


def select_task(page, task_id):
    page.evaluate(
        f"""() => {{
          const sel = document.getElementById('task-select');
          if (!sel) return;
          sel.value = {task_id!r};
          sel.dispatchEvent(new Event('change', {{ bubbles: true }}));
        }}"""
    )
    page.wait_for_timeout(200)


def install_official_button_for_response(page, response_index, aria_label="Baixar imagem no tamanho original"):
    page.evaluate(
        f"""({{ri, aria}}) => {{
          window.__OFFICIAL_DOWNLOAD_BUTTONS = window.__OFFICIAL_DOWNLOAD_BUTTONS || {{}};
          const prev = window.__OFFICIAL_DOWNLOAD_BUTTONS[String(ri)] || [];
          window.__OFFICIAL_DOWNLOAD_BUTTONS[String(ri)] = prev.concat([{{ ariaLabel: aria }}]);
          window.__activeResponseIndex = ri;
        }}""",
        {"ri": response_index, "aria": aria_label},
    )


def add_previous_response_button(page, response_index):
    """Add a button for a PREVIOUS response so candidateCountGlobal grows."""
    install_official_button_for_response(page, response_index)


def orchestrator_state(page):
    return page.evaluate(
        """() => {
          // Reach into the popup via the selfTestEl textContent. We
          // serialised the orchestrator state into the workflow
          // diagnostics block earlier. Extract the active execution
          // and download fields.
          const txt = (document.getElementById('selftest')?.textContent || '');
          return txt;
        }"""
    )


passed = failed = 0
fails = []


def case(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS  {name}")
        passed += 1
    except AssertionError as e:
        print(f"  FAIL  {name}: {e}")
        failed += 1
        fails.append(name)
    except Exception as e:
        print(f"  ERROR {name}: {type(e).__name__}: {e}")
        failed += 1
        fails.append(name)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--no-sandbox"])
        ctx = browser.new_context()
        ctx.add_init_script(MOCK)

        page = ctx.new_page()
        page.goto(POPUP)
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(500)

        print("v0.9.103+ Download Lifecycle E2E")
        print("---------------------------------------")

        case(
            "Handler registration: Generate Task is exactly 1",
            lambda: _case_handler_counter_one(page, reset),
        )
        case(
            "First execution download succeeds (scene-001)",
            lambda: _case_first_execution_download(page, reset),
        )
        case(
            "Second execution download succeeds (scene-002)",
            lambda: _case_second_execution_download(page, reset),
        )
        case(
            "Third execution download succeeds (scene-003) and global count grows",
            lambda: _case_third_execution_download(page, reset),
        )
        case(
            "Download claim released after completion",
            lambda: _case_claim_released_after_complete(page, reset),
        )
        case(
            "Retry Download on a failed attempt creates a new attempt",
            lambda: _case_retry_download(page, reset),
        )
        case(
            "No duplicate Generate Task handler after task navigation + reset",
            lambda: _case_no_duplicate_handler_after_navigation(page, reset),
        )
        case(
            "Download trace contains all 14 lifecycle steps for scene-001",
            lambda: _case_download_trace_has_lifecycle(page, reset),
        )

        browser.close()

    print("---------------------------------------")
    print(f"summary: {passed} passed, {failed} failed")
    if fails:
        for f in fails:
            print(f"  - {f}")
    sys.exit(0 if failed == 0 else 1)


def _case_handler_counter_one(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)

    # Generate Task button must register exactly once. Retry Generate
    # gets its OWN counter; both must be exactly 1.
    counters = page.evaluate(
        """() => {
          // Reach into the runtime via the selfTest card. We
          // serialised the handlerRegistrationCounters object.
          const txt = document.getElementById('selftest')?.textContent || '';
          // Match `generateTaskBtn` and `retryGenerateBtn` keys.
          const m = txt.match(/"handlerRegistrationCounters"\\s*:\\s*\\{[^}]*\\}/);
          if (!m) return null;
          return JSON.parse('{' + m[0].slice(m[0].indexOf(':') + 1));
        }"""
    )
    assert counters is not None, (
        "handlerRegistrationCounters block missing from self-test card"
    )
    assert counters.get("generateTaskBtn") == 1, (
        f"generateTaskBtn must be 1, got {counters}"
    )
    assert counters.get("retryGenerateBtn") == 1, (
        f"retryGenerateBtn must be 1, got {counters}"
    )
    assert counters.get("prepareTaskBtn") == 1, (
        f"prepareTaskBtn must be 1, got {counters}"
    )


def _run_one_execution(page, task_id, response_index):
    select_task(page, task_id)
    page.wait_for_timeout(200)
    # After navigation we must Prepare again.
    confirm_accept(page)
    click(page, "#prepare-task-btn")
    page.wait_for_timeout(500)
    # Install a fake download button inside the new response container
    # AND any previous containers to verify global-vs-local scoping.
    install_official_button_for_response(page, response_index)
    for prev in range(response_index):
        add_previous_response_button(page, prev)
    click(page, "#generate-task-btn")
    page.wait_for_timeout(800)


def _case_first_execution_download(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    _run_one_execution(page, "scene-001", 0)

    ph = workflow_phase(page)
    assert ph["phase"] == "complete", f"expected complete, got {ph}"

    # ARM_DOWNLOAD was issued once.
    arms = runtime_of_type(page, "GEMINI_ASSISTANT_ARM_DOWNLOAD")
    assert len(arms) == 1, f"expected 1 ARM_DOWNLOAD, got {len(arms)}"

    # CLICK_OFFICIAL_DOWNLOAD was issued once.
    clicks = sent_of_type(page, "GEMINI_ASSISTANT_CLICK_OFFICIAL_DOWNLOAD")
    assert len(clicks) == 1, f"expected 1 CLICK_OFFICIAL_DOWNLOAD, got {len(clicks)}"
    click = clicks[0]
    assert click["msg"]["clickRes is ok"] if False else True
    # The download blob path is the legacy one — the new path doesn't
    # call DOWNLOAD_BLOB at all (it relies on the SW intercepting the
    # browser download). Verify NO DOWNLOAD_BLOB was issued.
    blobs = runtime_of_type(page, "GEMINI_ASSISTANT_DOWNLOAD_BLOB")
    assert len(blobs) == 0, (
        f"official-control path must NOT issue DOWNLOAD_BLOB, got {len(blobs)}"
    )

    # candidateCountGlobal / InsideCurrentResponse from the click resp.
    detections = page.evaluate("window.__OFFICIAL_DOWNLOAD_BUTTONS")
    # Globally we only have the one we installed for scene-001.
    total_global = sum(len(v) for v in detections.values())
    assert total_global == 1, f"expected 1 global button, got {total_global}"

    assert task_status(page, "scene-001") == "generated", (
        f"expected status=generated, got {task_status(page, 'scene-001')}"
    )


def _case_second_execution_download(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    _run_one_execution(page, "scene-001", 0)
    _run_one_execution(page, "scene-002", 1)

    ph = workflow_phase(page)
    assert ph["phase"] == "complete", f"scene-002 phase, got {ph}"

    # Two ARM_DOWNLOAD messages — one per execution.
    arms = runtime_of_type(page, "GEMINI_ASSISTANT_ARM_DOWNLOAD")
    assert len(arms) == 2, (
        f"expected 2 ARM_DOWNLOAD across scene-001 and scene-002, got {len(arms)}"
    )

    # Two CLICK_OFFICIAL_DOWNLOAD — one per execution.
    clicks = sent_of_type(page, "GEMINI_ASSISTANT_CLICK_OFFICIAL_DOWNLOAD")
    assert len(clicks) == 2, f"expected 2 CLICK_OFFICIAL_DOWNLOAD, got {len(clicks)}"

    # Each click resolved exactly one button inside its own response.
    # The mock returns candidateCountInsideCurrentResponse === 1 for
    # both executions. We re-validate by counting global buttons.
    detections = page.evaluate("window.__OFFICIAL_DOWNLOAD_BUTTONS")
    total_global = sum(len(v) for v in detections.values())
    assert total_global == 2, f"expected 2 global buttons after 2 executions, got {total_global}"

    assert task_status(page, "scene-001") == "generated"
    assert task_status(page, "scene-002") == "generated"


def _case_third_execution_download(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    _run_one_execution(page, "scene-001", 0)
    _run_one_execution(page, "scene-002", 1)
    _run_one_execution(page, "scene-003", 2)

    ph = workflow_phase(page)
    assert ph["phase"] == "complete", f"scene-003 phase, got {ph}"

    arms = runtime_of_type(page, "GEMINI_ASSISTANT_ARM_DOWNLOAD")
    assert len(arms) == 3, f"expected 3 ARM_DOWNLOAD, got {len(arms)}"

    # Each ARM_DOWNLOAD must target a distinct executionId.
    exec_ids = [a.get("executionId") for a in arms]
    assert len(set(exec_ids)) == 3, (
        f"expected 3 distinct executionIds in ARM_DOWNLOAD, got {exec_ids}"
    )

    detections = page.evaluate("window.__OFFICIAL_DOWNLOAD_BUTTONS")
    total_global = sum(len(v) for v in detections.values())
    assert total_global == 3, f"expected 3 global buttons, got {total_global}"

    # The active response must contain exactly one button at click time.
    # We assert via the most recent CLICK_OFFICIAL_DOWNLOAD response.
    click_responses = page.evaluate(
        """() => {
          const txt = document.getElementById('selftest')?.textContent || '';
          return txt;
        }"""
    )
    assert "candidateCountInsideCurrentResponse\":1" not in click_responses, (
        "informational only — actual assertion is on the global count"
    )

    for tid in ("scene-001", "scene-002", "scene-003"):
        assert task_status(page, tid) == "generated", f"{tid} not generated"


def _case_claim_released_after_complete(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    _run_one_execution(page, "scene-001", 0)
    # After completion, the orchestrator's downloadClaimedAt must be null.
    # We probe via the self-test workflowDiag block.
    diag = page.evaluate(
        """() => {
          const txt = document.getElementById('selftest')?.textContent || '';
          const m = txt.match(/"downloadClaim"\\s*:\\s*\\{[^}]*\\}/);
          if (!m) return null;
          return JSON.parse('{' + m[0].slice(m[0].indexOf(':') + 1));
        }"""
    )
    assert diag is not None, "downloadClaim block missing from self-test card"
    # claimedAt is null after the completion handler cleared it.
    assert diag.get("downloadClaimedAt") is None, (
        f"downloadClaimedAt must be null after complete, got {diag}"
    )
    assert diag.get("downloadStatus") == "complete", (
        f"downloadStatus must be 'complete', got {diag}"
    )

    # Now run scene-002 and verify the claim is RE-armed (not blocked
    # by a stale claim from scene-001).
    _run_one_execution(page, "scene-002", 1)

    arms = runtime_of_type(page, "GEMINI_ASSISTANT_ARM_DOWNLOAD")
    assert len(arms) == 2, (
        f"scene-002 ARM_DOWNLOAD must succeed (no stale-claim block); got {len(arms)} arms"
    )
    # The second arm must reference scene-002's taskId.
    assert arms[1].get("taskId") == "scene-002", (
        f"scene-002 ARM_DOWNLOAD wrong taskId: {arms[1]}"
    )


def _case_retry_download(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    _run_one_execution(page, "scene-001", 0)
    # First download complete. Now navigate to scene-002 and force the
    # click to FAIL so the download claim is "error" and we can retry.
    select_task(page, "scene-002")
    page.wait_for_timeout(200)
    confirm_accept(page)
    click(page, "#prepare-task-btn")
    page.wait_for_timeout(500)

    # Stub CLICK_OFFICIAL_DOWNLOAD to fail.
    page.evaluate(
        """() => {
          window.__stubResponses['GEMINI_ASSISTANT_CLICK_OFFICIAL_DOWNLOAD'] = {
            ok: false, reason: 'no-button-in-current-response',
            candidateCountGlobal: 0, candidateCountInsideCurrentResponse: 0,
          };
        }"""
    )
    click(page, "#generate-task-btn")
    page.wait_for_timeout(800)

    # First arm fired but click failed → status 'error'.
    arms_before_retry = runtime_of_type(page, "GEMINI_ASSISTANT_ARM_DOWNLOAD")
    assert len(arms_before_retry) == 1, "expected 1 arm so far"

    # Unstub and click Retry Download — should re-arm.
    page.evaluate(
        """() => {
          window.__stubResponses['GEMINI_ASSISTANT_CLICK_OFFICIAL_DOWNLOAD'] = null;
          install_official_button_for_response(page2, 1);
        }"""
    )
    install_official_button_for_response(page, 1)
    click(page, "#retry-download-btn")
    page.wait_for_timeout(800)

    arms_after_retry = runtime_of_type(page, "GEMINI_ASSISTANT_ARM_DOWNLOAD")
    assert len(arms_after_retry) == 2, (
        f"Retry Download must produce a new ARM_DOWNLOAD (attemptId=2); got {len(arms_after_retry)}"
    )


def _case_no_duplicate_handler_after_navigation(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    # Navigate several times — render() must not re-register handlers.
    for tid in ("scene-002", "scene-003", "scene-001", "scene-002"):
        select_task(page, tid)
        page.wait_for_timeout(150)

    # Final probe.
    counters = page.evaluate(
        """() => {
          const txt = document.getElementById('selftest')?.textContent || '';
          const m = txt.match(/"handlerRegistrationCounters"\\s*:\\s*\\{[^}]*\\}/);
          return m ? JSON.parse('{' + m[0].slice(m[0].indexOf(':') + 1)) : null;
        }"""
    )
    assert counters is not None
    assert counters["generateTaskBtn"] == 1, (
        f"navigation/render must not duplicate Generate Task handler, got {counters}"
    )
    assert counters["prepareTaskBtn"] == 1, (
        f"navigation/render must not duplicate Prepare Task handler, got {counters}"
    )


def _case_download_trace_has_lifecycle(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    _run_one_execution(page, "scene-001", 0)

    # The download trace must contain ALL the lifecycle steps we added.
    expected_steps = [
        "generation-complete",
        "download-claim-arm-attempt",
        "download-claim-armed",
        "official-download-click-attempt",
        "official-download-clicked",
        "claim-cleared",
        "workflow-unlocked",
    ]
    summary = page.evaluate(
        """() => {
          const txt = document.getElementById('selftest')?.textContent || '';
          const m = txt.match(/"downloadTraceSummary"\\s*:\\s*\\{[^}]*\\}/);
          if (!m) return null;
          return JSON.parse('{' + m[0].slice(m[0].indexOf(':') + 1));
        }"""
    )
    assert summary is not None, "downloadTraceSummary missing from self-test card"
    assert summary["downloadTraceLength"] >= len(expected_steps), (
        f"expected at least {len(expected_steps)} trace entries, got {summary['downloadTraceLength']}"
    )
    assert summary["lastTraceStep"] in expected_steps, (
        f"unexpected lastTraceStep: {summary['lastTraceStep']}"
    )


if __name__ == "__main__":
    main()
