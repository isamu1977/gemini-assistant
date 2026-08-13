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
