/*
 * project.js
 *
 * Project JSON schema (version 1), validation, and pure helpers.
 * No DOM, no chrome.* — safe to require in Node tests.
 *
 * Shape:
 *   {
 *     "schemaVersion": 1,
 *     "project": { "id": string, "name": string, "description"?: string },
 *     "tasks": [
 *       { "id": string, "title"?: string, "prompt": string },
 *       ...
 *     ]
 *   }
 *
 * Status enum (used by the UI/storage layer):
 *   "pending" | "generated" | "approved" | "redo"
 */

(function (globalScope) {
  "use strict";

  const SUPPORTED_SCHEMA_VERSION = 1;

  const STATUSES = Object.freeze([
    "pending",
    "generated",
    "approved",
    "redo",
  ]);

  const DEFAULT_STATUS = "pending";

  function isString(v) {
    return typeof v === "string";
  }

  function isNonEmptyString(v) {
    return isString(v) && v.length > 0;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  /**
   * Parse a JSON string into a project object, or return a structured error.
   * @param {string} raw
   * @returns {{ ok: true, project: object } | { ok: false, error: string, field?: string }}
   */
  function parseProjectJson(raw) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `Invalid JSON: ${e.message}`, field: "json" };
    }
    return validateProject(obj);
  }

  /**
   * Validate a project object that is already parsed.
   */
  function validateProject(obj) {
    if (!isPlainObject(obj)) {
      return { ok: false, error: "Root must be an object", field: "$" };
    }

    // schemaVersion
    if (obj.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `Unsupported schemaVersion: ${obj.schemaVersion}. Expected ${SUPPORTED_SCHEMA_VERSION}.`,
        field: "schemaVersion",
      };
    }

    // project block
    const proj = obj.project;
    if (!isPlainObject(proj)) {
      return { ok: false, error: "Missing 'project' object", field: "project" };
    }
    if (!isNonEmptyString(proj.id)) {
      return {
        ok: false,
        error: "project.id must be a non-empty string",
        field: "project.id",
      };
    }
    if (!isNonEmptyString(proj.name)) {
      return {
        ok: false,
        error: "project.name must be a non-empty string",
        field: "project.name",
      };
    }
    if (proj.description !== undefined && !isString(proj.description)) {
      return {
        ok: false,
        error: "project.description must be a string when present",
        field: "project.description",
      };
    }

    // tasks
    if (!Array.isArray(obj.tasks)) {
      return {
        ok: false,
        error: "tasks must be an array",
        field: "tasks",
      };
    }
    if (obj.tasks.length === 0) {
      return {
        ok: false,
        error: "tasks must contain at least one task",
        field: "tasks",
      };
    }

    const seenIds = new Map();
    const normalizedTasks = [];

    for (let i = 0; i < obj.tasks.length; i++) {
      const t = obj.tasks[i];
      const fieldBase = `tasks[${i}]`;
      if (!isPlainObject(t)) {
        return {
          ok: false,
          error: `${fieldBase} must be an object`,
          field: fieldBase,
        };
      }
      if (!isNonEmptyString(t.id)) {
        return {
          ok: false,
          error: `${fieldBase}.id must be a non-empty string`,
          field: `${fieldBase}.id`,
        };
      }
      if (seenIds.has(t.id)) {
        return {
          ok: false,
          error: `Duplicate task id: "${t.id}"`,
          field: `${fieldBase}.id`,
        };
      }
      seenIds.set(t.id, true);

      if (!isNonEmptyString(t.prompt)) {
        return {
          ok: false,
          error: `${fieldBase}.prompt must be a non-empty string`,
          field: `${fieldBase}.prompt`,
        };
      }
      if (t.title !== undefined && !isString(t.title)) {
        return {
          ok: false,
          error: `${fieldBase}.title must be a string when present`,
          field: `${fieldBase}.title`,
        };
      }

      normalizedTasks.push({
        id: t.id,
        title: t.title ?? "",
        prompt: t.prompt,
      });
    }

    return {
      ok: true,
      project: {
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        project: {
          id: proj.id,
          name: proj.name,
          description: proj.description ?? "",
        },
        tasks: normalizedTasks,
      },
    };
  }

  /**
   * Build the initial mutable task state from a validated project.
   * Every task gets status="pending" and prompt=source.prompt.
   */
  function buildInitialTaskState(project) {
    const out = {};
    for (const t of project.tasks) {
      out[t.id] = {
        status: DEFAULT_STATUS,
        prompt: t.prompt,
      };
    }
    return out;
  }

  /**
   * Pick the first task id from the project, or null if empty.
   */
  function firstTaskId(project) {
    return project.tasks.length > 0 ? project.tasks[0].id : null;
  }

  /**
   * Find the index of a task by id, or -1 if missing.
   */
  function indexOfTaskId(project, taskId) {
    return project.tasks.findIndex((t) => t.id === taskId);
  }

  /**
   * Compute progress summary from mutable task state.
   * Returns counts per status plus a list of statuses with at least 1 task.
   */
  function summarizeProgress(taskState) {
    const counts = {
      pending: 0,
      generated: 0,
      approved: 0,
      redo: 0,
    };
    for (const id of Object.keys(taskState)) {
      const s = taskState[id]?.status ?? DEFAULT_STATUS;
      if (counts[s] === undefined) continue; // ignore unknown statuses silently
      counts[s] += 1;
    }
    return counts;
  }

  /**
   * Find the next task id in array order, given a current id.
   * Returns null if there is no next task.
   */
  function nextTaskId(project, currentTaskId) {
    const idx = indexOfTaskId(project, currentTaskId);
    if (idx === -1) return null;
    if (idx + 1 >= project.tasks.length) return null;
    return project.tasks[idx + 1].id;
  }

  /**
   * Find the previous task id in array order.
   * Returns null if there is no previous task.
   */
  function prevTaskId(project, currentTaskId) {
    const idx = indexOfTaskId(project, currentTaskId);
    if (idx <= 0) return null;
    return project.tasks[idx - 1].id;
  }

  /**
   * Return true if a status string is one of the supported values.
   */
  function isValidStatus(s) {
    return STATUSES.includes(s);
  }

  /**
   * Strip any mutable-state field that does not belong in the source-of-truth
   * project object. Used defensively before saving/importing.
   */
  function normalizeImportedProject(parsed) {
    return {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      project: {
        id: parsed.project.id,
        name: parsed.project.name,
        description: parsed.project.description ?? "",
      },
      tasks: parsed.tasks.map((t) => ({
        id: t.id,
        title: t.title ?? "",
        prompt: t.prompt,
      })),
    };
  }

  const api = Object.freeze({
    SUPPORTED_SCHEMA_VERSION,
    STATUSES,
    DEFAULT_STATUS,
    parseProjectJson,
    validateProject,
    buildInitialTaskState,
    firstTaskId,
    indexOfTaskId,
    summarizeProgress,
    nextTaskId,
    prevTaskId,
    isValidStatus,
    normalizeImportedProject,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalScope.GeminiAssistantProject = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
