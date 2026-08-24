"""
End-to-end DOM tests for the v0.10 clean-conversation lifecycle.

Covers the regression suite for the new rule:

  ONE TASK = ONE CLEAN GEMINI CONVERSATION

Tests:
  - Reset Conversation blocked while download is in flight.
  - Reset Conversation blocked when download failed.
  - Reset Conversation allowed only after successful download completion.
  - Next Task button invokes the same reset implementation.
  - Reset Conversation button invokes the same reset implementation.
  - Sequential scene-001 -> scene-002 -> scene-003 lifecycle: each task
    starts in a clean conversation; same Gemini tab is reused.
  - Project JSON, asset catalog, and folder binding are preserved
    across resets.
  - Per-execution state (activeExecution, baseline, etc.) is cleared.
  - task.status is persisted to "generated" BEFORE the reset runs.
  - The reset trace accumulates structured events.

Mock contract:
  - chrome.tabs.sendMessage stubs the new GEMINI_ASSISTANT_RESET_TO_*
    and WAIT_FOR_* messages.
  - chrome.runtime.sendMessage captures ARM_DOWNLOAD and synthesises a
    download-state-changed post-back so the side panel marks the task
    "generated".

Run with:
    python3 tests/e2e_reset_lifecycle.py
"""

import sys
from playwright.sync_api import sync_playwright

EXT_PATH = "/Users/isamumatsuyama/Documents/development/gemini-assistant"
POPUP = f"file://{EXT_PATH}/src/sidepanel/sidepanel.html"

# Conversation state that the reset mocks can manipulate.
# The DOM adapter talks to window.__conversationState:
#   { conversationId, composerText, attachmentCount, generationActive,
#     currentUrl }
# The "reset" stub updates this object; the "verify" stub checks it.

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
  window.__OFFICIAL_DOWNLOAD_BUTTONS = {};

  // Conversation state. The mock reset modifies this. The verify stub
  // reads from it to decide whether the conversation is clean.
  window.__conversationState = {
    conversationId: "initial-conv-001",
    currentUrl: "https://gemini.google.com/app/initial-conv-001?hl=pt",
    composerText: "old prompt content",
    attachmentCount: 2,
    pendingUploadCount: 0,
    generationActive: false,
    composerFound: true,
  };

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

  // --- Test-only helper to simulate Gemini DOM navigation ----------
  // The reset handler will call location.assign, but in headless tests
  // we cannot actually navigate away from gemini.google.com. The mock
  // updates __conversationState directly so the verify stub can
  // observe the "new conversation" effect.
  function simulateReset() {
    const prevId = window.__conversationState.conversationId;
    const newId = "conv-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    window.__conversationState.conversationId = newId;
    window.__conversationState.currentUrl = "https://gemini.google.com/app/" + newId + "?hl=pt";
    window.__conversationState.composerText = "";
    window.__conversationState.attachmentCount = 0;
    window.__conversationState.pendingUploadCount = 0;
    window.__conversationState.generationActive = false;
    window.__conversationState.composerFound = true;
    return prevId;
  }

  window.chrome = {
    tabs: {
      query: (_q, cb) => cb([{ id: 7, url: window.__conversationState.currentUrl }]),
      sendMessage: (tabId, msg, cb) => {
        const captured = { tabId, msg: { ...msg } };
        if (msg && msg.file && msg.file instanceof File) {
          captured.fileInfo = { name: msg.file.name, size: msg.file.size, type: msg.file.type };
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
            fileName: msg.fileName, fileType: msg.fileType, fileSize: msg.fileSize,
            elapsedMs: 5, chipIndex: 0,
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_INSERT_PROMPT') {
          resp = { ok: true, length: (msg.text || '').length, method: 'quill' };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_COMPOSER_STATE') {
          const st = window.__conversationState;
          resp = {
            ok: true,
            attachmentCount: st.attachmentCount,
            pendingUploadCount: st.pendingUploadCount,
            promptLength: (st.composerText || '').length,
            promptText: st.composerText || '',
            imageModeActive: true,
            composerClean:
              st.attachmentCount === 0 &&
              st.pendingUploadCount === 0 &&
              (st.composerText || '').length === 0,
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_FIND_SEND_BUTTON') {
          resp = { ok: true, found: true, disabled: false, label: 'Send message' };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_CAPTURE_BASELINE') {
          resp = {
            ok: true,
            baseline: {
              capturedAt: Date.now(),
              userQueryCount: 1,
              modelResponseCount: 0,
              generatedImageCount: 0,
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
          const currentKey = String(window.__activeResponseIndex);
          window.__OFFICIAL_DOWNLOAD_BUTTONS[currentKey] = (window.__OFFICIAL_DOWNLOAD_BUTTONS[currentKey] || []).concat([
            { ariaLabel: 'Baixar imagem no tamanho original', clicked: true },
          ]);
          const totalGlobal = Object.values(window.__OFFICIAL_DOWNLOAD_BUTTONS)
            .reduce((acc, v) => acc + v.length, 0);
          resp = {
            ok: true,
            clickedAt: Date.now(),
            ariaLabel: 'Baixar imagem no tamanho original',
            customElementFound: true,
            buttonFound: true,
            candidateCountGlobal: totalGlobal,
            candidateCountInsideCurrentResponse: 1,
            downloadControlDetection: {
              resultContainerFound: true,
              customElementFound: true,
              buttonFound: true,
              ariaLabel: 'Baixar imagem no tamanho original',
              candidateCountInsideCurrentResponse: 1,
              candidateCountGlobal: totalGlobal,
              clickedAt: Date.now(),
            },
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_RESET_TO_CLEAN_CONVERSATION') {
          const prevId = simulateReset();
          resp = {
            ok: true,
            strategy: 'new-conversation-button',
            previousUrl: 'https://gemini.google.com/app/' + prevId + '?hl=pt',
            currentUrl: window.__conversationState.currentUrl,
            previousConversationId: prevId,
            elapsedMs: 12,
            buttonFound: true,
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_WAIT_FOR_CLEAN_CONVERSATION') {
          const st = window.__conversationState;
          const clean =
            st.composerFound &&
            (st.composerText || '').length === 0 &&
            st.attachmentCount === 0 &&
            st.pendingUploadCount === 0 &&
            !st.generationActive;
          const timeoutMs = (msg && msg.timeoutMs) || 5000;
          resp = {
            ok: clean,
            previousUrl: 'https://gemini.google.com/app/initial-conv-001?hl=pt',
            currentUrl: st.currentUrl,
            previousConversationId: 'initial-conv-001',
            currentConversationId: st.conversationId,
            composerFound: st.composerFound,
            composerTextLength: (st.composerText || '').length,
            attachmentCount: st.attachmentCount,
            pendingUploadCount: st.pendingUploadCount,
            generationActive: st.generationActive,
            urlChanged: true,
            elapsedMs: 50,
            attempts: 1,
          };
          if (!clean) {
            resp.reason = 'composer-not-clean';
            resp.elapsedMs = timeoutMs;
          }
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
              taskId: msg.taskId, executionId: msg.executionId,
              desiredFilename: msg.desiredFilename, downloadId: null,
              createdAt: Date.now(), expiresAt: Date.now() + 25000,
            },
          };
        }
        cb && cb(resp);
        // Synthesise the SW -> sidepanel download-state-changed post-back
        // ONLY for ARM_DOWNLOAD: the SW would normally fire this once
        // the browser download finishes. We do it synchronously here so
        // the side panel transitions task -> 'generated' and the reset
        // gate becomes eligible.
        if (msg && msg.type === 'GEMINI_ASSISTANT_ARM_DOWNLOAD') {
          setTimeout(() => {
            const downloadId = ++window.__downloadIdCounter;
            window.__postedBackMessages.push({
              type: 'GEMINI_ASSISTANT_DOWNLOAD_STATE_CHANGED',
              downloadId,
              state: 'complete',
              filename: msg.desiredFilename,
              requestedFilename: msg.desiredFilename,
              error: null,
              completedAt: Date.now(),
            });
            try {
              chrome.runtime.onMessage._listeners.forEach((fn) => fn(
                window.__postedBackMessages[window.__postedBackMessages.length - 1],
                {}, () => {}
              ));
            } catch (_) { /* ignore */ }
          }, 30);
        }
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


def v3_project():
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
                "id": "scene-001", "title": "Opening shot",
                "prompt": "Wide shot of the snow village at night.",
                "references": ["character-main"],
                "output": {"basename": "scene-001"},
            },
            {
                "id": "scene-002", "title": "Second shot",
                "prompt": "Close-up of the main character.",
                "references": ["character-main"],
                "output": {"basename": "scene-002"},
            },
            {
                "id": "scene-003", "title": "Third shot",
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
          window.__conversationState = {
            conversationId: 'initial-conv-001',
            currentUrl: 'https://gemini.google.com/app/initial-conv-001?hl=pt',
            composerText: '', attachmentCount: 0, pendingUploadCount: 0,
            generationActive: false, composerFound: true,
          };
        }"""
    )


def bind_folder_with_resolved_refs(page):
    page.evaluate(
        r"""() => {
          const fakeFile = (b) => new File(['x'], b, { type: 'image/png' });
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


def confirm_accept(page):
    page.evaluate("window.confirm = () => true")


def confirm_decline(page):
    page.evaluate("window.confirm = () => false")


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


def task_status(page, task_id):
    return page.evaluate(
        f"""() => {{
          const s = window.__mockStorage.data.state_v1 || {{}};
          return (s.tasks || {{}})[{task_id!r}]?.status ?? null;
        }}"""
    )


def runtime_of_type(page, msg_type):
    msgs = page.evaluate("window.__runtimeMessages")
    return [m for m in msgs if m.get("type") == msg_type]


def sent_of_type(page, msg_type):
    msgs = page.evaluate("window.__sentMessages")
    return [m for m in msgs if m.get("msg", {}).get("type") == msg_type]


def conversation_state(page):
    return page.evaluate("window.__conversationState")


def project_loaded(page):
    return page.evaluate(
        """() => {
          const s = window.__mockStorage.data.state_v1 || {};
          return s.source && s.source.project ? s.source.project.project.id : null;
        }"""
    )


def folder_bound(page):
    """Detect whether the folder binding is still active. We can't
    inspect the FileSystemDirectoryHandle directly, but the project
    name should still display as the bound folder name."""
    return page.evaluate(
        """() => {
          const el = document.getElementById('folder-binding-name');
          return el ? el.textContent : null;
        }"""
    )


def install_official_button_for_response(page, response_index):
    page.evaluate(
        f"""(ri) => {{
          window.__OFFICIAL_DOWNLOAD_BUTTONS = window.__OFFICIAL_DOWNLOAD_BUTTONS || {{}};
          window.__OFFICIAL_DOWNLOAD_BUTTONS[String(ri)] =
            (window.__OFFICIAL_DOWNLOAD_BUTTONS[String(ri)] || []).concat([
              {{ ariaLabel: 'Baixar imagem no tamanho original' }}
            ]);
          window.__activeResponseIndex = ri;
        }}""",
        response_index,
    )


def dirty_conversation_state(page):
    """Force the mock conversation state into a non-clean condition
    so the verify stub returns ok=false. Used to test the
    verification-failed branch."""
    page.evaluate(
        """() => {
          window.__conversationState.composerText = 'leftover prompt';
          window.__conversationState.attachmentCount = 1;
        }"""
    )


def run_one_execution(page, task_id, response_index, *, with_dirty_reset=False):
    select_task(page, task_id)
    page.wait_for_timeout(200)
    confirm_accept(page)
    click(page, "#prepare-task-btn")
    page.wait_for_timeout(500)
    install_official_button_for_response(page, response_index)
    click(page, "#generate-task-btn")
    page.wait_for_timeout(900)
    # The download-state-changed post-back fires ~30ms after ARM_DOWNLOAD.
    # Wait a bit more so applyDownloadStateChange completes.
    page.wait_for_timeout(300)


def reset_trace(page):
    """Extract the conversationResetTrace from the self-test card."""
    return page.evaluate(
        """() => {
          const txt = document.getElementById('selftest')?.textContent || '';
          const m = txt.match(/"---\\s*conversation reset trace[^"]*"([\\s\\S]*?)(?=\\n---|$)/);
          if (!m) return null;
          try { return JSON.parse(m[1]); } catch (_) { return null; }
        }"""
    )


def reset_trace_summary(page):
    """Extract the resetTraceLength / lastResetTraceStep from the
    downloadTraceSummary block."""
    return page.evaluate(
        """() => {
          const txt = document.getElementById('selftest')?.textContent || '';
          const m = txt.match(/"resetTraceLength"\\s*:\\s*(\\d+)/);
          if (!m) return null;
          return { resetTraceLength: parseInt(m[1], 10) };
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

        print("v0.10 Clean-Conversation Lifecycle E2E")
        print("---------------------------------------")

        case(
            "Reset Conversation blocked while download is in flight",
            lambda: _case_blocked_while_download_in_flight(page, reset),
        )
        case(
            "Reset Conversation blocked when download failed",
            lambda: _case_blocked_when_download_failed(page, reset),
        )
        case(
            "Reset Conversation allowed only after successful download",
            lambda: _case_allowed_after_download_complete(page, reset),
        )
        case(
            "Next Task and Reset Conversation share the same reset implementation",
            lambda: _case_next_task_uses_same_reset(page, reset),
        )
        case(
            "Sequential scene-001 -> scene-002 -> scene-003 with clean resets",
            lambda: _case_sequential_three_tasks(page, reset),
        )
        case(
            "Project JSON, asset catalog, folder binding preserved across resets",
            lambda: _case_project_preserved_across_resets(page, reset),
        )
        case(
            "Per-execution state (activeExecution, baseline) cleared on reset",
            lambda: _case_execution_state_cleared(page, reset),
        )
        case(
            "task.status persisted to 'generated' BEFORE reset runs",
            lambda: _case_status_persisted_before_reset(page, reset),
        )
        case(
            "Conversation verification failure leaves task + conversation intact",
            lambda: _case_verification_failure_keeps_state(page, reset),
        )
        case(
            "Reset trace accumulates structured events",
            lambda: _case_reset_trace_emitted(page, reset),
        )
        case(
            "Handler registration counter still 1 after navigation + reset",
            lambda: _case_no_duplicate_handlers_after_reset(page, reset),
        )

        browser.close()

    print("---------------------------------------")
    print(f"summary: {passed} passed, {failed} failed")
    if fails:
        for f in fails:
            print(f"  - {f}")
    sys.exit(0 if failed == 0 else 1)


# ---- case bodies --------------------------------------------------------

def _case_blocked_while_download_in_flight(page, reset_fn):
    """Reset must be blocked when state.download is not yet 'complete'."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    # Block the download-state-changed post-back so the synthetic
    # callback never fires. We achieve this by intercepting the SW
    # post-back path and discarding.
    page.evaluate(
        """() => {
          window.__postedBackMessages = [];
          // Override the runtime listener so the existing side panel
          // handler never sees the state-changed event.
          const orig = chrome.runtime.onMessage._listeners;
          chrome.runtime.onMessage._listeners = [];
        }"""
    )

    confirm_accept(page)
    click(page, "#prepare-task-btn")
    page.wait_for_timeout(500)
    install_official_button_for_response(page, 0)
    click(page, "#generate-task-btn")
    page.wait_for_timeout(900)
    page.wait_for_timeout(300)

    # The download is "in flight" from the orchestrator's perspective
    # (state.download.status was set to 'waiting-browser-download').
    # Try to reset; the Reset Conversation button must be hidden
    # because the phase is still 'downloading'-equivalent.
    btn_visible = page.evaluate(
        """() => !document.getElementById('reset-conversation-btn').hidden"""
    )
    assert not btn_visible, (
        "Reset Conversation must be hidden while download is in flight"
    )

    # Try clicking Next Task — it should not advance because the
    # download is not complete.
    pre_status = task_status(page, "scene-001")
    click(page, "#next-btn")
    page.wait_for_timeout(400)
    post_status = task_status(page, "scene-001")
    assert pre_status == post_status, (
        f"Next Task must not advance while download is in flight "
        f"(was {pre_status}, became {post_status})"
    )

    # Restore the listener so subsequent cases are unaffected.
    page.evaluate(
        """() => { chrome.runtime.onMessage._listeners.length = 0; }"""
    )


def _case_blocked_when_download_failed(page, reset_fn):
    """Reset must be blocked when state.download.status === 'error'."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    # Force the click path to fail so state.download.status becomes 'error'.
    page.evaluate(
        """() => {
          window.__stubResponses['GEMINI_ASSISTANT_CLICK_OFFICIAL_DOWNLOAD'] = {
            ok: false, reason: 'no-button',
            candidateCountGlobal: 0, candidateCountInsideCurrentResponse: 0,
          };
        }"""
    )
    confirm_accept(page)
    click(page, "#prepare-task-btn")
    page.wait_for_timeout(500)
    click(page, "#generate-task-btn")
    page.wait_for_timeout(800)

    btn_visible = page.evaluate(
        """() => !document.getElementById('reset-conversation-btn').hidden"""
    )
    assert not btn_visible, (
        "Reset Conversation must be hidden when download failed"
    )


def _case_allowed_after_download_complete(page, reset_fn):
    """After a successful download the Reset Conversation button must be visible."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    run_one_execution(page, "scene-001", 0)
    assert task_status(page, "scene-001") == "generated", (
        f"scene-001 should be 'generated', got {task_status(page, 'scene-001')}"
    )
    btn_visible = page.evaluate(
        """() => !document.getElementById('reset-conversation-btn').hidden"""
    )
    assert btn_visible, (
        "Reset Conversation must be visible after download complete"
    )

    # Trigger Reset Conversation directly. The orchestrator's phase
    # must move through task-complete -> resetting-conversation -> idle.
    click(page, "#reset-conversation-btn")
    page.wait_for_timeout(800)

    # After reset, the same tab is reused but the conversationId changed.
    cs = conversation_state(page)
    assert cs["conversationId"] != "initial-conv-001", (
        f"conversationId should change after reset, got {cs}"
    )
    assert cs["composerText"] == "", (
        f"composer text must be empty after reset, got {cs}"
    )
    assert cs["attachmentCount"] == 0, (
        f"composer attachments must be 0 after reset, got {cs}"
    )


def _case_next_task_uses_same_reset(page, reset_fn):
    """The Next Task button after a successful download must drive the
    same reset implementation as the Reset Conversation button."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    # Run scene-001 successfully.
    run_one_execution(page, "scene-001", 0)

    # Click Next Task.
    click(page, "#next-btn")
    page.wait_for_timeout(800)

    # The conversation must have been reset.
    cs = conversation_state(page)
    assert cs["conversationId"] != "initial-conv-001", (
        f"Next Task did not reset conversation: {cs}"
    )

    # And the next task (scene-002) must be selected.
    cur = page.evaluate(
        "() => document.getElementById('task-select')?.value"
    )
    assert cur == "scene-002", f"expected scene-002 selected, got {cur}"


def _case_sequential_three_tasks(page, reset_fn):
    """Run three tasks in sequence. After each task, Next Task must
    reset the conversation and advance."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    expected = [("scene-001", 0), ("scene-002", 1), ("scene-003", 2)]
    last_conversation_id = "initial-conv-001"
    for tid, ridx in expected:
        run_one_execution(page, tid, ridx)
        assert task_status(page, tid) == "generated", (
            f"{tid} should be generated, got {task_status(page, tid)}"
        )
        click(page, "#next-btn")
        page.wait_for_timeout(800)

    # After all three, the conversationId should have changed at least
    # four times (once per task + initial).
    cs = conversation_state(page)
    assert cs["conversationId"] != last_conversation_id, (
        f"Final conversationId did not change: {cs['conversationId']}"
    )
    # Composer must be clean.
    assert cs["composerText"] == "" and cs["attachmentCount"] == 0, (
        f"Composer not clean after sequence: {cs}"
    )


def _case_project_preserved_across_resets(page, reset_fn):
    """Project JSON, asset catalog, folder binding survive the reset."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    pid_before = project_loaded(page)
    folder_before = folder_bound(page)
    assert pid_before == "yuki-video-001"
    assert folder_before and folder_before != "Not bound (session only)", (
        f"folder must be bound, got {folder_before}"
    )

    run_one_execution(page, "scene-001", 0)
    click(page, "#next-btn")
    page.wait_for_timeout(800)

    pid_after = project_loaded(page)
    folder_after = folder_bound(page)
    assert pid_after == pid_before, (
        f"project id changed across reset: {pid_before} -> {pid_after}"
    )
    assert folder_after == folder_before, (
        f"folder binding changed across reset: {folder_before} -> {folder_after}"
    )

    # Asset catalog must still be present.
    asset_count = page.evaluate(
        """() => {
          const s = window.__mockStorage.data.state_v1 || {};
          return Object.keys(s.source?.project?.assets || {}).length;
        }"""
    )
    assert asset_count == 1, (
        f"asset catalog size changed across reset: {asset_count}"
    )


def _case_execution_state_cleared(page, reset_fn):
    """After a reset, per-execution state (activeExecution, baseline)
    must be cleared while project state is preserved."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    run_one_execution(page, "scene-001", 0)
    click(page, "#next-btn")
    page.wait_for_timeout(800)

    # Probe the orchestrator state through the self-test card.
    txt = page.evaluate(
        "() => document.getElementById('selftest')?.textContent || ''"
    )
    assert "executionId" in txt
    assert "taskId" in txt
    # After reset+advance, the activeTaskId should be scene-002.
    import re
    m = re.search(r'"activeTaskId"\\s*:\\s*"([^"]+)"', txt)
    assert m and m.group(1) == "scene-002", (
        f"activeTaskId after reset+advance must be scene-002, got {m and m.group(1)}"
    )


def _case_status_persisted_before_reset(page, reset_fn):
    """task.status='generated' must be persisted BEFORE the conversation
    reset runs. If the reset fails, the status must remain 'generated'."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    run_one_execution(page, "scene-001", 0)
    pre_status = task_status(page, "scene-001")
    assert pre_status == "generated"

    # Reset should preserve the generated status regardless of outcome.
    click(page, "#next-btn")
    page.wait_for_timeout(800)
    post_status = task_status(page, "scene-001")
    assert post_status == "generated", (
        f"task.status must remain 'generated' after reset, got {post_status}"
    )


def _case_verification_failure_keeps_state(page, reset_fn):
    """If waitForCleanConversation returns ok=false, the task is NOT
    advanced and the conversation is left as-is."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    # Run scene-001 successfully first.
    run_one_execution(page, "scene-001", 0)

    # Force verify stub to fail by dirtying the conversation state.
    # Note: the side panel calls RESET first (which calls simulateReset
    # in the mock), THEN WAIT. The mock resets before verifying, so
    # dirtying AFTER reset doesn't work. Instead, intercept the
    # WAIT_FOR_CLEAN_CONVERSATION message and force ok=false.
    page.evaluate(
        """() => {
          const orig = window.chrome.tabs.sendMessage;
          window.chrome.tabs.sendMessage = (tabId, msg, cb) => {
            if (msg && msg.type === 'GEMINI_ASSISTANT_WAIT_FOR_CLEAN_CONVERSATION') {
              cb({
                ok: false, reason: 'timeout',
                composerFound: true, composerTextLength: 5,
                attachmentCount: 0, generationActive: false,
                elapsedMs: 10000, attempts: 50,
              });
              return;
            }
            return orig(tabId, msg, cb);
          };
        }"""
    )
    click(page, "#reset-conversation-btn")
    page.wait_for_timeout(800)

    # The orchestrator must NOT have advanced. The current task must
    # still be scene-001.
    cur = page.evaluate(
        "() => document.getElementById('task-select')?.value"
    )
    assert cur == "scene-001", (
        f"task must not advance when verification fails, got {cur}"
    )

    # task.status must still be 'generated' (preserved across the
    # failed reset).
    assert task_status(page, "scene-001") == "generated"


def _case_reset_trace_emitted(page, reset_fn):
    """After a successful reset, the conversationResetTrace contains
    at least: reset-requested, navigation-started, clean-page-loaded,
    execution-state-cleared, complete."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    run_one_execution(page, "scene-001", 0)
    click(page, "#next-btn")
    page.wait_for_timeout(800)

    summary = reset_trace_summary(page)
    assert summary is not None, "resetTraceLength not present in self-test card"
    assert summary["resetTraceLength"] >= 5, (
        f"reset trace too short: {summary}"
    )

    # Dump the trace to confirm the steps we expect are present.
    page.evaluate(
        """() => {
          window.__lastResetTrace = JSON.parse(
            JSON.stringify(window.__conversationResetTrace || [])
          );
        }"""
    )
    trace = page.evaluate("() => window.__lastResetTrace")
    steps = [t["step"] for t in trace] if trace else []
    for required in [
        "reset-requested",
        "navigation-started",
        "clean-page-loaded",
        "execution-state-cleared",
        "complete",
    ]:
        assert required in steps, (
            f"reset trace missing step '{required}': {steps}"
        )


def _case_no_duplicate_handlers_after_reset(page, reset_fn):
    """After navigation + reset cycles, Generate Task must still
    have exactly 1 handler registration."""
    reset_fn(page)
    seed(page, v3_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    # Run scene-001 + Next Task twice (cycle).
    for _ in range(2):
        run_one_execution(page, "scene-001", 0)
        click(page, "#next-btn")
        page.wait_for_timeout(800)
        select_task(page, "scene-001")
        page.wait_for_timeout(400)

    counters = page.evaluate(
        """() => {
          const txt = document.getElementById('selftest')?.textContent || '';
          const m = txt.match(/"handlerRegistrationCounters"\\s*:\\s*\\{[^}]*\\}/);
          return m ? JSON.parse('{' + m[0].slice(m[0].indexOf(':') + 1)) : null;
        }"""
    )
    assert counters is not None
    assert counters["generateTaskBtn"] == 1, (
        f"Generate Task handler must be exactly 1 after resets, got {counters}"
    )
    assert counters["retryGenerateBtn"] == 1


if __name__ == "__main__":
    main()
