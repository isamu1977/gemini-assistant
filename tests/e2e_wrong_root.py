"""
End-to-end DOM tests for the v0.5.1 wrong-root selection detection in
the side panel UI.

Run with:
    python3 tests/e2e_wrong_root.py
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
  window.__showDirectoryPickerImpl = null;
  window.chrome = {
    tabs: {
      query: (_q, cb) => cb([{ id: 7, url: 'https://gemini.google.com/app' }]),
      sendMessage: (tabId, msg, cb) => { cb && cb({ ok: true }); },
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
                "label": "Yuki", "type": "character", "file": "references/yuki.png",
            },
            "environment-village": {
                "label": "Village", "type": "environment", "file": "references/village.jpg",
            },
        },
        "tasks": [
            {
                "id": "t1",
                "title": "Both",
                "prompt": "p1",
                "references": ["character-main", "environment-village"],
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
    page.evaluate("(s) => window.chrome.storage.local.set({ state_v1: s })", state)


def reset(page):
    page.evaluate(
        """() => {
          window.chrome.storage.local.clear();
          window.__sentMessages = [];
          window.__showDirectoryPickerImpl = null;
        }"""
    )


def install_picker(page, handle_js):
    """Install a fake showDirectoryPicker that returns the given handle.

    handle_js is a JavaScript expression that evaluates to a handle object.
    """
    page.evaluate(
        """(handleJs) => {
          window.showDirectoryPicker = async () => {
            return await new Function('return ' + handleJs)();
          };
        }""",
        handle_js,
    )


def wrong_root_visible(page):
    return not page.evaluate(
        "document.getElementById('wrong-root-banner').hidden"
    )


def wrong_root_body(page):
    return page.evaluate("document.getElementById('wrong-root-body').textContent")


def folder_binding_name(page):
    return page.evaluate(
        "document.getElementById('folder-binding-name').textContent"
    )


def ref_state_glyphs(page):
    return page.evaluate(
        """() => Array.from(document.querySelectorAll('#references-list .ref-card .ref-state'))
            .map(s => s.textContent)"""
    )


def click_bind(page):
    page.evaluate("document.getElementById('folder-bind-btn').click()")
    page.wait_for_timeout(500)


def click_rebind(page):
    page.evaluate("document.getElementById('wrong-root-rebind').click()")
    page.wait_for_timeout(500)


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

        print("Wrong-root selection E2E (v0.5.1)")
        print("--------------------------------")

        case(
            "selecting 'references' subfolder triggers the wrong-root banner",
            lambda: _case_wrong_root_detected(page, reset, seed, install_picker, click_bind, wrong_root_visible, wrong_root_body, ref_state_glyphs, folder_binding_name),
        )

        case(
            "banner body mentions the selected folder, the first segment, and 'project root'",
            lambda: _case_wrong_root_message(page, reset, seed, install_picker, click_bind, wrong_root_body),
        )

        case(
            "all refs remain Missing while the wrong-root banner is shown",
            lambda: _case_refs_missing(page, reset, seed, install_picker, click_bind, ref_state_glyphs),
        )

        case(
            "wrong-root banner is hidden when the spot-check I/O fails",
            lambda: _case_no_false_positive(page, reset, seed, install_picker, click_bind, wrong_root_visible),
        )

        case(
            "Rebind button in the banner re-opens the folder picker",
            lambda: _case_rebind_button(page, reset, seed, install_picker, click_bind, wrong_root_visible, click_rebind),
        )

        browser.close()

    print("--------------------------------")
    print(f"summary: {passed} passed, {failed} failed")
    if fails:
        for f in fails:
            print(f"  - {f}")
    sys.exit(0 if failed == 0 else 1)


def _case_wrong_root_detected(
    page, reset_fn, seed_fn, install_picker_fn, click_bind_fn, is_visible, body, glyphs, folder_name
):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    # Simulate the user picking the "references" subfolder. The picker
    # returns a handle whose name is "references" and whose getFileHandle
    # succeeds for the basename (the file would be found at
    # references/yuki.png, but the user picked references/ so the
    # basename "yuki.png" exists at the bound root).
    install_picker_fn(
        page,
        r"""({
          name: 'references',
          async getFileHandle(name) {
            if (name === 'yuki.png' || name === 'village.jpg') {
              return { async getFile() { return { name, type: 'image/png', size: 1 }; } };
            }
            throw new DOMException('missing', 'NotFoundError');
          }
        })"""
    )
    click_bind_fn(page)
    assert is_visible(page), "wrong-root banner should be visible"
    assert "references" in folder_name(page), f"folder name: {folder_name(page)!r}"
    # 2 refs in t1, both still missing at the wrong-root page.
    assert glyphs(page) == ["✕", "✕"], f"expected both missing, got {glyphs(page)}"


def _case_wrong_root_message(page, reset_fn, seed_fn, install_picker_fn, click_bind_fn, body_fn):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    install_picker_fn(
        page,
        r"""({
          name: 'references',
          async getFileHandle(name) {
            return { async getFile() { return { name, type: 'image/png', size: 1 }; } };
          }
        })"""
    )
    click_bind_fn(page)
    text = body_fn(page)
    assert "references" in text, f"banner body should mention 'references': {text!r}"
    assert "project root" in text.lower(), f"banner body should say 'project root': {text!r}"


def _case_refs_missing(page, reset_fn, seed_fn, install_picker_fn, click_bind_fn, glyphs):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    install_picker_fn(
        page,
        r"""({
          name: 'references',
          async getFileHandle(name) {
            return { async getFile() { return { name, type: 'image/png', size: 1 }; } };
          }
        })"""
    )
    click_bind_fn(page)
    # Both refs missing is expected: at the wrong-root level, the resolver
    # walks references/<first-segment>/<basename> = references/references/<basename>.
    out = glyphs(page)
    assert out == ["✕", "✕"], f"expected 2 missing glyphs, got {out}"


def _case_no_false_positive(page, reset_fn, seed_fn, install_picker_fn, click_bind_fn, is_visible):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    # Simulate the user picking the correct project root: name is
    # "my-project" so the heuristic does not match. Spot-check I/O throws
    # for the basename (because the file is in refs/, not at the root).
    install_picker_fn(
        page,
        r"""({
          name: 'my-project',
          async getFileHandle(name) {
            throw new DOMException('missing', 'NotFoundError');
          }
        })"""
    )
    click_bind_fn(page)
    assert not is_visible(page), "wrong-root banner should NOT be shown for the correct root"


def _case_rebind_button(page, reset_fn, seed_fn, install_picker_fn, click_bind_fn, is_visible, click_rebind_fn):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    install_picker_fn(
        page,
        r"""({
          name: 'references',
          async getFileHandle(name) {
            return { async getFile() { return { name, type: 'image/png', size: 1 }; } };
          }
        })"""
    )
    click_bind_fn(page)
    assert is_visible(page), "wrong-root banner must be visible"
    # The Rebind button in the banner re-opens the picker. We just need
    # to confirm it exists and is enabled; the prompt cancellation is
    # not relevant here.
    page.evaluate(
        """() => {
          window.__showDirectoryPickerCalled = false;
          window.showDirectoryPicker = async () => {
            window.__showDirectoryPickerCalled = true;
            throw new DOMException('cancelled', 'AbortError');
          };
        }"""
    )
    click_rebind_fn(page)
    called = page.evaluate("window.__showDirectoryPickerCalled === true")
    assert called, "Rebind button should re-open the folder picker"


if __name__ == "__main__":
    main()
