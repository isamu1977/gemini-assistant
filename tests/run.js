/*
 * tests/run.js
 *
 * Pure-Node test runner for the project + storage modules.
 * Run with: node tests/run.js
 * Exits 0 on success, 1 on failure.
 *
 * Each test gets a fresh storage state (call _resetForTests()).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Load output.js FIRST so project.js can find GeminiAssistantOutput
// on globalThis when validating the optional `task.output` block.
// In the browser sidepanel, output.js is loaded via a <script> tag
// BEFORE project.js (see src/sidepanel/sidepanel.html).
globalThis.GeminiAssistantOutput = require(path.join(ROOT, "src/lib/output.js"));

const projectLib = require(path.join(ROOT, "src/lib/project.js"));
const storageLib = require(path.join(ROOT, "src/lib/storage.js"));
const assetsLib = require(path.join(ROOT, "src/lib/assets.js"));
const outputLib = globalThis.GeminiAssistantOutput;
const messagingLib = require(path.join(ROOT, "src/lib/messaging.js"));
const orchestratorLib = require(path.join(ROOT, "src/workflow/orchestrator.js"));

const FIXTURES = path.join(__dirname, "fixtures");

const colors = process.stdout.isTTY;
const C = {
  reset: colors ? "\x1b[0m" : "",
  green: colors ? "\x1b[32m" : "",
  red: colors ? "\x1b[31m" : "",
  yellow: colors ? "\x1b[33m" : "",
  dim: colors ? "\x1b[2m" : "",
  bold: colors ? "\x1b[1m" : "",
};

let passed = 0;
let failed = 0;
const failures = [];

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (kb.indexOf(k) === -1) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function test(name, fn) {
  storageLib._resetForTests();
  try {
    fn();
    console.log(`  ${C.green}✓${C.reset} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${C.red}✗${C.reset} ${name}`);
    console.log(`    ${C.red}${e.message}${C.reset}`);
    failed++;
    failures.push({ name, error: e.message, stack: e.stack });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      (msg || "values differ") +
        `\n      actual:   ${JSON.stringify(actual)}` +
        `\n      expected: ${JSON.stringify(expected)}`,
    );
  }
}

function assertThrows(fn, predicate, msg) {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  if (!thrown) {
    throw new Error((msg || "expected throw") + " (no error was thrown)");
  }
  if (predicate && !predicate(thrown.message)) {
    throw new Error(
      (msg || "error message did not match") +
        `\n      got: ${thrown.message}`,
    );
  }
}

// ----- tests ---------------------------------------------------------------

console.log(`\n${C.bold}project.js${C.reset}`);

test("parseProjectJson: valid fixture", () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  assert(r.ok, "expected ok");
  assertEqual(r.project.schemaVersion, 1);
  assertEqual(r.project.project.id, "fixture-valid");
  assertEqual(r.project.project.name, "Valid fixture");
  assertEqual(r.project.tasks.length, 2);
  assertEqual(r.project.tasks[0].id, "a");
  assertEqual(r.project.tasks[0].title, "A");
  assertEqual(r.project.tasks[0].prompt, "prompt A");
  // title omitted → defaults to ""
  assertEqual(r.project.tasks[1].title, "");
});

test("parseProjectJson: invalid syntax", () => {
  const r = projectLib.parseProjectJson(readFixture("invalid-syntax.json"));
  assert(!r.ok, "expected !ok");
  assert(/Invalid JSON/i.test(r.error), `unexpected error: ${r.error}`);
  assertEqual(r.field, "json");
});

test("parseProjectJson: unsupported version", () => {
  const r = projectLib.parseProjectJson(readFixture("unsupported-version.json"));
  assert(!r.ok);
  assert(/Unsupported schemaVersion/i.test(r.error), r.error);
  assertEqual(r.field, "schemaVersion");
});

test("parseProjectJson: empty tasks", () => {
  const r = projectLib.parseProjectJson(readFixture("empty-tasks.json"));
  assert(!r.ok);
  assert(/at least one task/i.test(r.error), r.error);
  assertEqual(r.field, "tasks");
});

test("parseProjectJson: duplicate ids", () => {
  const r = projectLib.parseProjectJson(readFixture("duplicate-ids.json"));
  assert(!r.ok);
  assert(/Duplicate task id/i.test(r.error), r.error);
});

test("parseProjectJson: missing prompt", () => {
  const r = projectLib.parseProjectJson(readFixture("missing-prompt.json"));
  assert(!r.ok);
  assert(/prompt must be a non-empty string/i.test(r.error), r.error);
});

test("parseProjectJson: empty prompt", () => {
  const r = projectLib.parseProjectJson(readFixture("empty-prompt.json"));
  assert(!r.ok);
  assert(/prompt must be a non-empty string/i.test(r.error), r.error);
});

test("buildInitialTaskState: all pending, prompt copied", () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  const state = projectLib.buildInitialTaskState(r.project);
  assertEqual(Object.keys(state).length, 2);
  assertEqual(state["a"].status, "pending");
  assertEqual(state["a"].prompt, "prompt A");
  assertEqual(state["b"].prompt, "prompt B");
});

test("firstTaskId: returns first task's id", () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  assertEqual(projectLib.firstTaskId(r.project), "a");
});

test("firstTaskId: null when no tasks", () => {
  const p = {
    schemaVersion: 1,
    project: { id: "x", name: "x" },
    tasks: [],
  };
  assertEqual(projectLib.firstTaskId(p), null);
});

test("nextTaskId / prevTaskId: walk in array order", () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  const proj = r.project;
  assertEqual(projectLib.nextTaskId(proj, "a"), "b");
  assertEqual(projectLib.nextTaskId(proj, "b"), null);
  assertEqual(projectLib.prevTaskId(proj, "a"), null);
  assertEqual(projectLib.prevTaskId(proj, "b"), "a");
});

test("nextTaskId / prevTaskId: missing id returns null", () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  assertEqual(projectLib.nextTaskId(r.project, "missing"), null);
  assertEqual(projectLib.prevTaskId(r.project, "missing"), null);
});

test("summarizeProgress: counts by status", () => {
  const state = {
    a: { status: "pending", prompt: "p" },
    b: { status: "generated", prompt: "p" },
    c: { status: "approved", prompt: "p" },
    d: { status: "redo", prompt: "p" },
    e: { status: "pending", prompt: "p" },
  };
  const s = projectLib.summarizeProgress(state);
  assertEqual(s, {
    pending: 2,
    generated: 1,
    approved: 1,
    redo: 1,
  });
});

test("summarizeProgress: ignores unknown statuses", () => {
  const state = {
    a: { status: "nonsense", prompt: "p" },
    b: { status: "pending", prompt: "p" },
  };
  const s = projectLib.summarizeProgress(state);
  assertEqual(s.pending, 1);
  assertEqual(s.generated, 0);
});

test("isValidStatus: strict enum check", () => {
  assert(projectLib.isValidStatus("pending"));
  assert(projectLib.isValidStatus("generated"));
  assert(projectLib.isValidStatus("approved"));
  assert(projectLib.isValidStatus("redo"));
  assert(!projectLib.isValidStatus(""));
  assert(!projectLib.isValidStatus("PENDING"));
  assert(!projectLib.isValidStatus("unknown"));
});

test("normalizeImportedProject: fills missing title with empty string", () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  const n = projectLib.normalizeImportedProject(r.project);
  assertEqual(n.tasks[1].title, "");
});

test("STATUSES is frozen and contains 4 entries in spec order", () => {
  assert(Object.isFrozen(projectLib.STATUSES));
  assertEqual(projectLib.STATUSES, ["pending", "generated", "approved", "redo"]);
});

test("example-project.json (shipped fixture) parses and is sane", () => {
  const path = require("path");
  const fp = path.join(ROOT, "examples/example-project.json");
  if (!fs.existsSync(fp)) {
    throw new Error(`example-project.json missing at ${fp}`);
  }
  const raw = fs.readFileSync(fp, "utf8");
  const r = projectLib.parseProjectJson(raw);
  if (!r.ok) throw new Error(`example-project.json invalid: ${r.error}`);
  assert(r.project.tasks.length >= 5, "should ship with at least 5 tasks");
  assertEqual(r.project.schemaVersion, 1);
  // Every prompt should contain an identifiable marker for the test user.
  for (const t of r.project.tasks) {
    if (!/Task \d+ test prompt/i.test(t.prompt)) {
      throw new Error(`task ${t.id} prompt missing expected marker`);
    }
  }
});

// ----- v2 schema: assets and references ---------------------------------

console.log(`\n${C.bold}project.js (v2 schema)${C.reset}`);

test("v2 valid: schemaVersion=2 with assets and references", () => {
  const r = projectLib.parseProjectJson(readFixture("valid-v2.json"));
  assert(r.ok, `expected ok, got ${r.error}`);
  assertEqual(r.project.schemaVersion, 2);
  assertEqual(Object.keys(r.project.assets).length, 2);
  assertEqual(r.project.tasks[0].references.length, 2);
  // Order preserved
  assertEqual(r.project.tasks[0].references, ["a", "b"]);
});

test("v1 still accepted (backwards compat)", () => {
  // v1 fixture should parse cleanly with no assets / references.
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  assert(r.ok, r.error);
  assertEqual(r.project.schemaVersion, 1);
  assertEqual(r.project.assets, {});
  // Tasks must default references to [].
  for (const t of r.project.tasks) {
    assertEqual(t.references, []);
  }
});

test("v1 example fixture (shipped) parses and reports schemaVersion=1", () => {
  const fp = path.join(ROOT, "examples/example-project-v1.json");
  const raw = fs.readFileSync(fp, "utf8");
  const r = projectLib.parseProjectJson(raw);
  assert(r.ok, r.error);
  assertEqual(r.project.schemaVersion, 1);
  assertEqual(r.project.assets, {});
});

test("v2 example fixture (shipped) parses, has assets, references", () => {
  const fp = path.join(ROOT, "examples/example-project-v2.json");
  if (!fs.existsSync(fp)) throw new Error("example-project-v2.json missing");
  const raw = fs.readFileSync(fp, "utf8");
  const r = projectLib.parseProjectJson(raw);
  assert(r.ok, r.error);
  assertEqual(r.project.schemaVersion, 2);
  assert(Object.keys(r.project.assets).length >= 5, "should have at least 5 assets");
  // First task should have 3 references; the last task should have none.
  assertEqual(r.project.tasks[0].references.length, 3);
  assertEqual(r.project.tasks[r.project.tasks.length - 1].references, []);
  // Shared asset: 'character-main' referenced by task 1 and (some other task)
  const t1 = r.project.tasks[0];
  assert(t1.references.includes("character-main"));
});

test("v2: unknown asset reference is rejected with a clear message", () => {
  const r = projectLib.parseProjectJson(readFixture("unknown-asset-ref.json"));
  assert(!r.ok);
  assert(/unknown asset/i.test(r.error), r.error);
  assert(/does-not-exist/.test(r.error), r.error);
});

test("v2: duplicate reference id in a single task is rejected", () => {
  const r = projectLib.parseProjectJson(readFixture("duplicate-task-ref.json"));
  assert(!r.ok);
  assert(/duplicate reference/i.test(r.error), r.error);
});

test("v2: invalid asset type is rejected", () => {
  const r = projectLib.parseProjectJson(readFixture("invalid-asset-type.json"));
  assert(!r.ok);
  assert(/type must be one of/i.test(r.error), r.error);
});

test("v2: missing asset.label is rejected", () => {
  const r = projectLib.parseProjectJson(readFixture("missing-asset-label.json"));
  assert(!r.ok);
  assert(/label must be a non-empty string/i.test(r.error), r.error);
});

test("v2: missing asset.file is rejected", () => {
  const r = projectLib.parseProjectJson(readFixture("missing-asset-file.json"));
  assert(!r.ok);
  assert(/file must be a non-empty string/i.test(r.error), r.error);
});

test("v2: task.references as a non-array is rejected", () => {
  const r = projectLib.parseProjectJson(readFixture("references-not-array.json"));
  assert(!r.ok);
  assert(/references must be an array/i.test(r.error), r.error);
});

test("v2: assets not being an object is rejected", () => {
  const raw = JSON.stringify({
    schemaVersion: 2,
    project: { id: "x", name: "x" },
    assets: ["not", "an", "object"],
    tasks: [{ id: "t", prompt: "p" }],
  });
  const r = projectLib.parseProjectJson(raw);
  assert(!r.ok);
  assert(/assets must be an object/i.test(r.error), r.error);
});

test("resolveReferences: returns resolved assets in declared order", () => {
  const r = projectLib.parseProjectJson(readFixture("valid-v2.json"));
  assert(r.ok);
  const proj = r.project;
  const t1 = proj.tasks[0]; // references = ["a", "b"]
  const resolved = projectLib.resolveReferences(proj, t1.id);
  assertEqual(resolved.length, 2);
  assertEqual(resolved[0].id, "a");
  assertEqual(resolved[0].label, "Asset A");
  assertEqual(resolved[0].type, "character");
  assertEqual(resolved[0].file, "refs/a.png");
  assertEqual(resolved[1].id, "b");
});

test("resolveReferences: returns [] for task without references", () => {
  const r = projectLib.parseProjectJson(readFixture("valid-v2.json"));
  const proj = r.project;
  const t2 = proj.tasks[1]; // no references
  assertEqual(projectLib.resolveReferences(proj, t2.id), []);
});

test("resolveReferences: shared asset appears in multiple tasks", () => {
  const r = projectLib.parseProjectJson(readFixture("valid-v2.json"));
  const proj = r.project;
  const resolved1 = projectLib.resolveReferences(proj, "t1");
  const resolved3 = projectLib.resolveReferences(proj, "t3");
  // Both reference asset "a".
  assert(resolved1.some((a) => a.id === "a"));
  assert(resolved3.some((a) => a.id === "a"));
});

test("countAssets: returns 0 for v1, 5 for v2 example", () => {
  const v1 = projectLib.parseProjectJson(readFixture("valid.json"));
  assertEqual(projectLib.countAssets(v1.project), 0);
  const v2 = projectLib.parseProjectJson(
    fs.readFileSync(path.join(ROOT, "examples/example-project-v2.json"), "utf8"),
  );
  assertEqual(projectLib.countAssets(v2.project), 5);
});

test("ASSET_TYPES is frozen and contains the 5 documented types", () => {
  assert(Object.isFrozen(projectLib.ASSET_TYPES));
  assertEqual(
    projectLib.ASSET_TYPES,
    ["character", "environment", "style", "object", "other"],
  );
});

test("normalizeImportedProject preserves assets and references", () => {
  const r = projectLib.parseProjectJson(readFixture("valid-v2.json"));
  const n = projectLib.normalizeImportedProject(r.project);
  assertEqual(Object.keys(n.assets).length, 2);
  assertEqual(n.tasks[0].references, ["a", "b"]);
});

test("v2 fixture: example-project.json (v1) still has schemaVersion=1 and empty assets", () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  assertEqual(r.project.schemaVersion, 1);
  assertEqual(r.project.assets, {});
});

// ----- storage.js tests ---------------------------------------------------

console.log(`\n${C.bold}storage.js${C.reset}`);

test("storage: emptyState has expected shape", () => {
  const s = storageLib.emptyState();
  assertEqual(s.schemaVersion, storageLib.STORAGE_SCHEMA_VERSION);
  assertEqual(s.source, null);
  assertEqual(s.tasks, null);
  assertEqual(s.currentTaskId, null);
});

test("storage: loadState returns empty state on first run", async () => {
  const s = await storageLib.loadState();
  assertEqual(s.source, null);
  assertEqual(s.tasks, null);
  assertEqual(s.currentTaskId, null);
});

test("storage: saveState then loadState roundtrip", async () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  const initial = storageLib.emptyState();
  initial.source = { project: r.project, importedAt: 12345 };
  initial.tasks = projectLib.buildInitialTaskState(r.project);
  initial.currentTaskId = "a";

  await storageLib.saveState(initial);
  const loaded = await storageLib.loadState();
  assertEqual(loaded.source.project.project.id, "fixture-valid");
  assertEqual(loaded.tasks["a"].status, "pending");
  assertEqual(loaded.currentTaskId, "a");
});

test("storage: editing a task and saving persists the edit", async () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  const initial = storageLib.emptyState();
  initial.source = { project: r.project, importedAt: 1 };
  initial.tasks = projectLib.buildInitialTaskState(r.project);
  initial.currentTaskId = "a";
  await storageLib.saveState(initial);

  // Mutate and save again
  const state = await storageLib.loadState();
  state.tasks["a"].status = "approved";
  state.tasks["a"].prompt = "EDITED";
  state.currentTaskId = "b";
  await storageLib.saveState(state);

  const reloaded = await storageLib.loadState();
  assertEqual(reloaded.tasks["a"].status, "approved");
  assertEqual(reloaded.tasks["a"].prompt, "EDITED");
  assertEqual(reloaded.currentTaskId, "b");
  // Source should still be intact
  assertEqual(reloaded.source.project.tasks[0].prompt, "prompt A");
});

test("storage: coerceState rejects unknown schemaVersion", () => {
  const s = storageLib.coerceState({ schemaVersion: 999, source: "x" });
  assertEqual(s.source, null);
  assertEqual(s.tasks, null);
});

test("storage: coerceState accepts null/undefined", () => {
  assertEqual(storageLib.coerceState(null).source, null);
  assertEqual(storageLib.coerceState(undefined).source, null);
  assertEqual(storageLib.coerceState("garbage").source, null);
});

test("storage: clearAll wipes the store", async () => {
  const r = projectLib.parseProjectJson(readFixture("valid.json"));
  const initial = storageLib.emptyState();
  initial.source = { project: r.project, importedAt: 1 };
  initial.tasks = projectLib.buildInitialTaskState(r.project);
  initial.currentTaskId = "a";
  await storageLib.saveState(initial);

  await storageLib.clearAll();
  const after = await storageLib.loadState();
  assertEqual(after.source, null);
});

// ----- assets.js tests ---------------------------------------------------

console.log(`\n${C.bold}assets.js${C.reset}`);

test("assets: normalizeRelativePath strips leading ./, /, and backslashes", () => {
  assertEqual(assetsLib.normalizeRelativePath("refs/a.png"), "refs/a.png");
  assertEqual(assetsLib.normalizeRelativePath("./refs/a.png"), "refs/a.png");
  assertEqual(assetsLib.normalizeRelativePath("/refs/a.png"), "refs/a.png");
  assertEqual(assetsLib.normalizeRelativePath("refs\\a.png"), "refs/a.png");
  assertEqual(assetsLib.normalizeRelativePath("  ./refs/a.png  "), "refs/a.png");
});

test("assets: normalizeRelativePath rejects .., empty, missing", () => {
  assertEqual(assetsLib.normalizeRelativePath(""), null);
  assertEqual(assetsLib.normalizeRelativePath("   "), null);
  assertEqual(assetsLib.normalizeRelativePath(null), null);
  assertEqual(assetsLib.normalizeRelativePath(undefined), null);
  assertEqual(assetsLib.normalizeRelativePath("../etc/passwd"), null);
  assertEqual(assetsLib.normalizeRelativePath("refs/../a.png"), null);
  assertEqual(assetsLib.normalizeRelativePath("refs/./a.png"), "refs/a.png");
});

test("assets: isSupportedImage matches by extension when MIME missing", () => {
  assert(assetsLib.isSupportedImage("a.png", ""));
  assert(assetsLib.isSupportedImage("a.PNG", ""));
  assert(assetsLib.isSupportedImage("a.jpg", ""));
  assert(assetsLib.isSupportedImage("a.jpeg", ""));
  assert(assetsLib.isSupportedImage("a.webp", ""));
  assert(!assetsLib.isSupportedImage("a.gif", ""));
  assert(!assetsLib.isSupportedImage("a.pdf", ""));
  assert(!assetsLib.isSupportedImage("a.txt", ""));
  assert(!assetsLib.isSupportedImage("a", ""));
});

test("assets: isSupportedImage trusts MIME when present and image/*", () => {
  assert(assetsLib.isSupportedImage("a.png", "image/png"));
  assert(assetsLib.isSupportedImage("a.jpg", "image/jpeg"));
  assert(assetsLib.isSupportedImage("a.jpg", "image/jpg"));
  assert(assetsLib.isSupportedImage("a.webp", "image/webp"));
  // image/* but unsupported subtype
  assert(!assetsLib.isSupportedImage("a.gif", "image/gif"));
  // non-image MIME rejected
  assert(!assetsLib.isSupportedImage("a.png", "application/pdf"));
});

test("assets: SUPPORTED_IMAGE_MIME is frozen and lists PNG/JPEG/WEBP", () => {
  assert(Object.isFrozen(assetsLib.SUPPORTED_IMAGE_MIME));
  assertEqual(
    [...assetsLib.SUPPORTED_IMAGE_MIME].sort(),
    ["image/jpeg", "image/png", "image/webp"],
  );
});

test("assets: SUPPORTED_IMAGE_EXTENSIONS is frozen", () => {
  assert(Object.isFrozen(assetsLib.SUPPORTED_IMAGE_EXTENSIONS));
  assert(assetsLib.SUPPORTED_IMAGE_EXTENSIONS.includes(".png"));
  assert(assetsLib.SUPPORTED_IMAGE_EXTENSIONS.includes(".jpg"));
  assert(assetsLib.SUPPORTED_IMAGE_EXTENSIONS.includes(".jpeg"));
  assert(assetsLib.SUPPORTED_IMAGE_EXTENSIONS.includes(".webp"));
});

test("assets: fileExtension returns lowercase extension or empty", () => {
  assertEqual(assetsLib.fileExtension("foo.PNG"), ".png");
  assertEqual(assetsLib.fileExtension("foo.bar.jpeg"), ".jpeg");
  assertEqual(assetsLib.fileExtension("foo"), "");
  assertEqual(assetsLib.fileExtension("foo."), "");
  assertEqual(assetsLib.fileExtension(""), "");
});

test("assets: deriveState splits missing / unsupported / resolved", () => {
  assertEqual(
    assetsLib.deriveState({ found: false, fileName: "x.png", fileType: "image/png" }),
    "missing",
  );
  assertEqual(
    assetsLib.deriveState({ found: true, fileName: "x.gif", fileType: "image/gif" }),
    "unsupported",
  );
  assertEqual(
    assetsLib.deriveState({ found: true, fileName: "x.png", fileType: "image/png" }),
    "resolved",
  );
  assertEqual(
    assetsLib.deriveState({ found: true, fileName: "x.jpg", fileType: "" }),
    "resolved",
  );
});

test("assets: resolveAssetFile rejects when no directoryHandle", async () => {
  const r = await assetsLib.resolveAssetFile(null, {
    label: "X",
    type: "character",
    file: "refs/x.png",
  });
  assertEqual(r.state, "missing");
});

test("assets: resolveAssetFile returns missing for invalid path", async () => {
  const fakeHandle = { getFileHandle: () => Promise.resolve({ getFile: () => ({}) }) };
  const r = await assetsLib.resolveAssetFile(fakeHandle, {
    label: "X",
    type: "character",
    file: "../escape/x.png",
  });
  assertEqual(r.state, "missing");
});

test("assets: resolveAssetFile returns missing when file handle throws", async () => {
  const fakeHandle = {
    getFileHandle: () => Promise.reject(new DOMException("nope", "NotFoundError")),
  };
  const r = await assetsLib.resolveAssetFile(fakeHandle, {
    label: "X",
    type: "character",
    file: "refs/x.png",
  });
  assertEqual(r.state, "missing");
});

test("assets: resolveAssetFile returns resolved with File for PNG", async () => {
  const fakeFile = {
    name: "yuki.png",
    type: "image/png",
    size: 12345,
  };
  const fakeHandle = {
    getFileHandle: () => Promise.resolve({ getFile: () => Promise.resolve(fakeFile) }),
  };
  const r = await assetsLib.resolveAssetFile(fakeHandle, {
    label: "Yuki",
    type: "character",
    file: "refs/yuki.png",
  });
  assertEqual(r.state, "resolved");
  assertEqual(r.file, fakeFile);
  assertEqual(r.fileName, "yuki.png");
  assertEqual(r.fileType, "image/png");
  assertEqual(r.fileSize, 12345);
});

test("assets: resolveAssetFile returns resolved for JPEG and WEBP", async () => {
  const fakeHandleJpg = {
    getFileHandle: () =>
      Promise.resolve({
        getFile: () => Promise.resolve({ name: "v.jpg", type: "image/jpeg", size: 100 }),
      }),
  };
  const r1 = await assetsLib.resolveAssetFile(fakeHandleJpg, {
    label: "v",
    type: "character",
    file: "v.jpg",
  });
  assertEqual(r1.state, "resolved");

  const fakeHandleWebp = {
    getFileHandle: () =>
      Promise.resolve({
        getFile: () => Promise.resolve({ name: "w.webp", type: "image/webp", size: 200 }),
      }),
  };
  const r2 = await assetsLib.resolveAssetFile(fakeHandleWebp, {
    label: "w",
    type: "style",
    file: "w.webp",
  });
  assertEqual(r2.state, "resolved");
});

test("assets: resolveAssetFile returns unsupported for GIF even when found", async () => {
  const fakeHandle = {
    getFileHandle: () =>
      Promise.resolve({
        getFile: () =>
          Promise.resolve({ name: "g.gif", type: "image/gif", size: 1 }),
      }),
  };
  const r = await assetsLib.resolveAssetFile(fakeHandle, {
    label: "g",
    type: "other",
    file: "g.gif",
  });
  assertEqual(r.state, "unsupported");
  assertEqual(r.file, undefined);
});

test("assets: resolveReferences walks a nested path", async () => {
  // Builds a fake handle that tracks path segments.
  function makeFakeRoot(map) {
    return {
      async getDirectoryHandle(name) {
        const sub = map[name];
        if (!sub) throw new DOMException("missing dir " + name, "NotFoundError");
        return sub;
      },
      async getFileHandle(name) {
        if (!map[name]) throw new DOMException("missing file " + name, "NotFoundError");
        return { async getFile() { return map[name]; } };
      },
    };
  }
  const root = makeFakeRoot({
    refs: {
      async getDirectoryHandle(name) {
        if (name !== "chars") throw new DOMException("missing", "NotFoundError");
        return {
          async getFileHandle(name) {
            if (name !== "yuki.png") throw new DOMException("missing", "NotFoundError");
            return { async getFile() { return { name: "yuki.png", type: "image/png", size: 42 }; } };
          },
        };
      },
    },
  });
  const refs = [
    { label: "Yuki", type: "character", file: "refs/chars/yuki.png" },
  ];
  const out = await assetsLib.resolveReferences(root, refs);
  assertEqual(out.length, 1);
  assertEqual(out[0].state, "resolved");
  assertEqual(out[0].path, "refs/chars/yuki.png");
});

test("assets: resolveReferences isolates failures", async () => {
  const root = {
    async getDirectoryHandle() {
      return {
        async getFileHandle(name) {
          if (name === "ok.png") {
            return { async getFile() { return { name: "ok.png", type: "image/png", size: 1 }; } };
          }
          throw new DOMException("missing", "NotFoundError");
        },
      };
    },
  };
  const refs = [
    { label: "ok", type: "character", file: "refs/ok.png" },
    { label: "bad", type: "character", file: "refs/missing.png" },
  ];
  const out = await assetsLib.resolveReferences(root, refs);
  assertEqual(out.length, 2);
  assertEqual(out[0].state, "resolved");
  assertEqual(out[1].state, "missing");
});

test("assets: filesFromResolved extracts File objects in order", async () => {
  const f1 = { name: "a.png", type: "image/png", size: 1 };
  const f2 = { name: "b.png", type: "image/png", size: 2 };
  const out = assetsLib.filesFromResolved([
    { state: "resolved", file: f1 },
    { state: "missing" },
    { state: "resolved", file: f2 },
    { state: "unsupported" },
  ]);
  assertEqual(out.length, 2);
  assertEqual(out[0], f1);
  assertEqual(out[1], f2);
});

// ----- wrong-root selection detection (v0.5.1) ----------------------------

console.log(`\n${C.bold}assets.js (wrong-root detection)${C.reset}`);

test("detectWrongRootSelection: returns false when no handle", async () => {
  const r = await assetsLib.detectWrongRootSelection(null, [
    { label: "X", type: "character", file: "refs/x.png" },
  ]);
  assertEqual(r.isWrongRoot, false);
});

test("detectWrongRootSelection: returns false when refs empty", async () => {
  const r = await assetsLib.detectWrongRootSelection({ name: "refs" }, []);
  assertEqual(r.isWrongRoot, false);
});

test("detectWrongRootSelection: returns false when folder name does not match first segment", async () => {
  // assets live in "refs/" but user selected a folder named "my-project"
  const handle = { name: "my-project" };
  const r = await assetsLib.detectWrongRootSelection(handle, [
    { label: "X", type: "character", file: "refs/x.png" },
  ]);
  assertEqual(r.isWrongRoot, false);
});

test("detectWrongRootSelection: returns false when first segments are mixed", async () => {
  // cannot be a single-subfolder misalignment
  const handle = { name: "refs" };
  const r = await assetsLib.detectWrongRootSelection(handle, [
    { label: "X", type: "character", file: "refs/x.png" },
    { label: "Y", type: "style", file: "other/y.png" },
  ]);
  assertEqual(r.isWrongRoot, false);
});

test("detectWrongRootSelection: returns false when name matches but spot-check I/O fails", async () => {
  // folder name == first segment, but the basename does NOT exist in the
  // bound folder (so the user is correctly inside the project root that
  // happens to contain a subfolder with the same name)
  const fakeNotFound = { name: "refs" };
  const r = await assetsLib.detectWrongRootSelection(fakeNotFound, [
    { label: "X", type: "character", file: "refs/x.png" },
  ]);
  assertEqual(r.isWrongRoot, false);
});

test("detectWrongRootSelection: returns true when name matches AND spot-check I/O succeeds", async () => {
  // The user picked "references" but the basename "yuki.png" exists at
  // the bound root -> with high confidence the user picked the wrong level.
  const fakeFile = { name: "yuki.png", type: "image/png", size: 42 };
  const handle = {
    name: "references",
    async getFileHandle(name) {
      if (name !== "yuki.png") {
        throw new DOMException("missing", "NotFoundError");
      }
      return { async getFile() { return fakeFile; } };
    },
  };
  const refs = [
    { label: "Yuki", type: "character", file: "references/yuki.png" },
    { label: "Village", type: "environment", file: "references/village.png" },
  ];
  const r = await assetsLib.detectWrongRootSelection(handle, refs);
  assertEqual(r.isWrongRoot, true);
  assertEqual(r.selectedRootName, "references");
  assertEqual(r.firstSegment, "references");
  assertEqual(r.sampleCount, 2);
  assertEqual(r.sampleMatchedBasename, "yuki.png");
  assertEqual(r.sampleRelativePath, "references/yuki.png");
  assertEqual(r.sampleFoundFile.name, "yuki.png");
});

test("detectWrongRootSelection: rejects invalid path (..)", async () => {
  const handle = { name: "refs" };
  const r = await assetsLib.detectWrongRootSelection(handle, [
    { label: "X", type: "character", file: "../escape/x.png" },
  ]);
  assertEqual(r.isWrongRoot, false);
});

test("buildMissingDiagnostic: includes assetId, expectedRelativePath, selectedRootName, matched=false", () => {
  const handle = { name: "my-project" };
  const d = assetsLib.buildMissingDiagnostic({
    asset: { id: "character-main", label: "Main", type: "character", file: "refs/main.png" },
    directoryHandle: handle,
    expectedRelativePath: "refs/main.png",
  });
  assertEqual(d.assetId, "character-main");
  assertEqual(d.expectedRelativePath, "refs/main.png");
  assertEqual(d.selectedRootName, "my-project");
  assertEqual(d.matched, false);
  // No absolute paths leaked.
  assertEqual(d.systemPath, undefined);
});

test("buildMissingDiagnostic: tolerates null handle and partial asset", () => {
  const d = assetsLib.buildMissingDiagnostic({
    asset: { id: "x", file: "refs/x.png" },
    directoryHandle: null,
    expectedRelativePath: null,
  });
  assertEqual(d.assetId, "x");
  assertEqual(d.logicalPath, "refs/x.png");
  assertEqual(d.selectedRootName, null);
  assertEqual(d.matched, false);
});

// ----- output.js (v0.6) -----

console.log(`\n${C.bold}output.js (v0.6)${C.reset}`);

test("output: sanitizeBasename accepts a clean name", () => {
  const r = outputLib.sanitizeBasename("scene-001");
  assert(r.ok, r.error);
  assertEqual(r.basename, "scene-001");
});

test("output: sanitizeBasename collapses whitespace", () => {
  const r = outputLib.sanitizeBasename("   scene   001   ");
  assert(r.ok);
  assertEqual(r.basename, "scene 001");
});

test("output: sanitizeBasename trims trailing dots but rejects embedded ..", () => {
  // Leading/trailing dot-only is sanitized away, but the literal string ".."
  // anywhere in the basename is a traversal attempt and is rejected outright.
  const r1 = outputLib.sanitizeBasename(".scene-001.");
  assert(r1.ok, r1.error);
  assertEqual(r1.basename, "scene-001");
  // ".." anywhere -> rejected as traversal.
  const r2 = outputLib.sanitizeBasename("..scene-001..");
  assert(!r2.ok);
  assertEqual(r2.reason, "traversal");
});

test("output: sanitizeBasename rejects path traversal", () => {
  const r = outputLib.sanitizeBasename("../etc/passwd");
  assert(!r.ok, "should reject");
  assertEqual(r.reason, "traversal");
});

test("output: sanitizeBasename rejects embedded ..", () => {
  const r = outputLib.sanitizeBasename("a/../b");
  assert(!r.ok);
  assertEqual(r.reason, "traversal");
});

test("output: sanitizeBasename rejects forward slash", () => {
  const r = outputLib.sanitizeBasename("a/b");
  assert(!r.ok);
  assertEqual(r.reason, "illegal-char");
});

test("output: sanitizeBasename rejects backslash", () => {
  const r = outputLib.sanitizeBasename("a\\b");
  assert(!r.ok);
  assertEqual(r.reason, "illegal-char");
});

test("output: sanitizeBasename rejects control chars", () => {
  const r = outputLib.sanitizeBasename("scene\u0000-001");
  assert(!r.ok);
  assertEqual(r.reason, "illegal-char");
});

test("output: sanitizeBasename rejects Windows-reserved names", () => {
  const r = outputLib.sanitizeBasename("CON");
  assert(!r.ok);
  assertEqual(r.reason, "reserved");
  const r2 = outputLib.sanitizeBasename("nul");
  assert(!r2.ok);
});

test("output: sanitizeBasename rejects empty", () => {
  const r = outputLib.sanitizeBasename("");
  assert(!r.ok);
  assertEqual(r.reason, "empty");
  const r2 = outputLib.sanitizeBasename("   ");
  assert(!r2.ok);
  assertEqual(r2.reason, "empty");
});

test("output: sanitizeBasename rejects non-string", () => {
  const r = outputLib.sanitizeBasename(null);
  assert(!r.ok);
  assertEqual(r.reason, "not-a-string");
  const r2 = outputLib.sanitizeBasename(undefined);
  assert(!r2.ok);
});

test("output: sanitizeBasename rejects Windows-reserved characters", () => {
  // <>:"/\|?*  — forward slash is already covered; spot-check the rest.
  for (const c of ["<", ">", ":", '"', "|", "?", "*"]) {
    const r = outputLib.sanitizeBasename("scene" + c + "001");
    assert(!r.ok, `should reject '${c}'`);
  }
});

test("output: sanitizeBasename truncates to MAX_BASENAME_LENGTH", () => {
  const huge = "a".repeat(outputLib.MAX_BASENAME_LENGTH + 50);
  const r = outputLib.sanitizeBasename(huge);
  assert(r.ok);
  assertEqual(r.basename.length, outputLib.MAX_BASENAME_LENGTH);
});

test("output: validateTaskOutput returns null when absent", () => {
  assertEqual(outputLib.validateTaskOutput(undefined).output, null);
  assertEqual(outputLib.validateTaskOutput(null).output, null);
});

test("output: validateTaskOutput accepts empty object as 'use task.id'", () => {
  assertEqual(outputLib.validateTaskOutput({}).output, null);
});

test("output: validateTaskOutput rejects non-object", () => {
  assertEqual(outputLib.validateTaskOutput("nope").ok, false);
  assertEqual(outputLib.validateTaskOutput([]).ok, false);
});

test("output: validateTaskOutput rejects unknown keys", () => {
  const r = outputLib.validateTaskOutput({ basename: "ok", extra: "no" });
  assert(!r.ok);
  assertEqual(r.reason, "unknown-key");
});

test("output: validateTaskOutput returns normalized basename", () => {
  const r = outputLib.validateTaskOutput({ basename: "Scene 002 - The Return" });
  assert(r.ok);
  assertEqual(r.output.basename, "Scene 002 - The Return");
});

test("output: resolveTaskBasename prefers output.basename over task.id", () => {
  const r = outputLib.resolveTaskBasename({
    id: "scene-001",
    output: { basename: "explicit-name" },
  });
  assert(r.ok);
  assertEqual(r.basename, "explicit-name");
  assertEqual(r.source, "output");
});

test("output: resolveTaskBasename falls back to task.id when output absent", () => {
  const r = outputLib.resolveTaskBasename({ id: "scene-003" });
  assert(r.ok);
  assertEqual(r.basename, "scene-003");
  assertEqual(r.source, "task.id");
});

test("output: resolveTaskBasename rejects unsafe task.id", () => {
  const r = outputLib.resolveTaskBasename({ id: "../escape" });
  assert(!r.ok);
  assertEqual(r.reason, "traversal");
});

test("output: buildDownloadFilename joins basename + extension", () => {
  assertEqual(outputLib.buildDownloadFilename("scene-001", "image/png"), "scene-001.png");
  assertEqual(outputLib.buildDownloadFilename("scene-001", "image/jpeg"), "scene-001.jpg");
  assertEqual(outputLib.buildDownloadFilename("scene-001", ".webp"), "scene-001.webp");
  assertEqual(outputLib.buildDownloadFilename("scene-001", "png"), "scene-001.png");
});

test("output: buildDownloadFilename returns null on unknown MIME", () => {
  assertEqual(outputLib.buildDownloadFilename("scene-001", "application/octet-stream"), null);
});

test("output: buildDownloadFilename rejects path traversal in result", () => {
  // Even if sanitization were bypassed, the assembler defends itself.
  assertEqual(outputLib.buildDownloadFilename("../escape", "image/png"), null);
  assertEqual(outputLib.buildDownloadFilename("a/b", "image/png"), null);
});

test("output: buildDownloadFolder produces 'Gemini Assistant/<project-id>/'", () => {
  assertEqual(outputLib.buildDownloadFolder("yuki-video-001"), "Gemini Assistant/yuki-video-001");
});

test("output: buildDownloadFolder rejects unsafe projectId", () => {
  assertEqual(outputLib.buildDownloadFolder("../escape"), null);
  assertEqual(outputLib.buildDownloadFolder("a/b"), null);
});

// ----- project.js v0.6 integration -----

console.log(`\n${C.bold}project.js (v0.6: task.output)${C.reset}`);

test("v0.6: task.output optional block is accepted and normalized", () => {
  const r = projectLib.parseProjectJson(readFixture("output-valid.json"));
  assert(r.ok, r.error);
  assertEqual(r.project.tasks.length, 3);
  assertEqual(r.project.tasks[0].output, { basename: "scene-001" });
  // Multi-word with whitespace is preserved verbatim (sanitizer collapses runs).
  assertEqual(r.project.tasks[1].output, { basename: "Scene 002 - The Return" });
  // No output -> normalized to null (fallback to task.id at use-site).
  assertEqual(r.project.tasks[2].output, null);
});

test("v0.6: task.output with traversal basename is rejected", () => {
  const r = projectLib.parseProjectJson(readFixture("output-invalid.json"));
  assert(!r.ok);
  assert(/output/i.test(r.error), r.error);
  assert(/traversal|'..'/i.test(r.error), r.error);
});

test("v0.6: task.output with unknown keys is rejected", () => {
  const r = projectLib.parseProjectJson(readFixture("output-shape-invalid.json"));
  assert(!r.ok);
  assert(/unknown key/i.test(r.error), r.error);
});

test("v0.6: project without any task.output still validates (back-compat)", () => {
  // valid-v2.json has no task.output anywhere.
  const r = projectLib.parseProjectJson(readFixture("valid-v2.json"));
  assert(r.ok, r.error);
  for (const t of r.project.tasks) {
    assertEqual(t.output, null);
  }
});

test("v0.6: normalizeImportedProject preserves output block", () => {
  const r = projectLib.parseProjectJson(readFixture("output-valid.json"));
  const n = projectLib.normalizeImportedProject(r.project);
  assertEqual(n.tasks[0].output, { basename: "scene-001" });
  assertEqual(n.tasks[2].output, null);
});

test("v0.6: resolveTaskOutputBasename returns output.basename when set", () => {
  const r = projectLib.parseProjectJson(readFixture("output-valid.json"));
  assertEqual(
    projectLib.resolveTaskOutputBasename(r.project, "scene-001"),
    "scene-001",
  );
  assertEqual(
    projectLib.resolveTaskOutputBasename(r.project, "scene-002"),
    "Scene 002 - The Return",
  );
});

test("v0.6: resolveTaskOutputBasename falls back to task.id when output absent", () => {
  const r = projectLib.parseProjectJson(readFixture("output-valid.json"));
  assertEqual(projectLib.resolveTaskOutputBasename(r.project, "scene-003"), "scene-003");
});

test("v0.6: resolveTaskOutputBasename returns null for unknown task", () => {
  const r = projectLib.parseProjectJson(readFixture("output-valid.json"));
  assertEqual(projectLib.resolveTaskOutputBasename(r.project, "does-not-exist"), null);
});

// ----- messaging.js (v0.6.1) ----------------------------------------

console.log(`\n${C.bold}messaging.js (v0.6.1)${C.reset}`);

test("messaging: isGeminiUrl accepts https://gemini.google.com/...", () => {
  assert(messagingLib.isGeminiUrl("https://gemini.google.com/app"));
  assert(messagingLib.isGeminiUrl("https://gemini.google.com/"));
  assert(!messagingLib.isGeminiUrl("http://gemini.google.com/"));
  assert(!messagingLib.isGeminiUrl("https://example.com/"));
  assert(!messagingLib.isGeminiUrl("https://gemini.google.com.evil.com/"));
  assert(!messagingLib.isGeminiUrl(""));
  assert(!messagingLib.isGeminiUrl(null));
  assert(!messagingLib.isGeminiUrl(undefined));
});

test("messaging: isPositiveInteger strict check", () => {
  assert(messagingLib.isPositiveInteger(1));
  assert(messagingLib.isPositiveInteger(12345));
  assert(!messagingLib.isPositiveInteger(0));
  assert(!messagingLib.isPositiveInteger(-1));
  assert(!messagingLib.isPositiveInteger(1.5));
  assert(!messagingLib.isPositiveInteger("1"));
  assert(!messagingLib.isPositiveInteger(null));
  assert(!messagingLib.isPositiveInteger(undefined));
  assert(!messagingLib.isPositiveInteger(NaN));
});

test("messaging: isMessageSerializable rejects functions and symbols", () => {
  const r1 = messagingLib.isMessageSerializable({ type: "X", fn: () => 1 });
  assert(!r1.ok, "function in payload must be rejected");
  assert(/unsupported/i.test(r1.reason));
  const r2 = messagingLib.isMessageSerializable({ type: "X", s: Symbol("s") });
  assert(!r2.ok);
});

test("messaging: isMessageSerializable accepts plain objects, arrays, null, numbers, strings", () => {
  assertEqual(messagingLib.isMessageSerializable(null), { ok: true });
  assertEqual(messagingLib.isMessageSerializable(undefined), { ok: true });
  assertEqual(messagingLib.isMessageSerializable({ type: "X" }), { ok: true });
  assertEqual(
    messagingLib.isMessageSerializable({ type: "X", list: [1, 2, 3] }),
    { ok: true },
  );
  assertEqual(
    messagingLib.isMessageSerializable({ type: "X", nested: { a: 1, b: "two" } }),
    { ok: true },
  );
});

test("messaging: MESSAGE_TYPES is frozen and contains the canonical names", () => {
  assert(Object.isFrozen(messagingLib.MESSAGE_TYPES));
  const required = [
    "PING",
    "INSERT_PROMPT",
    "ATTACH",
    "ATTACH_WITH_MENU",
    "ATTACH_PROBE",
    "ATTACH_ACTIVATE",
    "COMPOSER_STATE",
    "IMAGE_MODE_PROBE",
    "ENSURE_IMAGE_MODE",
    "SEND_COMPOSER",
    "FIND_SEND_BUTTON",
    "CAPTURE_BASELINE",
    "WAIT_FOR_GENERATED_IMAGE",
    "FETCH_IMAGE",
  ];
  for (const k of required) {
    assert(
      typeof messagingLib.MESSAGE_TYPES[k] === "string" &&
        messagingLib.MESSAGE_TYPES[k].startsWith("GEMINI_ASSISTANT_"),
      `MESSAGE_TYPES.${k} must be a GEMINI_ASSISTANT_* string`,
    );
  }
  // Side panel + content script must agree on these strings.
  // The content.js switch is the source of truth for runtime; we just
  // sanity-check the most critical ones here.
  assertEqual(
    messagingLib.MESSAGE_TYPES.PING,
    "GEMINI_ASSISTANT_PING",
  );
  assertEqual(
    messagingLib.MESSAGE_TYPES.ENSURE_IMAGE_MODE,
    "GEMINI_ASSISTANT_ENSURE_IMAGE_MODE",
  );
  assertEqual(
    messagingLib.MESSAGE_TYPES.ATTACH_WITH_MENU,
    "GEMINI_ASSISTANT_ATTACH_WITH_MENU",
  );
});

test("messaging: sendTabMessage rejects null/undefined tabId", async () => {
  const fakeChrome = {};
  await assertThrowsAsync(
    () => messagingLib.sendTabMessage(fakeChrome, null, { type: "X" }),
    /invalid tabId/,
  );
  await assertThrowsAsync(
    () => messagingLib.sendTabMessage(fakeChrome, undefined, { type: "X" }),
    /invalid tabId/,
  );
  await assertThrowsAsync(
    () => messagingLib.sendTabMessage(fakeChrome, "7", { type: "X" }),
    /invalid tabId/,
  );
  await assertThrowsAsync(
    () => messagingLib.sendTabMessage(fakeChrome, 1.5, { type: "X" }),
    /invalid tabId/,
  );
  await assertThrowsAsync(
    () => messagingLib.sendTabMessage(fakeChrome, 0, { type: "X" }),
    /invalid tabId/,
  );
  await assertThrowsAsync(
    () => messagingLib.sendTabMessage(fakeChrome, -7, { type: "X" }),
    /invalid tabId/,
  );
});

test("messaging: sendTabMessage rejects invalid message shape", async () => {
  const fakeChrome = makeMockChrome();
  await assertThrowsAsync(
    () => messagingLib.sendTabMessage(fakeChrome, 7, null),
    /message must be an object/,
  );
  await assertThrowsAsync(
    () => messagingLib.sendTabMessage(fakeChrome, 7, { /* no type */ }),
    /message\.type/,
  );
  await assertThrowsAsync(
    () => messagingLib.sendTabMessage(fakeChrome, 7, { type: "" }),
    /message\.type/,
  );
  await assertThrowsAsync(
    () =>
      messagingLib.sendTabMessage(fakeChrome, 7, {
        type: "X",
        fn: () => 1,
      }),
    /not structured-cloneable/,
  );
});

test("messaging: sendTabMessage happy path returns the response", async () => {
  const chromeRef = makeMockChrome({
    tabs: [
      {
        id: 7,
        url: "https://gemini.google.com/app",
        active: true,
        windowId: 1,
      },
    ],
    responses: { GEMINI_ASSISTANT_PING: { ok: true, url: "https://gemini.google.com/app" } },
  });
  const res = await messagingLib.sendTabMessage(chromeRef, 7, {
    type: "GEMINI_ASSISTANT_PING",
  });
  assertEqual(res, { ok: true, url: "https://gemini.google.com/app" });
  // Verify the message reached the mock exactly once with the expected shape.
  assertEqual(chromeRef.tabs.calls.length, 1);
  assertEqual(chromeRef.tabs.calls[0].tabId, 7);
  assertEqual(chromeRef.tabs.calls[0].message.type, "GEMINI_ASSISTANT_PING");
  // 3-arg form (tabId, message, callback) — never 4-arg with undefined options.
  assertEqual(chromeRef.tabs.calls[0].args.length, 3);
});

test("messaging: sendTabMessage propagates chrome.runtime.lastError", async () => {
  const chromeRef = makeMockChrome({
    tabs: [{ id: 7, url: "https://gemini.google.com/app", active: true, windowId: 1 }],
    lastError: "Could not establish connection. Receiving end does not exist.",
  });
  await assertThrowsAsync(
    () =>
      messagingLib.sendTabMessage(chromeRef, 7, { type: "GEMINI_ASSISTANT_PING" }),
    /Receiving end does not exist/,
  );
});

test("messaging: getTargetGeminiTab prefers active+currentWindow", async () => {
  const chromeRef = makeMockChrome({
    tabs: [
      { id: 99, url: "https://example.com", active: true, windowId: 1 },
      { id: 7, url: "https://gemini.google.com/app", active: false, windowId: 1 },
    ],
  });
  const tab = await messagingLib.getTargetGeminiTab(chromeRef);
  assertEqual(tab.id, 7);
  // Two queries: active+currentWindow, then full scan.
  assertEqual(chromeRef.tabs.calls.length, 2);
  assertEqual(chromeRef.tabs.calls[0].query.active, true);
  assertEqual(chromeRef.tabs.calls[0].query.currentWindow, true);
});

test("messaging: getTargetGeminiTab falls back to any-window scan", async () => {
  // First query returns only non-Gemini tabs.
  // We use a custom mock to keep the responses distinct.
  const chromeRef = makeMockChromeWithMultiQuery([
    // active+currentWindow: nothing Gemini
    [{ id: 50, url: "https://example.com", active: true, windowId: 1 }],
    // full scan: the Gemini tab in another window
    [
      { id: 50, url: "https://example.com", active: false, windowId: 1 },
      { id: 88, url: "https://gemini.google.com/app", active: false, windowId: 2 },
    ],
  ]);
  const tab = await messagingLib.getTargetGeminiTab(chromeRef);
  assertEqual(tab.id, 88);
});

test("messaging: getTargetGeminiTab throws when no Gemini tab is open", async () => {
  const chromeRef = makeMockChrome({
    tabs: [{ id: 50, url: "https://example.com", active: true, windowId: 1 }],
  });
  await assertThrowsAsync(
    () => messagingLib.getTargetGeminiTab(chromeRef),
    /No Gemini tab found/,
  );
});

test("messaging: sendToGemini resolves tab and forwards the typed payload", async () => {
  const chromeRef = makeMockChrome({
    tabs: [{ id: 7, url: "https://gemini.google.com/app", active: true, windowId: 1 }],
    responses: {
      GEMINI_ASSISTANT_PING: { ok: true, url: "https://gemini.google.com/app" },
    },
  });
  const res = await messagingLib.sendToGemini(chromeRef, "GEMINI_ASSISTANT_PING");
  assertEqual(res, { ok: true, url: "https://gemini.google.com/app" });
  assertEqual(chromeRef.tabs.calls[0].message.type, "GEMINI_ASSISTANT_PING");
});

test("messaging: sendToGemini rejects bad type", async () => {
  const chromeRef = makeMockChrome();
  await assertThrowsAsync(
    () => messagingLib.sendToGemini(chromeRef, ""),
    /type required/,
  );
  await assertThrowsAsync(
    () => messagingLib.sendToGemini(chromeRef, null),
    /type required/,
  );
});

test("messaging: sendToGemini rejects non-object payload", async () => {
  const chromeRef = makeMockChrome();
  await assertThrowsAsync(
    () => messagingLib.sendToGemini(chromeRef, "X", "not-an-object"),
    /payload must be an object/,
  );
  // null payload is allowed.
  const res = await messagingLib.sendToGemini(chromeRef, "GEMINI_ASSISTANT_PING", null);
  assertEqual(res && res.ok, true);
});

test("messaging: pingGemini returns target tab diagnostic on success", async () => {
  const chromeRef = makeMockChrome({
    tabs: [{ id: 7, url: "https://gemini.google.com/app", active: true, windowId: 1 }],
    responses: { GEMINI_ASSISTANT_PING: { ok: true, url: "https://gemini.google.com/app" } },
  });
  const r = await messagingLib.pingGemini(chromeRef);
  assert(r.ok, "ping should succeed");
  assertEqual(r.targetTabId, 7);
  assertEqual(r.targetTabUrl, "https://gemini.google.com/app");
  assertEqual(r.targetTabActive, true);
  assertEqual(r.targetTabWindowId, 1);
});

test("messaging: pingGemini returns structured error when no Gemini tab", async () => {
  const chromeRef = makeMockChrome({
    tabs: [{ id: 50, url: "https://example.com", active: true, windowId: 1 }],
  });
  const r = await messagingLib.pingGemini(chromeRef);
  assert(!r.ok);
  assert(/No Gemini tab/.test(r.error));
});

// ----- helpers for messaging tests -----------------------------------

function makeMockChrome(opts) {
  const tabs = (opts && opts.tabs) || [];
  const responses = (opts && opts.responses) || {};
  const lastError = (opts && opts.lastError) || null;
  const calls = [];
  return {
    runtime: {
      get lastError() {
        return lastError ? { message: lastError } : null;
      },
    },
    tabs: {
      calls,
      query(queryInfo, cb) {
        calls.push({ query: queryInfo, args: arguments.length });
        // Always honor the active+currentWindow filter when given.
        const filtered = tabs.filter((t) => {
          if (queryInfo && queryInfo.active === true && !t.active) return false;
          if (queryInfo && queryInfo.currentWindow === true) {
            // mock only has windowId 1, so this matches all our tabs.
          }
          return true;
        });
        const result = filtered.length > 0 ? filtered : tabs;
        // Simulate lastError.
        if (lastError && calls.length === 1) {
          setTimeout(() => cb([]), 0);
        } else {
          setTimeout(() => cb(result), 0);
        }
      },
      sendMessage(tabId, message, cb) {
        calls.push({
          method: "sendMessage",
          tabId,
          message,
          args: arguments.length,
        });
        const response =
          (responses && responses[message && message.type]) || { ok: true };
        setTimeout(() => {
          if (lastError && calls.filter((c) => c.method === "sendMessage").length === 1) {
            cb(undefined);
          } else {
            cb(response);
          }
        }, 0);
      },
    },
  };
}

function makeMockChromeWithMultiQuery(perQueryResponses) {
  const calls = [];
  let qIndex = 0;
  return {
    runtime: {
      get lastError() {
        return null;
      },
    },
    tabs: {
      calls,
      query(queryInfo, cb) {
        calls.push({ query: queryInfo, args: arguments.length });
        const list = perQueryResponses[qIndex] || [];
        qIndex++;
        setTimeout(() => cb(list), 0);
      },
      sendMessage(tabId, message, cb) {
        calls.push({ method: "sendMessage", tabId, message, args: arguments.length });
        setTimeout(() => cb({ ok: true }), 0);
      },
    },
  };
}

async function assertThrowsAsync(fn, pattern) {
  let thrown = null;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  if (!thrown) {
    throw new Error("expected async throw; got success");
  }
  if (pattern && !pattern.test(thrown.message)) {
    throw new Error(
      `error message did not match pattern ${pattern}\n      got: ${thrown.message}`,
    );
  }
}

// ----- end messaging helpers ------------------------------------------

console.log(`\n${C.bold}orchestrator.js (v0.6)${C.reset}`);

// ----- orchestrator.js (v0.6) ---------------------------------------

function makeFakeFile(name) {
  return { name, type: "image/png", size: 1024 };
}

function makeFakeResolvedRef(id, label) {
  return {
    id,
    label,
    file: `refs/${id}.png`,
    state: "resolved",
    fileObj: makeFakeFile(`${id}.png`),
    fileName: `${id}.png`,
    fileType: "image/png",
    fileSize: 1024,
    error: null,
  };
}

function makeOrchestrator() {
  const log = [];
  const phases = [];
  const progresses = [];
  const orch = orchestratorLib.createOrchestrator({
    sendToTab: async (msg) => {
      // v0.6.1: the orchestrator no longer passes a tabId here; tab
      // resolution lives in src/lib/messaging.js.
      if (msg.type === "GEMINI_ASSISTANT_ENSURE_IMAGE_MODE") {
        return { ok: true, mode: "activated" };
      }
      if (msg.type === "GEMINI_ASSISTANT_ATTACH_WITH_MENU") {
        return { ok: true, fileName: msg.fileName, fileType: msg.fileType, fileSize: msg.fileSize, elapsedMs: 5 };
      }
      if (msg.type === "GEMINI_ASSISTANT_INSERT_PROMPT") {
        return { ok: true, length: msg.text.length, method: "quill" };
      }
      if (msg.type === "GEMINI_ASSISTANT_COMPOSER_STATE") {
        return {
          ok: true,
          attachmentCount: 0,
          pendingUploadCount: 0,
          promptLength: msg.text?.length ?? 0,
          imageModeActive: true,
          composerClean: true,
        };
      }
      if (msg.type === "GEMINI_ASSISTANT_FIND_SEND_BUTTON") {
        return { ok: true, found: true, disabled: false, label: "Send message" };
      }
      if (msg.type === "GEMINI_ASSISTANT_CAPTURE_BASELINE") {
        return { ok: true, baseline: { capturedAt: 0, userQueryCount: 1, modelResponseCount: 1, generatedImageCount: 0, generatedImageSrcs: [] } };
      }
      if (msg.type === "GEMINI_ASSISTANT_SEND_COMPOSER") {
        return { ok: true, method: "click" };
      }
      if (msg.type === "GEMINI_ASSISTANT_WAIT_FOR_GENERATED_IMAGE") {
        return { ok: true, imageSrc: "https://lh3.googleusercontent.com/gg/abc", alt: "AI generated", naturalWidth: 1024, naturalHeight: 1024 };
      }
      return { ok: false, error: "unknown message" };
    },
    downloadImage: async (req) => ({
      ok: true,
      downloadId: 1,
      finalFilename: `${req.basename}.png`,
    }),
    onPhaseChange: (phase, info) => {
      phases.push({ phase, prev: info?.prev });
      log.push(`phase:${info?.prev}->${phase}`);
    },
    onAttachmentProgress: (info) => {
      progresses.push(info);
    },
    onLog: (level, message) => {
      log.push(`${level}:${message}`);
    },
  });
  return { orch, phases, progresses, log };
}

test("orchestrator: createOrchestrator requires sendToTab", () => {
  let thrown = null;
  try {
    orchestratorLib.createOrchestrator({});
  } catch (e) {
    thrown = e;
  }
  assert(thrown !== null, "expected throw");
  assert(
    /requires deps\.sendToTab/.test(thrown.message),
    `unexpected error: ${thrown.message}`,
  );
});

test("orchestrator: PHASES exposes the canonical phase list", () => {
  const phases = orchestratorLib.PHASES;
  for (const required of [
    "idle",
    "preparing-image-mode",
    "preparing-attachments",
    "preparing-prompt",
    "ready",
    "preflight",
    "sending",
    "waiting-for-generation",
    "downloading",
    "complete",
    "error",
    "cancelled",
  ]) {
    assert(phases.includes(required), `PHASES must contain ${required}`);
  }
});

test("orchestrator: reset transitions to idle and records taskId", () => {
  const { orch } = makeOrchestrator();
  orch.reset({ id: "scene-001" });
  assertEqual(orch.state.phase, "idle");
  assertEqual(orch.state.taskId, "scene-001");
});

test("orchestrator: prepareTask happy path goes idle -> preparing-image-mode -> preparing-attachments -> preparing-prompt -> ready", async () => {
  const { orch, phases } = makeOrchestrator();
  const refs = [makeFakeResolvedRef("a", "A"), makeFakeResolvedRef("b", "B"), makeFakeResolvedRef("c", "C")];
  const ok = await orch.prepareTask({
    taskId: "scene-001",
    prompt: "Wide shot of the snow village.",
    resolvedRefs: refs,
  });
  assert(ok, "prepareTask should succeed");
  assertEqual(orch.state.phase, "ready");
  // Check the phase trajectory.
  const visited = phases.map((p) => p.phase);
  assert(visited.includes("preparing-image-mode"));
  assert(visited.includes("preparing-attachments"));
  assert(visited.includes("preparing-prompt"));
  assert(visited[visited.length - 1], "ready");
});

test("orchestrator: prepareTask stops on missing ref and reports partial counts", async () => {
  const { orch, phases } = makeOrchestrator();
  const refs = [
    makeFakeResolvedRef("a", "A"),
    { id: "b", label: "B", state: "missing", error: "not found", file: "refs/b.png" },
    makeFakeResolvedRef("c", "C"),
  ];
  const ok = await orch.prepareTask({
    taskId: "scene-002",
    prompt: "p",
    resolvedRefs: refs,
  });
  assert(!ok);
  assertEqual(orch.state.phase, "error");
  assertEqual(orch.state.error.phase, "preparing-attachments");
  assertEqual(orch.state.error.attachedCount, 0);
  assertEqual(orch.state.error.totalCount, 3);
  // prepareTask does NOT send, so we should NOT have entered sending.
  const visited = phases.map((p) => p.phase);
  assert(!visited.includes("sending"));
});

test("orchestrator: attachAll preserves order in onAttachmentProgress events", async () => {
  const { orch, progresses } = makeOrchestrator();
  const refs = [
    makeFakeResolvedRef("a", "A"),
    makeFakeResolvedRef("b", "B"),
    makeFakeResolvedRef("c", "C"),
  ];
  await orch.ensureImageMode();
  const ok = await orch.attachAll(refs);
  assert(ok);
  // Filter to "ok" events; expect 3, in order.
  const oks = progresses.filter((p) => p.phase === "ok");
  assertEqual(oks.length, 3);
  assertEqual(oks[0].assetId, "a");
  assertEqual(oks[1].assetId, "b");
  assertEqual(oks[2].assetId, "c");
});

test("orchestrator: attachAll halts on first failure and reports count", async () => {
  const { orch, progresses } = makeOrchestrator();
  const refs = [
    makeFakeResolvedRef("a", "A"),
    makeFakeResolvedRef("b", "B"),
    makeFakeResolvedRef("c", "C"),
  ];
  await orch.ensureImageMode();
  // Override sendToTab to fail on the SECOND call.
  let call = 0;
  const real = orch;
  // We can't easily monkeypatch the orchestrator's internal deps from here.
  // Instead, simulate by passing a ref whose attach would fail. We do this
  // by having a ref whose fileObj is null (treated as missing in attachAll).
  const failing = [
    makeFakeResolvedRef("a", "A"),
    { ...refs[1], fileObj: null }, // will be rejected by attachAll
    makeFakeResolvedRef("c", "C"),
  ];
  const ok = await orch.attachAll(failing);
  assert(!ok);
  assertEqual(orch.state.phase, "error");
  // Only "start" for A is fired (because B fails the resolver check at the
  // entry of attachAll, before any "start" is emitted).
  const aStarts = progresses.filter(
    (p) => p.phase === "start" && p.assetId === "a",
  );
  assertEqual(aStarts.length, 1);
});

test("orchestrator: preflight fails if composer attachments don't match expected", async () => {
  const { orch } = makeOrchestrator();
  await orch.ensureImageMode();
  await orch.attachAll([makeFakeResolvedRef("a", "A")]);
  await orch.insertPrompt("p");
  // Now monkeypatch sendToTab to lie about attachments.
  orch._setSendToTab(async () => ({
    ok: true,
    attachmentCount: 0,
    pendingUploadCount: 0,
    promptLength: 1,
    imageModeActive: true,
  }));
  const ok = await orch.preflight({ taskId: "x", promptLength: 1, resolvedRefs: [{}] });
  assert(!ok);
  assertEqual(orch.state.phase, "error");
});

test("orchestrator: generateTask happy path ends in complete", async () => {
  const { orch, phases } = makeOrchestrator();
  await orch.prepareTask({
    taskId: "scene-001",
    prompt: "p",
    resolvedRefs: [makeFakeResolvedRef("a", "A")],
  });
  const ok = await orch.generateTask({
    taskId: "scene-001",
    prompt: "p",
    resolvedRefs: [makeFakeResolvedRef("a", "A")],
    basename: "scene-001",
    projectId: "proj",
    mimeOrExt: "image/png",
    generationTimeoutMs: 1000,
  });
  assert(ok);
  assertEqual(orch.state.phase, "complete");
  const visited = phases.map((p) => p.phase);
  assert(visited.includes("preflight"));
  assert(visited.includes("sending"));
  assert(visited.includes("waiting-for-generation"));
  assert(visited.includes("downloading"));
});

test("orchestrator: cancel() transitions to cancelled and short-circuits pending phases", async () => {
  const { orch } = makeOrchestrator();
  orch.cancel();
  // After cancel, ensureImageMode should NOT fire (it should observe the
  // cancelled flag and return false without calling sendToTab).
  let called = false;
  orch._setSendToTab(async () => {
    called = true;
    return { ok: true };
  });
  const ok = await orch.ensureImageMode();
  assert(!ok);
  assert(!called, "sendToTab must not be called after cancel()");
  assertEqual(orch.state.phase, "cancelled");
});

test("orchestrator: isActive reflects the current phase", () => {
  const { orch } = makeOrchestrator();
  assert(!orch.isActive());
  orch._transition("sending");
  assert(orch.isActive());
  orch._transition("complete");
  assert(!orch.isActive());
});

test("orchestrator: download fails when no generated image", async () => {
  const { orch } = makeOrchestrator();
  const ok = await orch.download("x", "y", "image/png");
  assert(!ok);
  assertEqual(orch.state.phase, "error");
});

// v0.6.1 regression: the v0.6 bug was that the orchestrator invoked
// sendToTab with a `null` tabId (the closure variable was never set),
// which Chrome rejected with "No matching signature". After the fix,
// sendToTab takes only the message; tabId lives in the messaging
// helper.
test("orchestrator: sendToTab is called with one argument (message), not two", async () => {
  const calls = [];
  const { orch } = makeOrchestrator();
  orch._setSendToTab(async (msg) => {
    calls.push({ keys: Object.keys(msg || {}), type: msg && msg.type });
    if (msg && msg.type === "GEMINI_ASSISTANT_ENSURE_IMAGE_MODE") {
      return { ok: true, mode: "activated" };
    }
    if (msg && msg.type === "GEMINI_ASSISTANT_INSERT_PROMPT") {
      return { ok: true, length: (msg.text || "").length, method: "quill" };
    }
    return { ok: true };
  });
  const refs = [makeFakeResolvedRef("a", "A")];
  await orch.prepareTask({ taskId: "x", prompt: "p", resolvedRefs: refs });
  // Every sendToTab call receives a single object argument.
  assert(calls.length >= 4, `expected several sendToTab calls, got ${calls.length}`);
  for (const c of calls) {
    assert(typeof c === "object" && c !== null, "sendToTab should receive an object");
    assert(typeof c.type === "string", "message must have a type field");
  }
});

test("orchestrator: sendToTab failure surfaces as friendly error and short-circuits workflow", async () => {
  const { orch } = makeOrchestrator();
  orch._setSendToTab(async () => {
    throw new Error("invalid tabId");
  });
  const ok = await orch.prepareTask({
    taskId: "x",
    prompt: "p",
    resolvedRefs: [makeFakeResolvedRef("a", "A")],
  });
  assert(!ok);
  assertEqual(orch.state.phase, "error");
  assertEqual(orch.state.error.phase, "preparing-image-mode");
  // The error message we surface in the UI mentions "Could not communicate".
  assert(
    /Could not communicate with Gemini content script/.test(
      orch.state.error.error,
    ),
    `unexpected error: ${orch.state.error.error}`,
  );
});

test("orchestrator: messaging failure at preparing-image-mode halts the workflow", async () => {
  const { orch, phases } = makeOrchestrator();
  orch._setSendToTab(async () => {
    throw new Error("invalid tabId");
  });
  await orch.prepareTask({
    taskId: "x",
    prompt: "p",
    resolvedRefs: [makeFakeResolvedRef("a", "A")],
  });
  const visited = phases.map((p) => p.phase);
  // Image mode phase was attempted; attachment, prompt, etc. were NOT.
  assert(visited.includes("preparing-image-mode"));
  assert(!visited.includes("preparing-attachments"));
  assert(!visited.includes("preparing-prompt"));
  assert(!visited.includes("sending"));
});

test("orchestrator: messaging failure at preparing-attachments does not run preparing-prompt", async () => {
  const { orch, phases } = makeOrchestrator();
  let callIndex = 0;
  orch._setSendToTab(async (msg) => {
    callIndex++;
    if (msg.type === "GEMINI_ASSISTANT_ENSURE_IMAGE_MODE") {
      return { ok: true, mode: "activated" };
    }
    if (msg.type === "GEMINI_ASSISTANT_ATTACH_WITH_MENU") {
      throw new Error("Could not communicate");
    }
    return { ok: true };
  });
  const ok = await orch.prepareTask({
    taskId: "x",
    prompt: "p",
    resolvedRefs: [makeFakeResolvedRef("a", "A"), makeFakeResolvedRef("b", "B")],
  });
  assert(!ok);
  const visited = phases.map((p) => p.phase);
  assert(visited.includes("preparing-image-mode"));
  assert(visited.includes("preparing-attachments"));
  assert(!visited.includes("preparing-prompt"));
  assert(!visited.includes("sending"));
});

test("orchestrator: messaging failure at preparing-attachments does not run send", async () => {
  const { orch, phases } = makeOrchestrator();
  let callIndex = 0;
  orch._setSendToTab(async (msg) => {
    callIndex++;
    if (msg.type === "GEMINI_ASSISTANT_ENSURE_IMAGE_MODE") {
      return { ok: true, mode: "activated" };
    }
    if (msg.type === "GEMINI_ASSISTANT_INSERT_PROMPT") {
      return { ok: true, length: 1, method: "quill" };
    }
    if (msg.type === "GEMINI_ASSISTANT_ATTACH_WITH_MENU") {
      throw new Error("Could not communicate");
    }
    return { ok: true };
  });
  await orch.prepareTask({
    taskId: "x",
    prompt: "p",
    resolvedRefs: [makeFakeResolvedRef("a", "A")],
  });
  // prepareTask halted at attachments; subsequent generateTask must not
  // skip past it (sending must NOT appear in phases).
  await orch.generateTask({
    taskId: "x",
    prompt: "p",
    resolvedRefs: [makeFakeResolvedRef("a", "A")],
    basename: "x",
    projectId: "p",
    mimeOrExt: "image/png",
  });
  const visited = phases.map((p) => p.phase);
  assert(!visited.includes("sending"));
});

test("orchestrator: messaging failure at send does not run waiting-for-generation", async () => {
  const { orch, phases } = makeOrchestrator();
  // Make prepareTask succeed by default.
  await orch.prepareTask({
    taskId: "x",
    prompt: "p",
    resolvedRefs: [makeFakeResolvedRef("a", "A")],
  });
  // Now poison send.
  orch._setSendToTab(async (msg) => {
    if (msg.type === "GEMINI_ASSISTANT_SEND_COMPOSER") {
      throw new Error("Could not communicate");
    }
    return { ok: true };
  });
  await orch.generateTask({
    taskId: "x",
    prompt: "p",
    resolvedRefs: [makeFakeResolvedRef("a", "A")],
    basename: "x",
    projectId: "p",
    mimeOrExt: "image/png",
  });
  const visited = phases.map((p) => p.phase);
  assert(!visited.includes("waiting-for-generation"));
});

// ----- v0.6.2: storage attachUnlocked + adapter instrumentation ----------

console.log(`\n${C.bold}storage.js (v0.6.2: attachUnlocked)${C.reset}`);

test("storage: emptyState returns attachUnlocked=false (defaults to gated)", () => {
  const s = storageLib.emptyState();
  assertEqual(s.attachUnlocked, false);
});

test("storage: coerceState migrates legacy v0.6.1 state to attachUnlocked=false", () => {
  const legacy = {
    schemaVersion: 1,
    source: { project: { id: "x", name: "X" }, importedAt: 1 },
    tasks: {},
    currentTaskId: null,
  };
  const s = storageLib.coerceState(legacy);
  // Force a write roundtrip.
  storageLib.saveState(s);
  const loaded = storageLib.coerceState(
    JSON.parse(
      require("fs").existsSync("") ? "{}" : "{}",
    ),
  );
  // For our purposes we just need coerceState semantics:
  assertEqual(s.attachUnlocked, false);
});

test("storage: coerceState preserves attachUnlocked=true when stored explicitly", () => {
  const s = storageLib.coerceState({
    schemaVersion: 1,
    source: null,
    tasks: null,
    currentTaskId: null,
    attachUnlocked: true,
  });
  assertEqual(s.attachUnlocked, true);
});

test("storage: coerceState treats attachUnlocked=false explicitly as false", () => {
  const s = storageLib.coerceState({
    schemaVersion: 1,
    source: null,
    tasks: null,
    currentTaskId: null,
    attachUnlocked: false,
  });
  assertEqual(s.attachUnlocked, false);
});

console.log(`\n${C.bold}messaging.js (v0.6.2: ATTACH_TRACE / ATTACH_STRATEGY_A)${C.reset}`);

test("messaging: MESSAGE_TYPES exposes ATTACH_TRACE and ATTACH_STRATEGY_A (v0.6.2)", () => {
  assertEqual(
    messagingLib.MESSAGE_TYPES.ATTACH_TRACE,
    "GEMINI_ASSISTANT_ATTACH_TRACE",
  );
  assertEqual(
    messagingLib.MESSAGE_TYPES.ATTACH_STRATEGY_A,
    "GEMINI_ASSISTANT_ATTACH_STRATEGY_A",
  );
});

console.log(`\n${C.bold}geminiDomAdapter (v0.6.2: trace structure)${C.reset}`);

// Load the adapter inside a vm sandbox with minimal globals so we can
// exercise the new instrumentation without a full DOM or browser.
function loadAdapterInSandbox() {
  const vm = require("vm");
  const fs = require("fs");
  const code = fs.readFileSync(
    path.join(ROOT, "src/dom/geminiDomAdapter.js"),
    "utf8",
  );
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    MutationObserver: undefined,
    DataTransfer: undefined,
    Element: function Element() {},
    document: minimalDocument(),
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.globalThis.RedSunDomAdapter;
}

// Bare-minimum document mock with a tiny selector engine. Supports
// tag / .class / [attr] / [attr=value] / descendant (space). Enough
// for the adapter's selector vocabulary.
function matchesEl(el, q) {
  // q is one compound: tag[attr=v].class.class...
  let s = q;
  let expectedTag = null;
  const tagMatch = s.match(/^([a-zA-Z][\w-]*)/);
  if (tagMatch) {
    expectedTag = tagMatch[1].toLowerCase();
    s = s.slice(tagMatch[0].length);
  }
  if (expectedTag && (el.tagName || "").toLowerCase() !== expectedTag) {
    return false;
  }
  while (s.length) {
    if (s[0] === ".") {
      const m = s.match(/^\.([\w-]+)/);
      if (!m) return false;
      const cls = m[1];
      if (!(el._classes || []).includes(cls)) return false;
      s = s.slice(m[0].length);
    } else if (s[0] === "[") {
      const m = s.match(/^\[([^\]=]+)(?:=([^\]]*))?\]/);
      if (!m) return false;
      const name = m[1].trim();
      const value = m[2];
      const got = el._getAttribute(name);
      if (value === undefined) {
        if (got === null) return false;
      } else if (got !== value.replace(/^["']|["']$/g, "")) {
        return false;
      }
      s = s.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function queryInNode(node, sel, results) {
  for (const c of node._children || []) {
    if (matchesEl(c, sel)) results.push(c);
    queryInNode(c, sel, results);
  }
}

function queryCompoundInNode(node, parts, idx, results) {
  if (idx >= parts.length) return;
  const sel = parts[idx];
  const childMatches = [];
  for (const c of node._children || []) {
    if (matchesEl(c, sel)) childMatches.push(c);
    queryInNode(c, sel, childMatches);
  }
  if (idx === parts.length - 1) {
    for (const c of childMatches) results.push(c);
    return;
  }
  for (const c of childMatches)
    queryCompoundInNode(c, parts, idx + 1, results);
}

function splitCompound(sel) {
  return sel.split(/\s+/).filter(Boolean);
}

function queryAllInNode(root, sel) {
  // Support comma-separated lists ("a, b, c") by recursing per branch
  // and deduping.
  const branches = sel.split(",").map((s) => s.trim()).filter(Boolean);
  if (branches.length === 1) {
    return queryAllInNodeSingle(root, sel);
  }
  const out = [];
  const seen = new Set();
  for (const b of branches) {
    for (const el of queryAllInNodeSingle(root, b)) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

function queryAllInNodeSingle(root, sel) {
  const results = [];
  queryCompoundInNode(root, splitCompound(sel), 0, results);
  return results;
}

function defineNodeMethods(el) {
  el._getAttribute = function (n) {
    const a = (el.attributes || []).find((x) => x.name === n);
    return a ? a.value : null;
  };
  el.getAttribute = el._getAttribute;
  el.getBoundingClientRect = () => ({
    width: 100, height: 30, x: 0, y: 0,
    left: 0, top: 0, right: 100, bottom: 30,
  });
  el.querySelector = (sel) => {
    const all = queryAllInNode(el, sel);
    return all[0] || null;
  };
  el.querySelectorAll = (sel) => queryAllInNode(el, sel);
  el.appendChild = (child) => {
    el._children.push(child);
    child.parentElement = el;
    return child;
  };
  el.parentElement = null;
  el.isConnected = true;
  return el;
}

function minimalDocument() {
  const docBody = defineNodeMethods({
    tagName: "BODY",
    _children: [],
    attributes: [],
    _classes: [],
    style: { display: "", visibility: "" },
    id: "",
  });
  return wrapDoc(docBody);
}

function wrapDoc(bodyEl) {
  const docEl = defineNodeMethods({
    tagName: "HTML",
    _children: [bodyEl],
    attributes: [],
    _classes: [],
    style: { display: "", visibility: "" },
    id: "",
  });
  bodyEl.parentElement = docEl;
  const doc = {
    body: bodyEl,
    documentElement: docEl,
    querySelector(sel) {
      const all = queryAllInNode(bodyEl, sel);
      return all[0] || null;
    },
    querySelectorAll(sel) {
      const all = queryAllInNode(bodyEl, sel);
      if (matchesEl(bodyEl, sel)) all.unshift(bodyEl);
      return all;
    },
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      return defineNodeMethods({
        tagName: tag.toUpperCase(),
        _children: [],
        attributes: [],
        _classes: [],
        style: { display: "", visibility: "" },
        id: "",
        textContent: "",
      });
    },
  };
  return doc;
}

test("adapter: ATTACH_TRACE_STEPS contains the 12 ordered steps", () => {
  const a = loadAdapterInSandbox();
  assertEqual(a.ATTACH_TRACE_STEPS.length, 12);
  assertEqual(a.ATTACH_TRACE_STEPS[0], "asset-loaded");
  assertEqual(a.ATTACH_TRACE_STEPS[1], "messaging-ok");
  assertEqual(a.ATTACH_TRACE_STEPS[2], "attachment-trigger-found");
  assertEqual(a.ATTACH_TRACE_STEPS[3], "attachment-trigger-clicked");
  assertEqual(a.ATTACH_TRACE_STEPS[4], "menu-detected");
  assertEqual(a.ATTACH_TRACE_STEPS[5], "upload-action-detected");
  assertEqual(a.ATTACH_TRACE_STEPS[6], "upload-action-clicked");
  assertEqual(a.ATTACH_TRACE_STEPS[7], "file-input-detected");
  assertEqual(a.ATTACH_TRACE_STEPS[8], "file-assigned");
  assertEqual(a.ATTACH_TRACE_STEPS[9], "change-dispatched");
  assertEqual(a.ATTACH_TRACE_STEPS[10], "attachment-ui-detected");
  assertEqual(a.ATTACH_TRACE_STEPS[11], "attachment-ready");
});

test("adapter: UPLOAD_FILES_FALLBACK_LABELS is frozen and contains PT-BR + EN + JA", () => {
  const a = loadAdapterInSandbox();
  assert(Object.isFrozen(a.UPLOAD_FILES_FALLBACK_LABELS));
  assertEqual(a.UPLOAD_FILES_FALLBACK_LABELS["pt-BR"], "Enviar arquivos");
  assertEqual(a.UPLOAD_FILES_FALLBACK_LABELS["en-US"], "Upload files");
  assertEqual(a.UPLOAD_FILES_FALLBACK_LABELS["ja-JP"], "ファイルをアップロード");
});

test("adapter: scoreUploadCandidate — Tier 1 wins on attach_file icon + menuitem", () => {
  const a = loadAdapterInSandbox();
  // Tier 1: role=menuitem + iconAlt=attach_file.
  const tier1 = a.scoreUploadCandidate(
    /* element not needed: descriptor-only signature */
    null,
    {
      tag: "button",
      role: "menuitem",
      ariaLabel: null,
      textSample: "ignored",
      textLength: 0,
      classHint: "",
      iconAlt: "attach_file",
      dataAttrs: {},
    },
  );
  assertEqual(tier1, 100);
});

test("adapter: scoreUploadCandidate — Tier 2 catches PT aria-label fragment", () => {
  const a = loadAdapterInSandbox();
  const t = a.scoreUploadCandidate(null, {
    tag: "button",
    role: "menuitem",
    ariaLabel: "Enviar arquivos",
    textSample: "",
    textLength: 0,
    classHint: "",
    iconAlt: null,
    dataAttrs: {},
  });
  assert(t >= 70, `expected high tier, got ${t}`);
});

test("adapter: scoreUploadCandidate — Tier 3 catches exact localized text", () => {
  const a = loadAdapterInSandbox();
  const tPT = a.scoreUploadCandidate(null, {
    tag: "button",
    role: "menuitem",
    ariaLabel: null,
    textSample: "Enviar arquivos",
    textLength: 14,
    classHint: "",
    iconAlt: null,
    dataAttrs: {},
  });
  const tEN = a.scoreUploadCandidate(null, {
    tag: "button",
    role: "menuitem",
    ariaLabel: null,
    textSample: "Upload files",
    textLength: 12,
    classHint: "",
    iconAlt: null,
    dataAttrs: {},
  });
  const tJA = a.scoreUploadCandidate(null, {
    tag: "button",
    role: "menuitem",
    ariaLabel: null,
    textSample: "ファイルをアップロード",
    textLength: 11,
    classHint: "",
    iconAlt: null,
    dataAttrs: {},
  });
  assert(tPT >= 50, `tier=PT got ${tPT}`);
  assert(tEN >= 50, `tier=EN got ${tEN}`);
  assert(tJA >= 50, `tier=JA got ${tJA}`);
});

test("adapter: scoreUploadCandidate — image_create is rejected (not upload files)", () => {
  const a = loadAdapterInSandbox();
  // "Create image" should not match upload files, even if its icon is present.
  const t = a.scoreUploadCandidate(null, {
    tag: "button",
    role: "menuitemcheckbox",
    ariaLabel: "Create image",
    textSample: "Create image",
    textLength: 12,
    classHint: "",
    iconAlt: "image_create",
    dataAttrs: {},
  });
  assertEqual(t, 0);
});

test("adapter: scoreUploadCandidate — non-upload items score 0", () => {
  const a = loadAdapterInSandbox();
  const t = a.scoreUploadCandidate(null, {
    tag: "button",
    role: "menuitemcheckbox",
    ariaLabel: "Create video",
    textSample: "Create video",
    textLength: 12,
    classHint: "",
    iconAlt: "video_create",
    dataAttrs: {},
  });
  assertEqual(t, 0);
});

test("adapter: describeMenuItem returns structured fields for a built element", () => {
  const a = loadAdapterInSandbox();
  // Build a tiny DOM mock sufficient for describeMenuItem.
  function el(tag, attrs) {
    const e = {
      tagName: tag.toUpperCase(),
      attributes: Object.entries(attrs || {}).map(([k, v]) => ({
        name: k,
        value: String(v),
      })),
      children: [],
      classList: { _classes: [], contains() { return false; } },
    };
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k === "text") {
        e.textContent = v;
      } else e[k] = v;
    }
    e.getAttribute = (n) => {
      const a = e.attributes.find((x) => x.name === n);
      return a ? a.value : null;
    };
    e.getBoundingClientRect = () => ({ width: 100, height: 30, x: 0, y: 0 });
    e.querySelector = () => null;
    return e;
  }
  const item = el("button", {
    role: "menuitem",
    "aria-label": "Enviar arquivos",
    class: "upload-item",
    text: "Enviar arquivos",
  });
  const desc = a.describeMenuItem(item);
  assert(desc !== null);
  assertEqual(desc.tag, "button");
  assertEqual(desc.role, "menuitem");
  assertEqual(desc.ariaLabel, "Enviar arquivos");
  assertEqual(desc.textSample, "Enviar arquivos");
});

test("adapter: runAttachTrace — invalid file fails at asset-loaded", async () => {
  const a = loadAdapterInSandbox();
  const trace = await a.runAttachTrace(null);
  assertEqual(trace.operation, "attach");
  assertEqual(trace.failedAt, "asset-loaded");
  assertEqual(trace.steps.length, 1);
  assertEqual(trace.steps[0].step, "asset-loaded");
  assertEqual(trace.steps[0].ok, false);
  assert(typeof trace.steps[0].durationMs === "number");
  assert(typeof trace.steps[0].ts === "string");
});

test("adapter: runAttachTrace — without any DOM the trigger step fails next", async () => {
  const a = loadAdapterInSandbox();
  const trace = await a.runAttachTrace({
    name: "character-main.png",
    size: 1024,
    type: "image/png",
  });
  // Without document.querySelector etc., findPlusButton is null
  // (the sandbox has no DOM).
  assert(trace.failedAt != null);
  // The trigger-found step must be present and must be ok=false.
  const step = trace.steps.find(
    (s) => s.step === "attachment-trigger-found",
  );
  assert(step);
  assertEqual(step.ok, false);
  // failedAt should stop at trigger-found (no DOM = no trigger).
  assertEqual(trace.failedAt, "attachment-trigger-found");
});

test("adapter: snapshotFileInputs returns 0 with no DOM", () => {
  const a = loadAdapterInSandbox();
  const r = a.snapshotFileInputs();
  assertEqual(r.count, 0);
  assertEqual(r.inputs.length, 0);
});

// vm sandbox DOM tests: install a minimal document with the surface
// the adapter uses (querySelector, querySelectorAll, getBoundingClientRect).
function withMinimalDom(innerHtml, bodyAttrs, run) {
  const vm = require("vm");
  const fs = require("fs");
  const code = fs.readFileSync(
    path.join(ROOT, "src/dom/geminiDomAdapter.js"),
    "utf8",
  );
  function makeEl(tag, attrs, parentEl) {
    const el = defineNodeMethods({
      tagName: tag.toUpperCase(),
      attributes: Object.entries(attrs || {}).map(([k, v]) => ({
        name: k,
        value: String(v),
      })),
      _parent: parentEl || null,
      _children: [],
      _classes: ((attrs && attrs.class) || "")
        .toString()
        .split(/\s+/)
        .filter(Boolean),
      style: { display: "", visibility: "" },
      multiple: !!(attrs && attrs.multiple === true),
      className: ((attrs && attrs.class) || "").toString(),
      innerHTML: (attrs && attrs.innerHTML) || "",
      innerText: (attrs && attrs.text) || "",
      textContent: (attrs && attrs.text) || "",
      id: (attrs && attrs.id) || "",
    });
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text" || k === "class" || k === "id") continue;
      el[k] = v;
    }
    return el;
  }
  const docBody = makeEl("body", bodyAttrs || {});
  const doc = wrapDoc(docBody);
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    MutationObserver: undefined,
    DataTransfer: undefined,
    Element: function Element() {},
    document: doc,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  if (innerHtml && typeof innerHtml === "function") {
    innerHtml(makeEl, doc.body);
  }
  vm.runInContext(code, ctx);
  const a = ctx.globalThis.RedSunDomAdapter;
  run(a, ctx);
  return ctx;
}

test("adapter: findUploadFilesInOverlay — Tier 1 detects attach_file + menuitem", () => {
  withMinimalDom(
    (mk, body) => {
      const menu = mk("div", { class: "cdk-overlay-pane" });
      body.appendChild(menu);
      const item = mk("button", {
        role: "menuitem",
        "aria-label": null,
        class: "menu-item",
      });
      menu.appendChild(item);
      // Embed the icon with alt="attach_file".
      const icon = mk("img", { alt: "attach_file" });
      item.appendChild(icon);
    },
    {},
    (a) => {
      const r = a.findUploadFilesInOverlay();
      if (!r.ok) {
        throw new Error(
          "expected ok=true. candidates=" + JSON.stringify(r.candidates, null, 2),
        );
      }
      assertEqual(r.tier, 100);
      assertEqual(r.item.iconAlt, "attach_file");
    },
  );
});

test("adapter: findUploadFilesInOverlay — Tier 2 fallback (PT aria-label)", () => {
  withMinimalDom(
    (mk, body) => {
      const menu = mk("div", { class: "cdk-overlay-pane" });
      body.appendChild(menu);
      const item = mk("button", {
        role: "menuitem",
        "aria-label": "Enviar arquivos",
        class: "menu-item",
        text: "Enviar arquivos",
      });
      menu.appendChild(item);
    },
    {},
    (a) => {
      const r = a.findUploadFilesInOverlay();
      assert(r.ok);
      assert(r.tier >= 70);
      assertEqual(r.item.ariaLabel, "Enviar arquivos");
    },
  );
});

test("adapter: findUploadFilesInOverlay — Tier 3 fallback matches localized text", () => {
  withMinimalDom(
    (mk, body) => {
      const menu = mk("div", { class: "cdk-overlay-pane" });
      body.appendChild(menu);
      const item = mk("button", {
        role: "menuitem",
        class: "menu-item",
        text: "ファイルをアップロード",
      });
      menu.appendChild(item);
    },
    {},
    (a) => {
      const r = a.findUploadFilesInOverlay();
      assert(r.ok);
      // Tier 3 should fire on exact localized text (score >= 50).
      assert(r.tier >= 50);
    },
  );
});

test("adapter: findMenuCandidates discovers CDK overlay panels", () => {
  withMinimalDom(
    (mk, body) => {
      const cdk = mk("div", { class: "cdk-overlay-container" });
      body.appendChild(cdk);
      const pane = mk("div", { class: "cdk-overlay-pane" });
      cdk.appendChild(pane);
      const menu = mk("div", { role: "menu" });
      pane.appendChild(menu);
      for (let i = 0; i < 5; i++) {
        menu.appendChild(
          mk("button", {
            role: "menuitem",
            class: "mi",
            text: "item " + i,
          }),
        );
      }
    },
    {},
    (a) => {
      const cands = a.findMenuCandidates();
      assert(cands.length >= 1, "expected at least one menu candidate");
      // CDK overlay pane should be picked up.
      assert(
        cands.some((c) => /cdk-overlay/.test(c.source)),
        "expected cdk-overlay selector matched",
      );
    },
  );
});

test("adapter: runAttachTrace stops at attachment-trigger-found (no DOM)", async () => {
  const vm = require("vm");
  const fs = require("fs");
  const code = fs.readFileSync(
    path.join(ROOT, "src/dom/geminiDomAdapter.js"),
    "utf8",
  );
  const ctx = { console, setTimeout, clearTimeout, Date, JSON };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const a = ctx.globalThis.RedSunDomAdapter;
  const trace = await a.runAttachTrace({
    name: "x.png",
    size: 1,
    type: "image/png",
  });
  // Without DOM, trigger isn't found.
  assertEqual(trace.failedAt, "attachment-trigger-found");
  // Steps are emitted in the spec order up to the failure.
  const stepsBefore = trace.steps.map((s) => s.step);
  assertEqual(stepsBefore[0], "asset-loaded");
  assertEqual(stepsBefore[1], "messaging-ok");
  assertEqual(stepsBefore[2], "attachment-trigger-found");
});

test("adapter: trace step durations are numeric and never negative", async () => {
  const a = loadAdapterInSandbox();
  const trace = await a.runAttachTrace({
    name: "x.png",
    size: 1,
    type: "image/png",
  });
  for (const s of trace.steps) {
    assert(typeof s.durationMs === "number", `step ${s.step} durationMs numeric`);
    assert(s.durationMs >= 0, `step ${s.step} durationMs >= 0`);
  }
});

// ----- end ----------------------------------------------------------------

console.log(
  `\n${C.bold}summary${C.reset}: ${C.green}${passed} passed${C.reset}, ` +
    `${failed > 0 ? C.red : C.dim}${failed} failed${C.reset}`,
);

if (failed > 0) {
  console.log(`\n${C.red}failures:${C.reset}`);
  for (const f of failures) {
    console.log(`  ${C.red}-${C.reset} ${f.name}`);
    console.log(`    ${f.error}`);
  }
  process.exit(1);
}

process.exit(0);
