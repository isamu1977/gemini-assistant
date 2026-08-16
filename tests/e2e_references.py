"""
End-to-end DOM tests for the v0.3.0 References and Asset Catalog UI.

Run with:
    python3 tests/e2e_references.py
"""

import json
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
  window.chrome = {
    tabs: {
      query: (_q, cb) => cb([{ id: 7, url: 'https://gemini.google.com/app' }]),
      sendMessage: (tabId, msg, cb) => {
        window.__sentMessages.push({ tabId, msg });
        const resp = window.__stubResponse || {
          ok: true, length: (msg.text || '').length, method: 'quill',
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


def v1_project():
    return {
        "schemaVersion": 1,
        "project": {"id": "v1", "name": "V1 no-assets"},
        "tasks": [
            {"id": "a", "prompt": "p a"},
            {"id": "b", "prompt": "p b"},
        ],
    }


def v2_project():
    return {
        "schemaVersion": 2,
        "project": {"id": "v2", "name": "V2 with assets"},
        "assets": {
            "character-main": {"label": "Main", "type": "character",
                               "file": "refs/main.png"},
            "environment-village": {"label": "Village", "type": "environment",
                                    "file": "refs/village.png"},
            "style-master": {"label": "Master Style", "type": "style",
                             "file": "refs/master.png"},
        },
        "tasks": [
            {"id": "t1", "prompt": "p1", "references": ["character-main", "style-master"]},
            {"id": "t2", "prompt": "p2"},
            {"id": "t3", "prompt": "p3", "references": ["environment-village"]},
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
          window.__stubResponse = null;
        }"""
    )


def references_html(page):
    return page.evaluate(
        """() => {
          const items = Array.from(document.querySelectorAll('#references-list .ref-card'));
          return items.map(li => ({
            badge: li.querySelector('.ref-badge')?.textContent || '',
            label: li.querySelector('.ref-label')?.textContent || '',
            file: li.querySelector('.ref-file')?.textContent || '',
          }));
        }"""
    )


def refs_count(page):
    return page.text_content("#references-count")


def refs_empty_visible(page):
    return not page.evaluate("document.getElementById('references-empty').hidden")


def assets_panel_visible(page):
    return not page.evaluate("document.getElementById('assets-panel').hidden")


def assets_count(page):
    return page.evaluate("document.querySelectorAll('#assets-list .asset-item').length")


def project_stats_text(page):
    return page.text_content("#project-stats")


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

        print("References E2E")
        print("--------------")

        # ---- v1 project: no assets panel, no references ----
        case(
            "v1 project: no references shown, no assets panel",
            lambda: _case_v1_no_assets(page, reset, seed, refs_count, refs_empty_visible, assets_panel_visible, project_stats_text),
        )

        # ---- v2 project: t1 has 2 references, t2 has 0, t3 has 1 ----
        case(
            "v2 task with references: badges, labels, files shown in declared order",
            lambda: _case_v2_first_task(page, reset, seed, references_html, refs_count, refs_empty_visible),
        )

        case(
            "v2 task without references: empty message, count=0",
            lambda: _case_v2_no_references(page, reset, seed, refs_count, refs_empty_visible, references_html),
        )

        case(
            "v2 task with single reference: only that one shown",
            lambda: _case_v2_single_ref(page, reset, seed, references_html, refs_count),
        )

        case(
            "v2 assets panel: visible, count matches project.assets",
            lambda: _case_assets_panel(page, reset, seed, assets_panel_visible, assets_count, project_stats_text),
        )

        case(
            "Navigate Prev/Next: references list updates",
            lambda: _case_navigation_updates(page, reset, seed, references_html, refs_count),
        )

        case(
            "Edit prompt, Insert Prompt: payload is prompt only (no references)",
            lambda: _case_insert_unchanged(page, reset, seed, v2_project),
        )

        case(
            "Popup reload preserves references state",
            lambda: _case_reload(page, reset, seed, references_html),
        )

        browser.close()

    print("--------------")
    print(f"summary: {passed} passed, {failed} failed")
    if fails:
        for f in fails:
            print(f"  - {f}")
    sys.exit(0 if failed == 0 else 1)


# ---- cases ---------------------------------------------------------------

def _case_v1_no_assets(page, reset_fn, seed_fn, rc, empty_v, panel_v, stats_text):
    reset_fn(page)
    seed_fn(page, v1_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    assert rc(page) == "0", f"expected 0 refs, got {rc(page)}"
    assert empty_v(page), "expected empty message visible"
    assert not panel_v(page), "assets panel should be hidden for v1"
    assert stats_text(page) == "", "project stats should be hidden for v1"


def _case_v2_first_task(page, reset_fn, seed_fn, refs_html, rc, empty_v):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    items = refs_html(page)
    assert len(items) == 2, f"expected 2 refs, got {len(items)}"
    assert rc(page) == "2"
    assert not empty_v(page), "empty msg should be hidden"
    # Order preserved
    assert items[0]["badge"] == "character"
    assert items[0]["label"] == "Main"
    assert items[0]["file"] == "refs/main.png"
    assert items[1]["badge"] == "style"


def _case_v2_no_references(page, reset_fn, seed_fn, rc, empty_v, refs_html):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    # Navigate to t2 (no references)
    page.evaluate(
        """() => {
          const sel = document.getElementById('task-select');
          sel.value = 't2';
          sel.dispatchEvent(new Event('change'));
        }"""
    )
    page.wait_for_timeout(300)
    assert rc(page) == "0"
    assert empty_v(page), "expected empty msg visible"
    assert refs_html(page) == [], "expected no ref items"


def _case_v2_single_ref(page, reset_fn, seed_fn, refs_html, rc):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    page.evaluate(
        """() => {
          const sel = document.getElementById('task-select');
          sel.value = 't3';
          sel.dispatchEvent(new Event('change'));
        }"""
    )
    page.wait_for_timeout(300)
    items = refs_html(page)
    assert len(items) == 1
    assert items[0]["badge"] == "environment"
    assert items[0]["label"] == "Village"
    assert items[0]["file"] == "refs/village.png"
    assert rc(page) == "1"


def _case_assets_panel(page, reset_fn, seed_fn, panel_v, count_fn, stats_text):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    assert panel_v(page), "assets panel should be visible"
    assert count_fn(page) == 3, "expected 3 asset items"
    assert "3 assets" in stats_text(page), f"got {stats_text(page)!r}"


def _case_navigation_updates(page, reset_fn, seed_fn, refs_html, rc):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    # Initial: t1 has 2 refs
    assert len(refs_html(page)) == 2
    # Next to t2 (no refs)
    page.evaluate("document.getElementById('next-btn').click()")
    page.wait_for_timeout(300)
    assert rc(page) == "0"
    assert refs_html(page) == []
    # Next to t3 (1 ref)
    page.evaluate("document.getElementById('next-btn').click()")
    page.wait_for_timeout(300)
    items = refs_html(page)
    assert len(items) == 1
    assert items[0]["label"] == "Village"
    # Prev to t2
    page.evaluate("document.getElementById('prev-btn').click()")
    page.wait_for_timeout(300)
    assert rc(page) == "0"


def _case_insert_unchanged(page, reset_fn, seed_fn, project_fn):
    reset_fn(page)
    seed_fn(page, project_fn())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    page.fill("#prompt", "EDITED")
    page.wait_for_timeout(500)
    page.evaluate("document.getElementById('insert-btn').click()")
    page.wait_for_timeout(400)
    msgs = page.evaluate("window.__sentMessages")
    insert = [m for m in msgs if m["msg"].get("type") == "GEMINI_ASSISTANT_INSERT_PROMPT"]
    assert len(insert) == 1, f"expected 1 insert msg, got {len(insert)}"
    # The payload MUST be the prompt only — references are not sent yet
    # (future milestone will add upload).
    payload = insert[0]["msg"]
    assert payload["text"] == "EDITED", f"unexpected payload: {payload}"
    assert "references" not in payload, "references must not be in payload yet"


def _case_reload(page, reset_fn, seed_fn, refs_html):
    reset_fn(page)
    seed_fn(page, v2_project())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    items_before = refs_html(page)
    assert len(items_before) == 2
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    items_after = refs_html(page)
    assert len(items_after) == 2
    assert items_after[0]["label"] == items_before[0]["label"]
    assert items_after[0]["file"] == items_before[0]["file"]


if __name__ == "__main__":
    main()