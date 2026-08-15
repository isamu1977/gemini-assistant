/*
 * project.js
 *
 * Project JSON schema (versions 1 and 2), validation, and pure helpers.
 * No DOM, no chrome.* — safe to require in Node tests.
 *
 * Version 1:
 *   {
 *     "schemaVersion": 1,
 *     "project": { "id": string, "name": string, "description"?: string },
 *     "tasks": [{ "id": string, "title"?: string, "prompt": string }]
 *   }
 *
 * Version 2 (additive):
 *   {
 *     "schemaVersion": 2,
 *     "project": { "id": string, "name": string, "description"?: string },
 *     "assets": {                                  // optional; absent treated as {}
 *       "asset-id": {
 *         "label": string,                          // required, non-empty
 *         "type": "character"|"environment"|"style"|"object"|"other",
 *         "file": string                            // required, non-empty
 *       },
 *       ...
 *     },
 *     "tasks": [
 *       {
 *         "id": string,
 *         "title"?: string,
 *         "prompt": string,
 *         "references": ["asset-id", ...]            // optional; absent treated as []
 *       }
 *     ]
 *   }
 *
 * Tasks must reference existing assets. Tasks without `references` are valid.
 *
 * Status enum (used by the UI/storage layer):
 *   "pending" | "generated" | "approved" | "redo"
 */

(function (globalScope) {
  "use strict";

  const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);
  const CURRENT_SCHEMA_VERSION = 2;

  const STATUSES = Object.freeze([
    "pending",
    "generated",
    "approved",
    "redo",
  ]);

  const DEFAULT_STATUS = "pending";

  const ASSET_TYPES = Object.freeze([
    "character",
    "environment",
    "style",
    "object",
    "other",
  ]);

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

    // schemaVersion: accept 1 OR 2 (forward-compat: reject anything else)
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(obj.schemaVersion)) {
      return {
        ok: false,
        error: `Unsupported schemaVersion: ${obj.schemaVersion}. Expected one of ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}.`,
        field: "schemaVersion",
      };
    }
    const schemaVersion = obj.schemaVersion;

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

    // assets (v2 only; v1 has none)
    let normalizedAssets = {};
    if (schemaVersion === 2) {
      if (obj.assets !== undefined) {
        if (!isPlainObject(obj.assets)) {
          return {
            ok: false,
            error: "assets must be an object when present",
            field: "assets",
          };
        }
        const seenAssetIds = new Set();
        for (const id of Object.keys(obj.assets)) {
          if (!isNonEmptyString(id)) {
            return {
              ok: false,
              error: `assets["${id}"] has invalid id`,
              field: `assets["${id}"]`,
            };
          }
          if (seenAssetIds.has(id)) {
            return {
              ok: false,
              error: `Duplicate asset id: "${id}"`,
              field: `assets["${id}"]`,
            };
          }
          seenAssetIds.add(id);
          const a = obj.assets[id];
          const fieldBase = `assets["${id}"]`;
          if (!isPlainObject(a)) {
            return {
              ok: false,
              error: `${fieldBase} must be an object`,
              field: fieldBase,
            };
          }
          if (!isNonEmptyString(a.label)) {
            return {
              ok: false,
              error: `${fieldBase}.label must be a non-empty string`,
              field: `${fieldBase}.label`,
            };
          }
          if (!isNonEmptyString(a.type) || !ASSET_TYPES.includes(a.type)) {
            return {
              ok: false,
              error: `${fieldBase}.type must be one of ${ASSET_TYPES.join(", ")}`,
              field: `${fieldBase}.type`,
            };
          }
          if (!isNonEmptyString(a.file)) {
            return {
              ok: false,
              error: `${fieldBase}.file must be a non-empty string`,
              field: `${fieldBase}.file`,
            };
          }
          normalizedAssets[id] = {
            label: a.label,
            type: a.type,
            file: a.file,
          };
        }
      }
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

    const seenTaskIds = new Set();
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
      if (seenTaskIds.has(t.id)) {
        return {
          ok: false,
          error: `Duplicate task id: "${t.id}"`,
          field: `${fieldBase}.id`,
        };
      }
      seenTaskIds.add(t.id);

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

      // references (v2 only; v1 has none)
      let normalizedRefs = [];
      if (schemaVersion === 2 && t.references !== undefined) {
        if (!Array.isArray(t.references)) {
          return {
            ok: false,
            error: `${fieldBase}.references must be an array`,
            field: `${fieldBase}.references`,
          };
        }
        const seenRefIds = new Set();
        for (let j = 0; j < t.references.length; j++) {
          const ref = t.references[j];
          const refField = `${fieldBase}.references[${j}]`;
          if (!isString(ref)) {
            return {
              ok: false,
              error: `${refField} must be a string`,
              field: refField,
            };
          }
          if (seenRefIds.has(ref)) {
            return {
              ok: false,
              error: `${fieldBase} has duplicate reference: "${ref}"`,
              field: refField,
            };
          }
          seenRefIds.add(ref);
          if (!Object.prototype.hasOwnProperty.call(normalizedAssets, ref)) {
            return {
              ok: false,
              error: `${fieldBase} references unknown asset: "${ref}"`,
              field: refField,
            };
          }
          normalizedRefs.push(ref);
        }
      }

      normalizedTasks.push({
        id: t.id,
        title: t.title ?? "",
        prompt: t.prompt,
        references: normalizedRefs,
      });
    }

    return {
      ok: true,
      project: {
        schemaVersion,
        project: {
          id: proj.id,
          name: proj.name,
          description: proj.description ?? "",
        },
        assets: normalizedAssets,
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
      if (counts[s] === undefined) continue;
      counts[s] += 1;
    }
    return counts;
  }

  function nextTaskId(project, currentTaskId) {
    const idx = indexOfTaskId(project, currentTaskId);
    if (idx === -1) return null;
    if (idx + 1 >= project.tasks.length) return null;
    return project.tasks[idx + 1].id;
  }

  function prevTaskId(project, currentTaskId) {
    const idx = indexOfTaskId(project, currentTaskId);
    if (idx <= 0) return null;
    return project.tasks[idx - 1].id;
  }

  function isValidStatus(s) {
    return STATUSES.includes(s);
  }

  /**
   * Resolve a task's references into fully resolved asset objects.
   * Order is the order declared in `task.references`. Returns [] if the
   * task has no references or the project has no assets.
   *
   * @param {object} project
   * @param {string} taskId
   * @returns {Array<{ id: string, label: string, type: string, file: string }>}
   */
  function resolveReferences(project, taskId) {
    const task = project.tasks.find((t) => t.id === taskId);
    if (!task || !Array.isArray(task.references) || task.references.length === 0) {
      return [];
    }
    const assets = project.assets || {};
    const out = [];
    for (const refId of task.references) {
      const a = assets[refId];
      if (!a) continue; // validated at parse time, but defend anyway
      out.push({ id: refId, label: a.label, type: a.type, file: a.file });
    }
    return out;
  }

  /**
   * Count assets defined in the project.
   */
  function countAssets(project) {
    if (!project || !project.assets) return 0;
    return Object.keys(project.assets).length;
  }

  /**
   * Strip any mutable-state field that does not belong in the source-of-truth
   * project object. Used defensively before saving/importing.
   */
  function normalizeImportedProject(parsed) {
    return {
      schemaVersion: parsed.schemaVersion,
      project: {
        id: parsed.project.id,
        name: parsed.project.name,
        description: parsed.project.description ?? "",
      },
      assets: { ...(parsed.assets ?? {}) },
      tasks: parsed.tasks.map((t) => ({
        id: t.id,
        title: t.title ?? "",
        prompt: t.prompt,
        references: Array.isArray(t.references) ? [...t.references] : [],
      })),
    };
  }

  const api = Object.freeze({
    SUPPORTED_SCHEMA_VERSIONS,
    CURRENT_SCHEMA_VERSION,
    STATUSES,
    DEFAULT_STATUS,
    ASSET_TYPES,
    parseProjectJson,
    validateProject,
    buildInitialTaskState,
    firstTaskId,
    indexOfTaskId,
    summarizeProgress,
    nextTaskId,
    prevTaskId,
    isValidStatus,
    resolveReferences,
    countAssets,
    normalizeImportedProject,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalScope.GeminiAssistantProject = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);