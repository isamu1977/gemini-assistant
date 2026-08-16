"""
End-to-end DOM tests for the Replace confirmation modal.

This is the regression suite for the Milestone 2.1 bug where the CSS
.overlay { display: flex } was overriding the [hidden] attribute, leaving
the modal permanently visible over the popup.

Requirements: playwright (Python). Run with:
    python3 tests/e2e_modal.py

Exit code 0 on success, 1 on failure.
"""

import json
import os
import sys
from playwright.sync_api import sync_playwright

EXT_PATH = "/Users/isamumatsuyama/Documents/development/gemini-assistant"
POPUP = f"file://{EXT_PATH}/src/sidepanel/sidepanel.html"

# Mock of chrome.* APIs the popup relies on. Persists via localStorage so
# reloads (which reset the in-memory map) still see the prior writes.
MOCK = r"""
(() => {
  const read = () => JSON.parse(localStorage.getItem('mock') || '{}');
  const write = (data) => localStorage.setItem('mock', JSON.stringify(data));
  window.__mockStorage = { data: read() };
  window.chrome = {
    tabs: {
      query: (_q, cb) => cb([{ id: 1, url: 'https://gemini.google.com/app' }])
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
        }
      }
    }
  };
})();
"""


def project_a():
    return {
        "schemaVersion": 1,
        "project": {"id": "a", "name": "Project A"},
        "tasks": [
            {"id": "a1", "title": "A1", "prompt": "prompt A1"},
            {"id": "a2", "title": "A2", "prompt": "prompt A2"},
        ],
    }


def project_b():
    return {
        "schemaVersion": 1,
        "project": {"id": "b", "name": "Project B"},
        "tasks": [
            {"id": "b1", "title": "B1", "prompt": "prompt B1"},
            {"id": "b2", "title": "B2", "prompt": "prompt B2"},
            {"id": "b3", "title": "B3", "prompt": "prompt B3"},
        ],
    }


def write_project_json(path, project):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(project, f)


def write_invalid_json(path):
    with open(path, "w", encoding="utf-8") as f:
        f.write("{ not valid json")


def modal_state(page):
    """Returns dict with computed visibility of the overlay and its hidden attr."""
    return page.evaluate(
        """() => {
          const el = document.getElementById('confirm-overlay');
          const cs = getComputedStyle(el);
          return {
            hiddenAttr: el.hidden,
            display: cs.display,
            visible: cs.display !== 'none' && cs.visibility !== 'hidden',
          };
        }"""
    )


def current_project_name(page):
    """Returns the loaded project name, or '' if empty."""
    return page.evaluate(
        """() => {
          const el = document.getElementById('project-name');
          if (!el) return '';
          // When loaded-state is hidden the element still has its text content
          // from a previous render; the safer signal is the empty/loaded visibility.
          return document.getElementById('loaded-state').hidden ? '' : el.textContent;
        }"""
    )


def clear_storage(page):
    page.evaluate("window.chrome.storage.local.clear()")


def import_file(page, path):
    """Triggers the popup's hidden file input with the given path."""
    page.set_input_files("#file-input", path)
    page.wait_for_timeout(300)


def click(page, selector):
    page.evaluate(f"document.querySelector('{selector}').click()")


def wait_idle(page, ms=300):
    page.wait_for_timeout(ms)


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
    # Prepare fixtures
    a_path = "/tmp/_ga_project_a.json"
    b_path = "/tmp/_ga_project_b.json"
    bad_path = "/tmp/_ga_invalid.json"
    write_project_json(a_path, project_a())
    write_project_json(b_path, project_b())
    write_invalid_json(bad_path)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--no-sandbox"])
        ctx = browser.new_context()
        ctx.add_init_script(MOCK)

        page = ctx.new_page()
        page.goto(POPUP)
        page.wait_for_load_state("domcontentloaded")
        wait_idle(page, 500)

        # Always start from a clean slate.
        clear_storage(page)
        page.reload()
        page.wait_for_load_state("domcontentloaded")
        wait_idle(page, 500)

        print("Modal E2E")
        print("--------")

        # ---- Scenario 1: no project loaded, import directly, no modal ----
        case("1. empty state: modal invisible, then import A opens no modal", lambda: (
            _assert_modal_invisible(page),
            import_file(page, a_path),
            _assert_modal_invisible(page),
            _assert_loaded_project(page, "Project A"),
            _assert_task_count(page, 2),
        ))

        # ---- Scenario 2: project A loaded, click Replace -> modal appears ----
        case("2. with A loaded: click Replace opens modal", lambda: (
            click(page, "#reimport-btn"),
            wait_idle(page),
            _assert_modal_visible(page),
        ))

        # ---- Scenario 3: modal open -> Cancel -> modal closes, A intact ----
        case("3. Cancel closes modal and preserves A", lambda: (
            _assert_modal_visible(page),
            click(page, "#confirm-cancel"),
            wait_idle(page),
            _assert_modal_invisible(page),
            _assert_loaded_project(page, "Project A"),
            _assert_task_count(page, 2),
        ))

        # ---- Scenario 4: modal open -> Replace -> B loaded, modal closed ----
        case("4. Replace closes modal, file picker, after import B is loaded", lambda: (
            click(page, "#reimport-btn"),
            wait_idle(page),
            _assert_modal_visible(page),
            click(page, "#confirm-ok"),
            wait_idle(page, 200),
            # The confirm click should close the modal before the file picker
            # opens. Some browsers keep file picker open as a native dialog
            # that we cannot inspect; set_input_files drives the change event
            # synchronously.
            import_file(page, b_path),
            _assert_modal_invisible(page),
            _assert_loaded_project(page, "Project B"),
            _assert_task_count(page, 3),
        ))

        # ---- Scenario 5: import invalid JSON -> state unchanged, modal closed ----
        case("5. invalid JSON: state unchanged, modal stays closed", lambda: (
            click(page, "#reimport-btn"),
            wait_idle(page),
            _assert_modal_visible(page),
            click(page, "#confirm-ok"),
            wait_idle(page, 200),
            import_file(page, bad_path),
            _assert_modal_invisible(page),
            _assert_loaded_project(page, "Project B"),
            _assert_task_count(page, 3),
        ))

        # ---- Scenario 6: reopen popup after replace -> modal starts hidden ----
        case("6. reopen popup after replace: modal invisible at init", lambda: (
            page.reload(),
            page.wait_for_load_state("domcontentloaded"),
            wait_idle(page, 500),
            _assert_modal_invisible(page),
            _assert_loaded_project(page, "Project B"),
        ))

        # Cleanup
        os.unlink(a_path)
        os.unlink(b_path)
        os.unlink(bad_path)

        browser.close()

    print("--------")
    print(f"summary: {passed} passed, {failed} failed")
    if failures:
        print("failed cases:")
        for f in failures:
            print(f"  - {f}")
    sys.exit(0 if failed == 0 else 1)


# ----- assertion helpers (closures so case() can compose them) -----

def _assert_modal_visible(page):
    s = modal_state(page)
    assert s["visible"], f"expected modal visible, got {s}"


def _assert_modal_invisible(page):
    s = modal_state(page)
    assert not s["visible"], f"expected modal hidden, got {s}"


def _assert_loaded_project(page, name):
    got = current_project_name(page)
    assert got == name, f"expected loaded project '{name}', got '{got}'"


def _assert_task_count(page, n):
    total = page.evaluate(
        """() => {
          const empty = document.getElementById('empty-state').hidden;
          if (empty) return parseInt(document.getElementById('task-total').textContent, 10);
          return 0;
        }"""
    )
    assert total == n, f"expected {n} tasks, got {total}"


# Compose the lambdas inside main() to capture the local helpers
def _install_helpers():
    pass  # placeholder; helpers are defined as module-level functions above


_install_helpers()

if __name__ == "__main__":
    main()
