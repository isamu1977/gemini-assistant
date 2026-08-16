"""
End-to-end DOM tests for the Insert Prompt flow.

This is the regression suite for the v0.2.2 bug where the Insert button
listener was missing, making the click a no-op.

The popup runs in a regular browser context (no real Chrome extension
loaded), so we mock `chrome.tabs.sendMessage` to:
  - capture the message the popup would send
  - return a stubbed response (simulating the content script)

Each test then asserts:
  - clicking the button results in the correct message being sent
  - the popup status line reflects success or failure

Run with:
    python3 tests/e2e_insert.py

Exits 0 on success, 1 on failure. Requires `playwright` (Python).
"""

import sys
from playwright.sync_api import sync_playwright

EXT_PATH = "/Users/isamumatsuyama/Documents/development/gemini-assistant"
POPUP = f"file://{EXT_PATH}/src/sidepanel/sidepanel.html"

# Mock chrome.* APIs. sendMessage is wrapped to capture the messages and
# return a configurable response (success or failure path).
MOCK = r"""
(() => {
  const read = () => JSON.parse(localStorage.getItem('mock') || '{}');
  const write = (data) => localStorage.setItem('mock', JSON.stringify(data));
  window.__mockStorage = { data: read() };
  window.__sentMessages = [];
  // Stubbed response: { ok: true, length, method } or { ok: false, error }
  window.__stubResponse = null;
  window.chrome = {
    tabs: {
      query: (_q, cb) => cb([{ id: 7, url: 'https://gemini.google.com/app' }]),
      sendMessage: (tabId, msg, cb) => {
        window.__sentMessages.push({ tabId, msg });
        const resp = window.__stubResponse || {
          ok: true,
          length: (msg.text || '').length,
          method: 'quill',
        };
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


def project_a():
    return {
        "schemaVersion": 1,
        "project": {"id": "a", "name": "InsertTest"},
        "tasks": [
            {"id": "a1", "title": "A1 original", "prompt": "ORIGINAL_PROMPT_1"},
            {
                "id": "a2",
                "title": "A2 multiline",
                "prompt": "Line one\nLine two\nLine three",
            },
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
          window.__stubResponse = null;
        }"""
    )


def status_text(page):
    return page.evaluate(
        """() => ({
          state: document.getElementById('status').dataset.state,
          text: document.getElementById('status-text').textContent,
        })"""
    )


def find_insert_message(page):
    msgs = page.evaluate("window.__sentMessages")
    for m in msgs:
        if m.get("msg", {}).get("type") == "GEMINI_ASSISTANT_INSERT_PROMPT":
            return m
    return None


def prompt_value(page):
    return page.evaluate("document.getElementById('prompt').value")


passed = 0
failed = 0
failures = []


def case(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS  {name}")
        passed += 1
    except AssertionError as e:
        print(f"  FAIL  {name}: {e}")
        failed += 1
        failures.append(name)
    except Exception as e:
        print(f"  ERROR {name}: {type(e).__name__}: {e}")
        failed += 1
        failures.append(name)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--no-sandbox"])
        ctx = browser.new_context()
        ctx.add_init_script(MOCK)

        page = ctx.new_page()
        page.goto(POPUP)
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(500)

        print("Insert Prompt E2E")
        print("-----------------")

        # ---- 1. Empty state: no project, clicking Insert should fail safely
        case(
            "no project loaded: Insert click shows error, no crash",
            lambda: _case_no_project(page, reset, status_text),
        )

        # Seed project and reload for all subsequent cases
        proj = project_a()
        seed(page, proj)
        page.reload()
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(500)

        # ---- 2. Original prompt of the first task
        case(
            "Task 1: click Insert sends {type, text} with original prompt",
            lambda: _case_original_prompt(page, reset, proj, status_text, find_insert_message, prompt_value),
        )

        # ---- 3. Locally edited prompt
        case(
            "Task 1: edit prompt, then Insert sends the edited text",
            lambda: _case_edited_prompt(page, reset, proj, status_text, find_insert_message, prompt_value),
        )

        # ---- 4. Multiline prompt
        case(
            "Task 2 (multiline): Insert sends full multiline text verbatim",
            lambda: _case_multiline(page, reset, proj, status_text, find_insert_message, prompt_value),
        )

        # ---- 5. Large prompt
        case(
            "large prompt (~50KB) is sent verbatim",
            lambda: _case_large_prompt(page, reset, proj, status_text, find_insert_message, prompt_value),
        )

        # ---- 6. Close + reopen popup, then Insert
        case(
            "popup reload: state restored, Insert still works",
            lambda: _case_reload_then_insert(page, reset, proj, status_text, find_insert_message, prompt_value),
        )

        # ---- 7. Navigate Next, then Insert of new task
        case(
            "Next, then Insert: payload carries the new task's prompt",
            lambda: _case_next_then_insert(page, reset, proj, status_text, find_insert_message, prompt_value),
        )

        # ---- 8. Navigate Previous, then Insert of original task
        case(
            "Previous, then Insert: payload carries the previous task's prompt",
            lambda: _case_prev_then_insert(page, reset, proj, status_text, find_insert_message, prompt_value),
        )

        # ---- 9. Content script returns failure: popup shows "Failed to insert"
        case(
            "Insert failure path: popup shows Failed to insert prompt: ...",
            lambda: _case_failure_response(page, reset, proj, status_text),
        )

        browser.close()

    print("-----------------")
    print(f"summary: {passed} passed, {failed} failed")
    if failures:
        print("failed cases:")
        for f in failures:
            print(f"  - {f}")
    sys.exit(0 if failed == 0 else 1)


# ---- case bodies --------------------------------------------------------

def _click_insert(page):
    page.evaluate("document.getElementById('insert-btn').click()")
    page.wait_for_timeout(400)


def _case_no_project(page, reset_fn, status_fn):
    reset_fn(page)
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)
    # In empty state the Insert button doesn't exist; even if it did,
    # no project loaded means no mutation happened and we should not
    # send any INSERT_PROMPT. The init ping is expected and not asserted.
    # Click via JS in case the button is present but disabled.
    page.evaluate(
        "document.getElementById('insert-btn')?.click()"
    )
    page.wait_for_timeout(300)
    msgs = page.evaluate("window.__sentMessages")
    has_insert = any(
        m.get("msg", {}).get("type") == "GEMINI_ASSISTANT_INSERT_PROMPT"
        for m in msgs
    )
    assert not has_insert, f"unexpected INSERT_PROMPT captured: {msgs}"
    st = status_fn(page)
    assert "Inserted" not in st["text"], f"unexpected success status: {st}"


def _case_original_prompt(page, reset_fn, proj, status_fn, find_fn, prompt_fn):
    reset_fn(page)
    seed(page, proj, current_task_id="a1")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)

    assert prompt_fn(page) == "ORIGINAL_PROMPT_1"

    _click_insert(page)

    msg = find_fn(page)
    assert msg is not None, "no INSERT_PROMPT message captured"
    assert msg["tabId"] == 7, f"sent to wrong tab: {msg['tabId']}"
    assert msg["msg"]["type"] == "GEMINI_ASSISTANT_INSERT_PROMPT"
    assert msg["msg"]["text"] == "ORIGINAL_PROMPT_1"

    st = status_fn(page)
    assert st["state"] == "ok", f"expected ok status, got {st}"
    assert "Prompt inserted into Gemini" in st["text"]
    assert "ORIGINAL_PROMPT_1" not in st["text"]  # don't echo prompt into status


def _case_edited_prompt(page, reset_fn, proj, status_fn, find_fn, prompt_fn):
    reset_fn(page)
    seed(page, proj, current_task_id="a1")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)

    page.fill("#prompt", "EDITED_TEXT_42")
    page.wait_for_timeout(600)  # past the 350ms debounce

    _click_insert(page)

    msg = find_fn(page)
    assert msg is not None
    assert msg["msg"]["text"] == "EDITED_TEXT_42", (
        f"expected EDITED_TEXT_42, got {msg['msg']['text']!r}"
    )

    # Verify the edit was persisted (so close/reopen keeps it)
    stored = page.evaluate("window.__mockStorage.data.state_v1.tasks.a1.prompt")
    assert stored == "EDITED_TEXT_42", f"expected stored prompt, got {stored!r}"


def _case_multiline(page, reset_fn, proj, status_fn, find_fn, prompt_fn):
    reset_fn(page)
    seed(page, proj, current_task_id="a2")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)

    assert "\n" in prompt_fn(page), "fixture sanity check failed"
    expected = "Line one\nLine two\nLine three"

    _click_insert(page)

    msg = find_fn(page)
    assert msg is not None
    assert msg["msg"]["text"] == expected, (
        f"expected {expected!r}, got {msg['msg']['text']!r}"
    )


def _case_large_prompt(page, reset_fn, proj, status_fn, find_fn, prompt_fn):
    reset_fn(page)
    big = ("X" * 50000) + "\nEND"
    expected_len = len(big)  # 50004
    page.evaluate(
        """(big) => {
          const proj = {
            schemaVersion: 1,
            project: { id: 'big', name: 'Big' },
            tasks: [{ id: 'big1', title: 'B1', prompt: big }],
          };
          const state = {
            schemaVersion: 1,
            source: { project: proj, importedAt: 1 },
            tasks: { big1: { status: 'pending', prompt: big } },
            currentTaskId: 'big1',
          };
          window.chrome.storage.local.set({ state_v1: state });
        }""",
        big,
    )
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(1500)

    actual = prompt_fn(page)
    assert len(actual) == expected_len, (
        f"expected prompt len {expected_len}, got {len(actual)}"
    )

    _click_insert(page)

    msg = find_fn(page)
    assert msg is not None, "no INSERT_PROMPT captured"
    assert msg["msg"]["text"] == big, (
        f"payload length {len(msg['msg']['text'])}, expected {expected_len}"
    )
    assert len(msg["msg"]["text"]) == expected_len


def _case_reload_then_insert(page, reset_fn, proj, status_fn, find_fn, prompt_fn):
    reset_fn(page)
    seed(page, proj, current_task_id="a1")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)

    # Simulate close + reopen
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)

    assert prompt_fn(page) == "ORIGINAL_PROMPT_1"
    _click_insert(page)

    msg = find_fn(page)
    assert msg is not None and msg["msg"]["text"] == "ORIGINAL_PROMPT_1"


def _case_next_then_insert(page, reset_fn, proj, status_fn, find_fn, prompt_fn):
    reset_fn(page)
    seed(page, proj, current_task_id="a1")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)

    # Navigate to a2
    page.evaluate("document.getElementById('next-btn').click()")
    page.wait_for_timeout(400)

    assert prompt_fn(page) == "Line one\nLine two\nLine three"

    _click_insert(page)

    msg = find_fn(page)
    assert msg is not None
    assert msg["msg"]["text"] == "Line one\nLine two\nLine three"


def _case_prev_then_insert(page, reset_fn, proj, status_fn, find_fn, prompt_fn):
    reset_fn(page)
    seed(page, proj, current_task_id="a2")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)

    page.evaluate("document.getElementById('prev-btn').click()")
    page.wait_for_timeout(400)

    assert prompt_fn(page) == "ORIGINAL_PROMPT_1"

    _click_insert(page)

    msg = find_fn(page)
    assert msg is not None
    assert msg["msg"]["text"] == "ORIGINAL_PROMPT_1"


def _case_failure_response(page, reset_fn, proj, status_fn):
    reset_fn(page)
    seed(page, proj, current_task_id="a1")
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(500)

    page.evaluate(
        """() => {
          window.__stubResponse = {
            ok: false,
            error: 'Gemini prompt input not found. Are you signed in and on the chat screen?',
          };
        }"""
    )
    _click_insert(page)

    st = status_fn(page)
    assert st["state"] == "error", f"expected error state, got {st}"
    assert "Failed to insert prompt" in st["text"], (
        f"expected 'Failed to insert prompt' in status, got {st['text']!r}"
    )
    assert "Gemini prompt input not found" in st["text"]


if __name__ == "__main__":
    main()