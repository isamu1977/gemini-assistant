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
const projectLib = require(path.join(ROOT, "src/lib/project.js"));
const storageLib = require(path.join(ROOT, "src/lib/storage.js"));
const assetsLib = require(path.join(ROOT, "src/lib/assets.js"));

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
