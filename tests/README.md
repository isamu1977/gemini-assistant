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
