"""
End-to-end DOM tests for the v0.6 Single-Task Image Generation workflow.

Covers the side panel -> orchestrator -> content-script contract for:
  - Image Mode button is enabled when refs are resolved.
  - Prepare Task happy path: ensures image mode, attaches all refs,
    inserts prompt, and lands in "ready" phase.
  - Prepare Task with a missing ref stops at "preparing-attachments"
    and surfaces the error.
  - Prepare Task refuses (asks for confirmation) when the composer
    is not clean (existing attachments/text).
  - Generate Task runs prepare + preflight + send + wait + download
    and lands in "complete".
  - Generate Task requires "ready" phase first.
  - Cancel button is hidden when idle, shown when busy.
  - Operation lock: when busy, navigation buttons (prev/next/rebind)
    are disabled.
  - Status transition: pending -> generated after download success.

The mock wraps chrome.tabs.sendMessage to capture the messages and
chrome.runtime.sendMessage to capture the download blob. No real
gemini.google.com is involved — this is a contract test.

Run with:
    python3 tests/e2e_generate.py
"""

import sys
from playwright.sync_api import sync_playwright

EXT_PATH = "/Users/isamumatsuyama/Documents/development/gemini-assistant"
POPUP = f"file://{EXT_PATH}/src/sidepanel/sidepanel.html"

# A mock chrome.* environment that:
#   - returns a fake Gemini tab
#   - simulates adapter responses
#   - records every message sent by the popup
MOCK = r"""
(() => {
  const read = () => JSON.parse(localStorage.getItem('mock') || '{}');
  const write = (data) => localStorage.setItem('mock', JSON.stringify(data));
  window.__mockStorage = { data: read() };
  window.__sentMessages = [];
  window.__downloadCalls = [];
  window.__stubResponses = {};
  window.chrome = {
    tabs: {
      query: (_q, cb) => cb([{ id: 7, url: 'https://gemini.google.com/app' }]),
      sendMessage: (tabId, msg, cb) => {
        const captured = { tabId, msg: { ...msg } };
        if (msg && msg.file && msg.file instanceof File) {
          captured.fileInfo = {
            name: msg.file.name,
            size: msg.file.size,
            type: msg.file.type,
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
          // The mock is stateless. We reconstruct the prompt length
          // from the most recent INSERT_PROMPT message (the prompt is
          // the source of truth on the Gemini side once inserted).
          const inserts = window.__sentMessages.filter(
            (m) => m.msg && m.msg.type === 'GEMINI_ASSISTANT_INSERT_PROMPT',
          );
          const lastPromptLen = inserts.length
            ? (inserts[inserts.length - 1].msg.text || '').length
            : 0;
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
          resp = {
            ok: true,
            baseline: {
              capturedAt: 0,
              userQueryCount: 1,
              modelResponseCount: 1,
              generatedImageCount: 0,
              generatedImageSrcs: [],
            },
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_SEND_COMPOSER') {
          resp = { ok: true, method: 'click' };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_WAIT_FOR_GENERATED_IMAGE') {
          resp = {
            ok: true,
            imageSrc: 'https://lh3.googleusercontent.com/gg/abc',
            alt: 'AI generated',
            naturalWidth: 1024,
            naturalHeight: 1024,
            downloadControl: { ariaLabel: 'Download full size image' },
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_FETCH_IMAGE') {
          // Provide a tiny fake PNG byte stream as ArrayBuffer.
          // The byte sequence is a 1x1 transparent PNG.
          const bytes = new Uint8Array([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
            0x42, 0x60, 0x82,
          ]);
          resp = {
            ok: true,
            arrayBuffer: bytes.buffer,
            mime: 'image/png',
            contentLength: bytes.byteLength,
            finalUrl: msg.url,
          };
        } else {
          resp = { ok: false, error: `no stub for ${msg && msg.type}` };
        }
        cb && cb(resp);
      },
    },
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        window.__downloadCalls.push(msg);
        let resp = { ok: false, error: 'no stub for download' };
        if (msg && msg.type === 'GEMINI_ASSISTANT_DOWNLOAD_BLOB') {
          resp = {
            ok: true,
            downloadId: 1,
            finalFilename: msg.filename,
            bytes: 67,
          };
        }
        cb && cb(resp);
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
        clear: (cb) => {
          write({});
          window.__mockStorage.data = {};
          cb && cb();
        },
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
            "environment-village": {
                "label": "Snow village", "type": "environment", "file": "refs/environment-village.jpg",
            },
            "style-master": {
                "label": "Master style", "type": "style", "file": "refs/style-master.webp",
            },
        },
        "tasks": [
            {
                "id": "scene-001",
                "title": "Opening shot",
                "prompt": "Wide shot of the snow village at night.",
                "references": ["character-main", "environment-village", "style-master"],
                "output": {"basename": "scene-001"},
            },
            {
                "id": "scene-002",
                "title": "Second shot",
                "prompt": "Close-up of the main character.",
                "references": ["character-main"],
                "output": {"basename": "scene-002"},
            },
        ],
    }


def seed(page, project):
    state = {
        "schemaVersion": 1,
        "source": {"project": project, "importedAt": 1},
        "tasks": {
            t["id"]: {"status": "pending", "prompt": t["prompt"]}
            for t in project["tasks"]
        },
        "currentTaskId": project["tasks"][0]["id"],
    }
    page.evaluate(
        "(s) => window.chrome.storage.local.set({ state_v1: s })", state
    )


def reset(page):
    page.evaluate(
        """() => {
          window.chrome.storage.local.clear();
          window.__sentMessages = [];
          window.__downloadCalls = [];
          window.__stubResponses = {};
        }"""
    )


def bind_folder_with_resolved_refs(page):
    # Simulate a folder binding where every ref resolves to a fake File.
    # The mock handle must navigate into subdirectories (e.g. `refs/`) and
    # return a File whose NAME matches the BASENAME of the relative path
    # the resolver asked for. That's how the popup decides which filename
    # to display.
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


def workflow_buttons(page):
    return page.evaluate(
        """() => ({
          ensureDisabled: document.getElementById('ensure-image-mode-btn').disabled,
          prepareDisabled: document.getElementById('prepare-task-btn').disabled,
          generateDisabled: document.getElementById('generate-task-btn').disabled,
          cancelHidden: document.getElementById('cancel-op-btn').hidden,
          prevDisabled: document.getElementById('prev-btn').disabled,
          nextDisabled: document.getElementById('next-btn').disabled,
          rebindDisabled: document.getElementById('folder-bind-btn').disabled,
        })"""
    )


def sent_of_type(page, msg_type):
    msgs = page.evaluate("window.__sentMessages")
    return [m for m in msgs if m.get("msg", {}).get("type") == msg_type]


def download_calls(page):
    return page.evaluate("window.__downloadCalls")


def click(page, sel):
    page.evaluate(
        f"() => document.querySelector('{sel}')?.click()"
    )
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


def confirm_decline(page):
    page.evaluate("window.confirm = () => false")


def task_status(page, task_id):
    return page.evaluate(
        f"""() => {{
          const s = window.__mockStorage.data.state_v1 || {{}};
          return (s.tasks || {{}})[{task_id!r}]?.status ?? null;
        }}"""
    )


def task_prompt_saved(page, task_id):
    return page.evaluate(
        f"""() => {{
          const s = window.__mockStorage.data.state_v1 || {{}};
          return (s.tasks || {{}})[{task_id!r}]?.prompt ?? null;
        }}"""
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

        print("v0.6 Single-Task Image Generation E2E")
        print("---------------------------------------")

        # ---- 1. Image Mode button enabled after refs are resolved ----
        case(
            "Image Mode button is enabled when refs are resolved",
            lambda: _case_image_mode_enabled(page, reset),
        )

        # ---- 2. Prepare Task happy path ----
        case(
            "Prepare Task: image mode + 3 attachments + prompt + ready",
            lambda: _case_prepare_happy_path(page, reset),
        )

        # ---- 3. Generate Task happy path ----
        case(
            "Generate Task: prepare + send + wait + download + status generated",
            lambda: _case_generate_happy_path(page, reset),
        )

        # ---- 4. Prepare refuses when composer is not clean ----
        case(
            "Prepare Task with non-clean composer asks for confirmation",
            lambda: _case_prepare_dirty_composer(page, reset),
        )

        # ---- 5. Operation Lock: when busy, navigation is disabled ----
        case(
            "During operation: prev/next/rebind are disabled",
            lambda: _case_operation_lock(page, reset),
        )

        # ---- 6. Cancel button is hidden when idle ----
        case(
            "Cancel button is hidden when no operation is running",
            lambda: _case_cancel_hidden_when_idle(page, reset),
        )

        # ---- 7. Cancel during a running operation ----
        case(
            "Cancel during running operation transitions to cancelled",
            lambda: _case_cancel_running(page, reset),
        )

        # ---- 8. Generate Task refuses when not in ready phase ----
        case(
            "Generate Task without Prepare Task is refused",
            lambda: _case_generate_requires_ready(page, reset),
        )

        # ---- 9. Download filename includes sanitized basename ----
        case(
            "Download filename uses sanitized basename + correct extension",
            lambda: _case_download_filename(page, reset),
        )

        # ---- 10. Filename sanitization rejects traversal ----
        case(
            "Output basename with path traversal cannot pass parsing",
            lambda: _case_traversal_basename_rejected(page, reset),
        )

        browser.close()

    print("---------------------------------------")
    print(f"summary: {passed} passed, {failed} failed")
    if fails:
        for f in fails:
            print(f"  - {f}")
    sys.exit(0 if failed == 0 else 1)


# ---- case bodies --------------------------------------------------------

def _case_image_mode_enabled(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)
    btns = workflow_buttons(page)
    assert btns["ensureDisabled"] is False, "Ensure Image Mode should be enabled with refs resolved"
    assert btns["prepareDisabled"] is False, "Prepare Task should be enabled with refs resolved"
    assert btns["generateDisabled"] is True, "Generate Task should be disabled before Prepare"


def _case_prepare_happy_path(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)
    confirm_accept(page)

    # Click Prepare Task.
    click(page, "#prepare-task-btn")
    page.wait_for_timeout(800)

    ph = workflow_phase(page)
    assert ph["phase"] == "ready", f"expected ready, got {ph}"

    # 3 attachments + 1 ENSURE + 1 INSERT_PROMPT were sent.
    attach_msgs = sent_of_type(page, "GEMINI_ASSISTANT_ATTACH_WITH_MENU")
    assert len(attach_msgs) == 3, f"expected 3 ATTACH_WITH_MENU, got {len(attach_msgs)}"
    # Order preserved.
    file_names = [m["msg"]["fileName"] for m in attach_msgs]
    assert file_names == [
        "character-main.png", "environment-village.jpg", "style-master.webp"
    ], f"order broken: {file_names}"

    insert_msgs = sent_of_type(page, "GEMINI_ASSISTANT_INSERT_PROMPT")
    assert len(insert_msgs) == 1
    assert insert_msgs[0]["msg"]["text"] == "Wide shot of the snow village at night."

    st = status_text(page)
    assert "Prepared" in st["text"], f"status should mention Prepared, got {st}"

    # Generate Task should now be enabled.
    btns = workflow_buttons(page)
    assert btns["generateDisabled"] is False, "Generate Task should be enabled after Prepare"


def _case_generate_happy_path(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)
    confirm_accept(page)

    # Prepare.
    click(page, "#prepare-task-btn")
    page.wait_for_timeout(800)

    # Generate.
    click(page, "#generate-task-btn")
    page.wait_for_timeout(1200)

    ph = workflow_phase(page)
    assert ph["phase"] == "complete", f"expected complete, got {ph}"

    # All expected message types fired.
    for msg_type in [
        "GEMINI_ASSISTANT_ENSURE_IMAGE_MODE",
        "GEMINI_ASSISTANT_ATTACH_WITH_MENU",
        "GEMINI_ASSISTANT_INSERT_PROMPT",
        "GEMINI_ASSISTANT_CAPTURE_BASELINE",
        "GEMINI_ASSISTANT_COMPOSER_STATE",
        "GEMINI_ASSISTANT_FIND_SEND_BUTTON",
        "GEMINI_ASSISTANT_SEND_COMPOSER",
        "GEMINI_ASSISTANT_WAIT_FOR_GENERATED_IMAGE",
        "GEMINI_ASSISTANT_FETCH_IMAGE",
    ]:
        msgs = sent_of_type(page, msg_type)
        assert len(msgs) >= 1, f"missing message type: {msg_type}"

    # Download bridge was called with the correct filename.
    dl = download_calls(page)
    assert len(dl) == 1, f"expected 1 download call, got {len(dl)}"
    assert dl[0]["filename"] == "scene-001.png", f"unexpected filename: {dl[0]['filename']}"
    assert dl[0]["mime"] == "image/png"

    # Task status moved pending -> generated.
    assert task_status(page, "scene-001") == "generated", (
        f"expected status=generated, got {task_status(page, 'scene-001')}"
    )


def _case_prepare_dirty_composer(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    # Stub COMPOSER_STATE to report a dirty composer.
    page.evaluate(
        """() => {
          window.__stubResponses['GEMINI_ASSISTANT_COMPOSER_STATE'] = {
            ok: true,
            attachmentCount: 1,
            pendingUploadCount: 0,
            promptLength: 5,
            imageModeActive: true,
            composerClean: false,
          };
        }"""
    )

    # Decline the confirm dialog — Prepare must abort.
    confirm_decline(page)
    click(page, "#prepare-task-btn")
    page.wait_for_timeout(400)

    ph = workflow_phase(page)
    assert ph["phase"] == "idle", f"expected idle after declining confirm, got {ph}"

    # ENSURE_IMAGE_MODE may or may not have fired (we decline early).
    # What MUST be true: no ATTACH and no INSERT_PROMPT.
    attach_msgs = sent_of_type(page, "GEMINI_ASSISTANT_ATTACH_WITH_MENU")
    assert len(attach_msgs) == 0
    insert_msgs = sent_of_type(page, "GEMINI_ASSISTANT_INSERT_PROMPT")
    assert len(insert_msgs) == 0


def _case_operation_lock(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)
    confirm_accept(page)

    # Make the ENSURE_IMAGE_MODE step slow so we can observe the lock.
    page.evaluate(
        """() => {
          const orig = window.chrome.tabs.sendMessage;
          window.chrome.tabs.sendMessage = (tabId, msg, cb) => {
            if (msg && msg.type === 'GEMINI_ASSISTANT_ENSURE_IMAGE_MODE') {
              setTimeout(() => cb({ ok: true, mode: 'activated' }), 2000);
              return;
            }
            return orig(tabId, msg, cb);
          };
        }"""
    )

    # Before clicking anything, at least one of the navigation buttons
    # should be enabled (we're on scene-001 with 2 tasks, so next is
    # enabled and prev is not). rebind should also be enabled.
    btns0 = workflow_buttons(page)
    assert btns0["nextDisabled"] is False, f"before: {btns0}"
    assert btns0["rebindDisabled"] is False, f"before: {btns0}"
    assert btns0["cancelHidden"] is True, f"before: {btns0}"

    click(page, "#prepare-task-btn")
    # Mid-flight: navigation disabled, cancel visible.
    page.wait_for_timeout(400)
    btns1 = workflow_buttons(page)
    assert btns1["prevDisabled"] is True, f"mid-flight: {btns1}"
    assert btns1["nextDisabled"] is True, f"mid-flight: {btns1}"
    assert btns1["rebindDisabled"] is True, f"mid-flight: {btns1}"
    assert btns1["cancelHidden"] is False, f"mid-flight: {btns1}"

    # Cancel out so the test ends cleanly.
    click(page, "#cancel-op-btn")
    page.wait_for_timeout(500)


def _case_cancel_hidden_when_idle(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    btns = workflow_buttons(page)
    assert btns["cancelHidden"] is True, "cancel should be hidden in idle"


def _case_cancel_running(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)
    confirm_accept(page)

    # Stub SLOW attach response so we can cancel mid-flight.
    page.evaluate(
        """() => {
          window.__stubResponses['GEMINI_ASSISTANT_ATTACH_WITH_MENU'] = null;
          // We replace the implementation by monkeypatching the
          // sendMessage path: return a never-resolving promise after a delay.
          const orig = window.chrome.tabs.sendMessage;
          window.chrome.tabs.sendMessage = (tabId, msg, cb) => {
            if (msg && msg.type === 'GEMINI_ASSISTANT_ATTACH_WITH_MENU') {
              setTimeout(() => cb({ ok: true }), 5000);
              return;
            }
            return orig(tabId, msg, cb);
          };
        }"""
    )

    click(page, "#prepare-task-btn")
    page.wait_for_timeout(150)
    # Click cancel mid-flight.
    click(page, "#cancel-op-btn")
    page.wait_for_timeout(300)

    ph = workflow_phase(page)
    assert ph["phase"] == "cancelled", f"expected cancelled, got {ph}"


def _case_generate_requires_ready(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)

    # Without clicking Prepare, Generate Task button is disabled.
    btns = workflow_buttons(page)
    assert btns["generateDisabled"] is True, (
        "Generate Task must be disabled before Prepare Task"
    )


def _case_download_filename(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    bind_folder_with_resolved_refs(page)
    confirm_accept(page)

    click(page, "#prepare-task-btn")
    page.wait_for_timeout(500)
    click(page, "#generate-task-btn")
    page.wait_for_timeout(800)

    dl = download_calls(page)
    assert len(dl) == 1
    fn = dl[0]["filename"]
    # The mock returns the mime as image/png from the fetch stub.
    assert fn.endswith(".png"), f"extension must match detected mime: {fn}"
    # No path traversal in the filename.
    assert "/" not in fn and "\\" not in fn and ".." not in fn


def _case_traversal_basename_rejected(page, reset_fn):
    # The output.basename sanitizer is in src/lib/output.js. We assert the
    # contract here through the popup's import path: a project with a
    # traversal basename cannot be imported silently.
    reset_fn(page)
    bad_json = """{
      "schemaVersion": 2,
      "project": { "id": "bad", "name": "Bad" },
      "assets": {},
      "tasks": [
        { "id": "scene-001", "prompt": "p", "output": { "basename": "../../escape" } }
      ]
    }"""
    # Capture the status line after a fake import. We do this by stuffing
    # the import via the existing handleFileSelected path: read the JSON,
    # run it through the project's parser, and only inject the result if
    # ok. We mirror what handleFileSelected does.
    result = page.evaluate(
        """(raw) => {
          // The popup exposes GeminiAssistantProject via the global.
          // Re-import the parser module via window since the sidepanel
          // already loaded it.
          const lib = window.GeminiAssistantProject;
          if (!lib) return { ok: false, reason: 'lib missing' };
          return lib.parseProjectJson(raw);
        }""",
        bad_json,
    )
    assert not result.get("ok"), "parser must reject traversal basename"
    assert (
        "output" in result.get("error", "").lower()
        or "traversal" in result.get("error", "").lower()
    ), f"unexpected error: {result.get('error')}"


if __name__ == "__main__":
    main()
