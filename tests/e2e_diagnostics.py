"""
End-to-end DOM tests for the v0.5.1 diagnostic and content-script
contract additions: ATTACH_PROBE.

Run with:
    python3 tests/e2e_diagnostics.py
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
  window.__stubProbeResponse = null;
  window.chrome = {
    tabs: {
      query: (_q, cb) => cb([{ id: 7, url: 'https://gemini.google.com/app' }]),
      sendMessage: (tabId, msg, cb) => {
        window.__sentMessages.push({ tabId, msg });
        let resp;
        if (msg && msg.type === 'GEMINI_ASSISTANT_ATTACH_PROBE') {
          resp = window.__stubProbeResponse || {
            ok: true,
            probe: {
              probeAt: '2026-08-16T00:00:00.000Z',
              url: 'https://gemini.google.com/app',
              triggerFound: true,
              triggerDescriptor: {
                tag: 'button',
                ariaLabel: 'Open attachment menu',
                ariaHasPopup: 'menu',
                classHint: 'mat-icon-button',
              },
              fileInputCount: 0,
              fileInputAccept: null,
              fileInputMultiple: false,
              menuOrPopoverOpen: false,
              attachmentAreaFound: true,
              currentHints: 0,
              inputLikelyDynamic: true,
              notes: ['No <input type="file"> currently mounted.'],
            },
          };
        } else if (msg && msg.type === 'GEMINI_ASSISTANT_PING') {
          resp = {
            ok: true,
            url: 'https://gemini.google.com/app',
            selfTest: {
              url: 'https://gemini.google.com/app',
              attachment: {
                triggerFound: true,
                fileInputCount: 0,
                fileInputAccept: null,
                fileInputMultiple: false,
                menuOrPopoverOpen: false,
                attachmentAreaFound: true,
                currentHints: 0,
                inputLikelyDynamic: true,
              },
            },
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
        },
        "tasks": [
            {
                "id": "t1",
                "title": "Single",
                "prompt": "p1",
                "references": ["character-main"],
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
          window.__stubProbeResponse = null;
        }"""
    )


def attachment_diagnostics_html(page):
    return page.evaluate(
        """() => {
          const dd = document.getElementById('attachment-diagnostics');
          if (!dd) return null;
          const items = [];
          for (const dt of dd.querySelectorAll('dt')) {
            const ddEl = dt.nextElementSibling;
            items.push({ label: dt.textContent, value: ddEl ? ddEl.textContent : '' });
          }
          return items;
        }"""
    )


def attachment_summary(page):
    return page.evaluate("document.getElementById('attachment-summary').textContent")


def click_probe(page):
    page.evaluate("document.getElementById('probe-attachment-btn').click()")
    page.wait_for_timeout(400)


def sent_probe_messages(page):
    msgs = page.evaluate("window.__sentMessages")
    return [m for m in msgs if m.get("msg", {}).get("type") == "GEMINI_ASSISTANT_ATTACH_PROBE"]


def status_text(page):
    return page.evaluate(
        """() => ({
          state: document.getElementById('status').dataset.state,
          text: document.getElementById('status-text').textContent,
        })"""
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

        print("Attachment Diagnostics E2E (v0.5.1)")
        print("---------------------------------")

        case(
            "on Gemini: initial probe shows trigger found, input not mounted",
            lambda: _case_initial_probe(page, reset, v2_project, seed, attachment_diagnostics_html, attachment_summary),
        )

        case(
            "clicking Probe fires GEMINI_ASSISTANT_ATTACH_PROBE",
            lambda: _case_probe_click(page, reset, v2_project, seed, click_probe, sent_probe_messages),
        )

        case(
            "probe response renders structured diagnostics (no error)",
            lambda: _case_probe_renders(page, reset, v2_project, seed, click_probe, attachment_diagnostics_html),
        )

        case(
            "fileInputCount=0 is NOT treated as an error when inputLikelyDynamic=true",
            lambda: _case_no_input_not_error(page, reset, v2_project, seed, status_text),
        )

        case(
            "stubbed probe failure surfaces an error in the status line",
            lambda: _case_probe_failure(page, reset, v2_project, seed, click_probe, status_text),
        )

        browser.close()

    print("---------------------------------")
    print(f"summary: {passed} passed, {failed} failed")
    if fails:
        for f in fails:
            print(f"  - {f}")
    sys.exit(0 if failed == 0 else 1)


def _case_initial_probe(page, reset_fn, project_fn, seed_fn, diag_fn, summary_fn):
    reset_fn(page)
    seed_fn(page, project_fn())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    # The initial load opens the Attachment section's probe via PING.
    items = diag_fn(page)
    assert items is not None, "diagnostics list not present"
    labels = [i["label"] for i in items]
    assert "Trigger" in labels, f"expected 'Trigger' label, got {labels}"
    # The mock returns triggerFound=true, fileInputCount=0, inputLikelyDynamic=true
    by_label = {i["label"]: i["value"] for i in items}
    assert "found" in by_label["Trigger"], f"got {by_label['Trigger']!r}"
    assert "no file input" in by_label["Input mounted"], f"got {by_label['Input mounted']!r}"
    assert "yes" in by_label["Likely dynamic"], f"got {by_label['Likely dynamic']!r}"

    # Summary badge reads "menu closed" (because no input is mounted).
    summary = summary_fn(page)
    assert "menu closed" in summary or "ready" in summary, f"summary: {summary!r}"


def _case_probe_click(page, reset_fn, project_fn, seed_fn, click_probe_fn, sent_fn):
    reset_fn(page)
    seed_fn(page, project_fn())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    page.evaluate("window.__sentMessages = []")
    click_probe_fn(page)
    msgs = sent_fn(page)
    assert len(msgs) == 1, f"expected 1 probe msg, got {len(msgs)}"
    assert msgs[0]["tabId"] == 7
    assert msgs[0]["msg"]["type"] == "GEMINI_ASSISTANT_ATTACH_PROBE"


def _case_probe_renders(page, reset_fn, project_fn, seed_fn, click_probe_fn, diag_fn):
    reset_fn(page)
    seed_fn(page, project_fn())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    click_probe_fn(page)
    items = diag_fn(page)
    labels = [i["label"] for i in items]
    for required in ["Trigger", "Input mounted", "Menu open", "Attachment area", "Current hints", "Likely dynamic"]:
        assert required in labels, f"missing {required!r}, got {labels}"


def _case_no_input_not_error(page, reset_fn, project_fn, seed_fn, status_fn):
    reset_fn(page)
    seed_fn(page, project_fn())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    click_probe(page)
    st = status_fn(page)
    # The mock probe succeeds (ok=true). The panel should treat that as
    # an info or ok state, NOT an error.
    assert st["state"] != "error", f"expected non-error state, got {st!r}"


def _case_probe_failure(page, reset_fn, project_fn, seed_fn, click_probe_fn, status_fn):
    reset_fn(page)
    seed_fn(page, project_fn())
    page.reload()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    page.evaluate(
        "() => { window.__stubProbeResponse = { ok: false, error: 'synthetic failure' }; }"
    )
    click_probe_fn(page)
    st = status_fn(page)
    assert st["state"] == "error", f"expected error, got {st!r}"
    assert "synthetic failure" in st["text"], f"got {st['text']!r}"


if __name__ == "__main__":
    main()
