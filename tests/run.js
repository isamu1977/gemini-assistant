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
