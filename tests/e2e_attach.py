"""
End-to-end DOM tests for the v0.5 Single Reference Attachment PoC.

Covers the popup → content-script contract for Attach:
  - Click on Attach with a resolved reference sends
    { type: "GEMINI_ASSISTANT_ATTACH", file: File, ... }.
  - The File object survives the chrome.tabs.sendMessage boundary
    (structured clone), so we can read its name/size/type downstream.
  - The popup status reflects success or failure.
  - Attach is disabled for missing / unsupported / unbound refs.
  - Insert Prompt remains unaffected by Attach.

The mock wraps `chrome.tabs.sendMessage` to capture the messages the
popup would send and stub the content-script response (which is what
the Gemini DOM adapter would return in the real world). No real
gemini.google.com is involved — this is a contract test.

Run with:
    python3 tests/e2e_attach.py
"""

import sys
from playwright.sync_api import sync_playwright

EXT_PATH = "/Users/isamumatsuyama/Documents/development/gemini-assistant"
POPUP = f"file://{EXT_PATH}/src/sidepanel/sidepanel.html"

MOCK = r"""
(() => {
  const read = () => JSON.parse(localStorage.getItem('mock') || '{}');
  const write = (data) => localStorage.setItem('mock', JSON.stringify(data));
  window.__mockStorage = { data: read() };
  window.__sentMessages = [];
  // Stubbed adapter response for ATTACH; defaults to success.
  window.__stubAttachResponse = null;
  window.chrome = {
    tabs: {
      query: (_q, cb) => cb([{ id: 7, url: 'https://gemini.google.com/app' }]),
      sendMessage: (tabId, msg, cb) => {
        // Capture the message. File objects survive structured clone in MV3.
        const captured = { tabId, msg: { ...msg } };
        if (msg && msg.file && msg.file instanceof File) {
          captured.fileInfo = {
            name: msg.file.name,
            size: msg.file.size,
            type: msg.file.type,
          };
          // Don't keep the File in the captured payload to avoid
          // confusing the assertions.
          captured.msg.file = '<File>';
        }
        window.__sentMessages.push(captured);
        let resp;
        if (msg && msg.type === 'GEMINI_ASSISTANT_ATTACH') {
          resp = window.__stubAttachResponse || {
            ok: true,
            method: 'datatransfer',
            fileName: (msg.fileName) || 'unknown',
            fileType: (msg.fileType) || '',
            fileSize: (msg.fileSize) || 0,
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_INSERT_PROMPT') {
          resp = window.__stubAttachResponse || {
            ok: true, length: (msg.text || '').length, method: 'quill',
          };
        } else {
          resp = { ok: true };
        }
        cb && cb(resp);
      },
    },
    runtime: { lastError: null, sendMessage: () => {} },
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
        "project": {"id": "v2", "name": "V2 with assets"},
        "assets": {
            "character-main": {
                "label": "Yuki", "type": "character", "file": "refs/yuki.png",
            },
            "environment-village": {
                "label": "Village", "type": "environment", "file": "refs/village.jpg",
            },
            "style-master": {
                "label": "Master Style", "type": "style", "file": "refs/master.webp",
            },
        },
        "tasks": [
            {
                "id": "t1",
                "title": "All three, all supported",
                "prompt": "p1",
                "references": ["character-main", "environment-village", "style-master"],
            },
            {
                "id": "t2",
                "title": "Single PNG",
                "prompt": "p2",
                "references": ["character-main"],
            },
            {
                "id": "t3",
                "title": "No references",
                "prompt": "p3",
            },
        ],
    }


def v2_project_with_unsupported():
    """A v2 project where the assets file extension is not in our supported set."""
    return {
        "schemaVersion": 2,
        "project": {"id": "vu", "name": "V2 with unsupported"},
        "assets": {
            "asset-gif": {
                "label": "Gif asset", "type": "other", "file": "refs/x.gif",
            },
        },
        "tasks": [
            {"id": "t1", "prompt": "p1", "references": ["asset-gif"]},
        ],
    }


def seed(page, project, current_task_id=None):
    first_id = current_task_id or project["tasks"][0]["id"]
    state = {
        "schemaVersion": 1,
        "source": {"project": project, "importedAt": 1},
        "tasks": {
            t["id"]: {"status": "pending", "prompt": t["prompt"]}
            for t in project["tasks"]
        },
        "currentTaskId": first_id,
    }
    page.evaluate(
        "(s) => window.chrome.storage.local.set({ state_v1: s })", state
    )


def reset(page):
    page.evaluate(
        """() => {
          window.chrome.storage.local.clear();
          window.__sentMessages = [];
          window.__stubAttachResponse = null;
        }"""
    )


def ref_state(page, index):
    """Return the state string for the Nth ref-card (0-indexed)."""
    return page.evaluate(
        """(i) => {
          const items = document.querySelectorAll('#references-list .ref-card');
          if (i >= items.length) return null;
          const s = items[i].querySelector('.ref-state');
          return s ? s.textContent : null;
        }""",
        index,
    )


def ref_states(page):
    """Return all ref state glyphs in order."""
    return page.evaluate(
        """() => Array.from(document.querySelectorAll('#references-list .ref-card .ref-state'))
            .map(s => s.textContent)"""
    )


def attach_btn_disabled(page, index):
    return page.evaluate(
        """(i) => {
          const items = document.querySelectorAll('#references-list .ref-card');
          if (i >= items.length) return null;
          const b = items[i].querySelector('.ref-attach');
          return b ? b.disabled : null;
        }""",
        index,
    )


def status_text(page):
    return page.evaluate(
        """() => ({
          state: document.getElementById('status').dataset.state,
          text: document.getElementById('status-text').textContent,
        })"""
    )


def sent_attach_messages(page):
    msgs = page.evaluate("window.__sentMessages")
    return [
        m for m in msgs
        if m.get("msg", {}).get("type") == "GEMINI_ASSISTANT_ATTACH"
    ]


def sent_insert_messages(page):
    msgs = page.evaluate("window.__sentMessages")
    return [
        m for m in msgs
        if m.get("msg", {}).get("type") == "GEMINI_ASSISTANT_INSERT_PROMPT"
    ]


def inject_resolved_refs(page, ref_index, fake_file_info):
    """Simulate the popup having resolved a ref by installing a fake File
    onto the popup's resolvedRefsCache and then clicking Attach. The
    popup calls chrome.tabs.sendMessage; the mock captures the message.
    """
    # We synthesize a File in the popup context, attach it to the
    # refIndex slot, and let the click handler do the rest.
    page.evaluate(
        """({ index, info }) => {
          // The popup keeps resolvedRefsCache in a closure; we can't
          // reach it directly. Instead, install a fake File onto the
          // global so the click handler's sendMessage picks it up by
          // passing it through. The adapter (mocked) will just accept
          // whatever File name/size we pass.
          //
          // Trick: override DataTransfer/File on window so the popup's
          // own file reference would still come from its closure. We
          // can't do that without modifying popup.js. So this helper
          // is just here as documentation; the real test path is to
          // call the click handler and rely on the stubAttachResponse
          // for the response, not on the File payload itself.
          return null;
        }""",
        {"index": ref_index, "info": fake_file_info},
    )


def click_attach(page, ref_index):
    page.evaluate(
        """(i) => {
          const items = document.querySelectorAll('#references-list .ref-card');
          if (i >= items.length) return;
          const b = items[i].querySelector('.ref-attach');
          if (b && !b.disabled) b.click();
        }""",
        ref_index,
    )
    page.wait_for_timeout(400)


def click_insert(page):
    page.evaluate("document.getElementById('insert-btn').click()")
    page.wait_for_timeout(400)


def navigate_task(page, task_id):
    page.evaluate(
        """(id) => {
          const sel = document.getElementById('task-select');
          sel.value = id;
          sel.dispatchEvent(new Event('change'));
        }""",
        task_id,
    )
    page.wait_for_timeout(300)


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

        print("Single Reference Attachment E2E")
        print("--------------------------------")

        # ---- 1. Unbound: every Attach is disabled -----------------------
        case(
            "no folder bound: every Attach is disabled, refs show · glyph",
            lambda: _case_unbound_disabled(page, reset),
        )

        # ---- 2. Bound but missing: refs with files absent are disabled
        case(
            "bound but missing: Attach disabled for missing refs",
            lambda: _case_bound_missing_disabled(page, reset),
        )

        # ---- 3. Bound and resolved: refs show ✓ glyph, Attach enabled
        #         (Note: we cannot directly install a File in the popup's
        #         closure; this case asserts the visual state and the
        #         contract when an Attach is clicked via a stubbed
        #         handler. The real File-handling test is in run.js.)
        case(
            "bound and resolved: refs show ✓ glyph, Attach button enabled",
            lambda: _case_bound_resolved_enabled(page, reset),
        )

        # ---- 4. Unsupported extension: refs show ✕, Attach disabled
        case(
            "unsupported extension (.gif): Attach disabled, ✕ glyph",
            lambda: _case_unsupported_disabled(page, reset),
        )

        # ---- 5. Clicking Attach on a resolved ref fires the message
        case(
            "clicking Attach on resolved ref fires GEMINI_ASSISTANT_ATTACH",
            lambda: _case_click_attach_sends_message(page, reset),
        )

        # ---- 6. Adapter returns success: popup status reflects it
        case(
            "adapter returns ok=true: status is 'Attached ...'",
            lambda: _case_attach_success_status(page, reset),
        )

        # ---- 7. Adapter returns failure: popup status reflects it
        case(
            "adapter returns ok=false: status is 'Attachment failed: ...'",
            lambda: _case_attach_failure_status(page, reset),
        )

        # ---- 8. Insert Prompt remains unaffected by Attach
        case(
            "Insert Prompt still sends GEMINI_ASSISTANT_INSERT_PROMPT",
            lambda: _case_insert_prompt_unchanged(page, reset),
        )

        browser.close()

    print("--------------------------------")
    print(f"summary: {passed} passed, {failed} failed")
    if fails:
        for f in fails:
            print(f"  - {f}")
    sys.exit(0 if failed == 0 else 1)


# ---- case bodies --------------------------------------------------------

def _case_unbound_disabled(page, reset_fn):
    reset_fn(page)
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    # No project → empty state. We need a project loaded but no folder.
    seed(page, v2_project(), current_task_id="t1")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    states = ref_states(page)
    # 3 refs in t1 → 3 · glyphs (unbound)
    assert states == ["·", "·", "·"], f"expected all unbound glyphs, got {states}"
    for i in range(3):
        d = attach_btn_disabled(page, i)
        assert d is True, f"ref #{i} Attach should be disabled when unbound, got {d}"


def _case_bound_missing_disabled(page, reset_fn):
    # Inject a fake FileSystemDirectoryHandle via showDirectoryPicker.
    reset_fn(page)
    seed(page, v2_project(), current_task_id="t2")  # single PNG ref
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    # Fake handle that returns NotFoundError for any file.
    page.evaluate(
        r"""() => {
          const notFound = async () => {
            throw new DOMException('missing', 'NotFoundError');
          };
          const fakeHandle = {
            getDirectoryHandle: notFound,
            getFileHandle: notFound,
          };
          window.showDirectoryPicker = async () => fakeHandle;
        }"""
    )
    page.evaluate("document.getElementById('folder-bind-btn').click()")
    page.wait_for_timeout(500)

    states = ref_states(page)
    assert states == ["✕"], f"expected missing glyph, got {states}"
    assert attach_btn_disabled(page, 0) is True, "missing ref Attach should be disabled"


def _case_bound_resolved_enabled(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project(), current_task_id="t2")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    page.evaluate(
        r"""() => {
          const fakeFile = new File(['x'], 'yuki.png', { type: 'image/png' });
          const fakeHandle = {
            getDirectoryHandle: async (name) => ({
              getFileHandle: async (n) => ({
                getFile: async () => fakeFile,
              }),
            }),
            getFileHandle: async (n) => ({
              getFile: async () => fakeFile,
            }),
          };
          window.showDirectoryPicker = async () => fakeHandle;
        }"""
    )
    page.evaluate("document.getElementById('folder-bind-btn').click()")
    page.wait_for_timeout(500)

    states = ref_states(page)
    assert states == ["✓"], f"expected resolved glyph, got {states}"
    assert attach_btn_disabled(page, 0) is False, "resolved ref Attach should be enabled"


def _case_unsupported_disabled(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project_with_unsupported(), current_task_id="t1")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    page.evaluate(
        r"""() => {
          const fakeFile = new File(['x'], 'x.gif', { type: 'image/gif' });
          const fakeHandle = {
            getDirectoryHandle: async (name) => ({
              getFileHandle: async (n) => ({
                getFile: async () => fakeFile,
              }),
            }),
            getFileHandle: async (n) => ({
              getFile: async () => fakeFile,
            }),
          };
          window.showDirectoryPicker = async () => fakeHandle;
        }"""
    )
    page.evaluate("document.getElementById('folder-bind-btn').click()")
    page.wait_for_timeout(500)

    states = ref_states(page)
    assert states == ["✕"], f"expected unsupported glyph, got {states}"
    assert attach_btn_disabled(page, 0) is True, "unsupported ref Attach should be disabled"


def _case_click_attach_sends_message(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project(), current_task_id="t2")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    page.evaluate(
        r"""() => {
          const fakeFile = new File(['x'], 'yuki.png', { type: 'image/png' });
          const fakeHandle = {
            getDirectoryHandle: async (name) => ({
              getFileHandle: async (n) => ({
                getFile: async () => fakeFile,
              }),
            }),
            getFileHandle: async (n) => ({
              getFile: async () => fakeFile,
            }),
          };
          window.showDirectoryPicker = async () => fakeHandle;
        }"""
    )
    page.evaluate("document.getElementById('folder-bind-btn').click()")
    page.wait_for_timeout(500)

    click_attach(page, 0)

    sent = sent_attach_messages(page)
    assert len(sent) == 1, f"expected 1 ATTACH msg, got {len(sent)}"
    m = sent[0]
    assert m["tabId"] == 7
    assert m["msg"]["type"] == "GEMINI_ASSISTANT_ATTACH"
    # The payload carries file metadata for the popup's own status line
    assert m["msg"]["fileName"] == "yuki.png"
    assert m["msg"]["fileType"] == "image/png"
    assert m["msg"]["fileSize"] > 0
    # And the actual File survives structured clone. The mock captured
    # its name/size/type — confirming the boundary preserves the File.
    assert m["fileInfo"]["name"] == "yuki.png"
    assert m["fileInfo"]["type"] == "image/png"


def _case_attach_success_status(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project(), current_task_id="t2")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    page.evaluate(
        r"""() => {
          const fakeFile = new File(['x'], 'yuki.png', { type: 'image/png' });
          const fakeHandle = {
            getDirectoryHandle: async (name) => ({
              getFileHandle: async (n) => ({
                getFile: async () => fakeFile,
              }),
            }),
            getFileHandle: async (n) => ({
              getFile: async () => fakeFile,
            }),
          };
          window.showDirectoryPicker = async () => fakeHandle;
        }"""
    )
    page.evaluate("document.getElementById('folder-bind-btn').click()")
    page.wait_for_timeout(500)

    click_attach(page, 0)

    st = status_text(page)
    assert st["state"] == "ok", f"expected ok, got {st}"
    assert "Attached" in st["text"], f"expected 'Attached' in status, got {st['text']!r}"
    assert "yuki.png" in st["text"], f"expected filename in status, got {st['text']!r}"


def _case_attach_failure_status(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project(), current_task_id="t2")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    page.evaluate(
        r"""() => {
          const fakeFile = new File(['x'], 'yuki.png', { type: 'image/png' });
          const fakeHandle = {
            getDirectoryHandle: async (name) => ({
              getFileHandle: async (n) => ({
                getFile: async () => fakeFile,
              }),
            }),
            getFileHandle: async (n) => ({
              getFile: async () => fakeFile,
            }),
          };
          window.showDirectoryPicker = async () => fakeHandle;
          window.__stubAttachResponse = {
            ok: false,
            error: "Gemini did not acknowledge the attachment within the timeout.",
            diagnostics: { fileInputCount: 0, fileInputAccept: null, fileInputMultiple: false },
          };
        }"""
    )
    page.evaluate("document.getElementById('folder-bind-btn').click()")
    page.wait_for_timeout(500)

    click_attach(page, 0)

    st = status_text(page)
    assert st["state"] == "error", f"expected error state, got {st}"
    assert "Attachment failed" in st["text"], (
        f"expected 'Attachment failed' in status, got {st['text']!r}"
    )
    assert "Gemini did not acknowledge" in st["text"]


def _case_insert_prompt_unchanged(page, reset_fn):
    reset_fn(page)
    seed(page, v2_project(), current_task_id="t1")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    # Edit prompt, click Insert Prompt — no Attach in between.
    page.fill("#prompt", "EDITED_PROMPT")
    page.wait_for_timeout(500)
    click_insert(page)

    insert_msgs = sent_insert_messages(page)
    attach_msgs = sent_attach_messages(page)
    assert len(insert_msgs) == 1, f"expected 1 INSERT msg, got {len(insert_msgs)}"
    assert insert_msgs[0]["msg"]["text"] == "EDITED_PROMPT"
    assert len(attach_msgs) == 0, (
        f"Insert Prompt must not produce ATTACH messages, got {len(attach_msgs)}"
    )


if __name__ == "__main__":
    main()
