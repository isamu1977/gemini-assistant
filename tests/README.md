# Tests

Run the test suite with plain Node (no dependencies):

```bash
node tests/run.js
```

The runner exits `0` on success, `1` on failure.

## What's covered

### `src/lib/project.js` (17 tests)
- Parse valid JSON
- Reject invalid syntax (`Invalid JSON: ...`)
- Reject unsupported `schemaVersion`
- Reject empty tasks array
- Reject duplicate task ids
- Reject missing/empty prompt
- Initial task state built with `pending` and prompt copied from source
- `firstTaskId` returns the first task or `null`
- `nextTaskId` / `prevTaskId` walk in array order, return `null` at boundaries
- `summarizeProgress` counts by status; ignores unknown statuses
- `isValidStatus` strict enum check
- `normalizeImportedProject` fills missing title with empty string
- `STATUSES` is frozen and in spec order
- Shipped `examples/example-project.json` parses and contains the expected markers

### `src/lib/storage.js` (7 tests)
- `emptyState` has expected shape
- `loadState` returns empty state on first run
- `saveState` + `loadState` roundtrip preserves data
- Editing a task and saving persists the edit; source stays intact
- `coerceState` rejects unknown schemaVersion
- `coerceState` accepts `null` / `undefined` / garbage
- `clearAll` wipes the store

## Adding tests

Append cases to the `tests/run.js` file using the existing helpers:

```js
test("description", () => {
  // setup, exercise, assert
});
```

The runner resets the storage shim between tests via
`storageLib._resetForTests()`. The shim activates only when `chrome.*`
APIs are not present (e.g., in Node), so the same code runs in both
extension and test environments.

## Manual regression for the Gemini DOM adapter

The PoC's main user-visible behavior (Insert Prompt populating the Gemini
textbox) is validated separately by the headless Playwright check at the
top of this repo. That check is not part of this Node-based suite.

## End-to-end modal tests

The Replace confirmation modal is a fragile piece of UI (CSS vs the
`hidden` attribute is a common source of "modal that won't close" bugs).
It has its own browser-driven test:

```bash
python3 tests/e2e_modal.py
```

Requires `playwright` (Python). Covers 6 scenarios:

1. Empty state — modal invisible; importing does not open it.
2. With a project loaded — clicking Replace opens the modal.
3. Modal open — Cancel closes it and preserves the current project.
4. Modal open — Replace closes it and the file picker, then loads the new
   project on success.
5. Invalid JSON — current project stays intact and modal stays closed.
6. Reopen the popup after a replace — modal starts hidden.

The test inspects `computedStyle.display` rather than just the `hidden`
attribute, so a CSS regression that breaks the attribute's `display: none`
behavior will fail the test (this is exactly the bug that motivated the
test).

Verifying the test catches the original bug:

```bash
cp src/popup/popup.css /tmp/popup.css.fixed
git show v0.2.0:src/popup/popup.css > src/popup/popup.css
python3 tests/e2e_modal.py    # expect 5/6 to fail
cp /tmp/popup.css.fixed src/popup/popup.css
python3 tests/e2e_modal.py    # expect 6/6 to pass
```

## End-to-end Insert Prompt tests

The Insert Prompt flow runs through `popup → chrome.tabs.sendMessage →
content script → DOM adapter`. The popup ↔ content-script contract is
locked by the Insert button + payload test:

```bash
python3 tests/e2e_insert.py
```

The mock wraps `chrome.tabs.sendMessage` to capture the messages the
popup would send and to stub the content script's response. The test
then asserts:

- Click on the Insert button fires `chrome.tabs.sendMessage` exactly once
  with the correct `{ type: "GEMINI_ASSISTANT_INSERT_PROMPT", text }`.
- The payload `text` matches the prompt visible in the textarea at the
  moment of the click — original, locally edited, multiline, or large.
- The popup status reflects success (`Prompt inserted into Gemini …`)
  or failure (`Failed to insert prompt: <reason>`).
- After `Next` / `Previous` / popup reload, the payload tracks the
  current task.

This test catches the v0.2.2 regression where the button's click
listener was missing (reverting the listener makes 8/9 scenarios fail).

## End-to-end References / Assets tests

The popup renders References per task and a collapsible Asset Catalog
when the project declares v2 assets.

```bash
python3 tests/e2e_references.py
```

Scenarios:

- v1 project: no references shown, assets panel hidden
- v2 task with N references: badges + labels + file paths in declared order
- v2 task without references: empty message + count=0
- v2 task with a single reference: only that one is shown
- v2 asset catalog: visible, count matches project assets
- Prev / Next / dropdown selection: references list updates correctly
- Edit prompt + Insert Prompt: payload is prompt only (references are
  not yet sent — that's the next milestone)
- Popup reload: references list restored from `chrome.storage.local`

## End-to-end Insert Replace tests

The Insert Prompt must REPLACE the existing content, never append. This
test runs the same DOM ops the adapter runs (Quill API and execCommand
fallback) against the live `gemini.google.com` editor:

```bash
python3 tests/e2e_replace.py
```

Scenarios:

1. Empty editor accepts the prompt (Quill path).
2. Editor with text: REPLACED, not appended.
3. Three consecutive inserts — only the last remains.
4. Multiline preserved as separate paragraphs.
5. Unicode (Japanese, accented Portuguese) preserved.
6. Large prompt (~5000 chars) handled, then replaced by a small one.
7. **Fallback path comparison** — explicit verification that the bug
   (`range.collapse(false)`) appends and the fix (no collapse) replaces.
8. Empty string insertion clears the editor (adapter allows; popup blocks).
9. Send button remains in DOM and untouched.

Scenario 7 proves the bug exists and the fix works against the real
Gemini editor. The integration popup → adapter is covered by
`tests/e2e_insert.py` (which asserts the payload reaches the content
script contract correctly).

## Manual regression for the Gemini DOM adapter

The PoC's main user-visible behavior (Insert Prompt populating the Gemini
textbox) is validated separately by the headless Playwright check at the
top of this repo. That check is not part of this Node-based suite.
