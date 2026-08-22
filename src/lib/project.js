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
 * Version 3 (additive):
 *   {
 *     "schemaVersion": 3,
 *     "project": { ... },
 *     "generation": {                                  // required in v3
 *       "masterPrompt": string,                       // non-empty
 *       "aspectRatio": string,                        // e.g. "16:9", "3:4"
 *       "sceneSeparator": string                      // e.g. "\n\nSCENE:\n"
 *     },
 *     "assets": { ... },                              // same as v2
 *     "tasks": [ ... ]                                // same as v2
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

  const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2, 3]);
  const CURRENT_SCHEMA_VERSION = 3;

  // Optional output block on tasks (added in v0.6, additive).
  // Lazily required so project.js can still be loaded standalone in tests
  // that don't touch the output block.
  const outputLib =
    (typeof require === "function" && typeof module !== "undefined" && module.exports)
      ? null
      : globalScope.GeminiAssistantOutput || null;

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

    // generation block (v2+; v1 has none)
    let normalizedGeneration = null;
    if (schemaVersion >= 2) {
      if (obj.generation !== undefined) {
        if (!isPlainObject(obj.generation)) {
          return {
            ok: false,
            error: "generation must be an object when present",
            field: "generation",
          };
        }
        const gen = obj.generation;
        if (!isNonEmptyString(gen.masterPrompt)) {
          return {
            ok: false,
            error: "generation.masterPrompt must be a non-empty string",
            field: "generation.masterPrompt",
          };
        }
        if (gen.aspectRatio !== undefined && !isString(gen.aspectRatio)) {
          return {
            ok: false,
            error: "generation.aspectRatio must be a string when present",
            field: "generation.aspectRatio",
          };
        }
        normalizedGeneration = {
          masterPrompt: gen.masterPrompt,
          aspectRatio: isNonEmptyString(gen.aspectRatio) ? gen.aspectRatio : "",
          sceneSeparator: typeof gen.sceneSeparator === "string" ? gen.sceneSeparator : "\n\nSCENE:\n",
        };
      }
    }

    // assets (v2+; v1 has none)
    let normalizedAssets = {};
    if (schemaVersion >= 2) {
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

      // references (v2+; v1 has none)
      let normalizedRefs = [];
      if (schemaVersion >= 2 && t.references !== undefined) {
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

      // output (optional, both v1 and v2; added in v0.6)
      let normalizedOutput = null;
      if (t.output !== undefined) {
        if (
          typeof globalScope === "undefined" ||
          !globalScope.GeminiAssistantOutput ||
          typeof globalScope.GeminiAssistantOutput.validateTaskOutput !== "function"
        ) {
          return {
            ok: false,
            error: `${fieldBase}.output present but output.js was not loaded; cannot validate`,
            field: `${fieldBase}.output`,
          };
        }
        const out = globalScope.GeminiAssistantOutput.validateTaskOutput(t.output);
        if (!out.ok) {
          return {
            ok: false,
            error: `${fieldBase}.output: ${out.error}`,
            field: `${fieldBase}.output`,
          };
        }
        // out.output may be null (absent) or { basename: "..." }.
        normalizedOutput = out.output && out.output.basename ? out.output : null;
      }

      normalizedTasks.push({
        id: t.id,
        title: t.title ?? "",
        prompt: t.prompt,
        references: normalizedRefs,
        output: normalizedOutput,
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
        generation: normalizedGeneration,
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
   * Resolve the effective `output.basename` for a given task id.
   * Returns null when no usable basename exists.
   * Pure: does not touch the DOM, chrome.*, or storage.
   */
  function resolveTaskOutputBasename(project, taskId) {
    if (!project || !Array.isArray(project.tasks)) return null;
    const task = project.tasks.find((t) => t && t.id === taskId);
    if (!task) return null;
    // Defer to outputLib if loaded; otherwise fall back to task.id.
    if (
      typeof globalScope !== "undefined" &&
      globalScope.GeminiAssistantOutput &&
      typeof globalScope.GeminiAssistantOutput.resolveTaskBasename === "function"
    ) {
      const r = globalScope.GeminiAssistantOutput.resolveTaskBasename(task);
      if (r && r.ok) return r.basename;
      return null;
    }
    // Fallback: use task.id verbatim when output.js hasn't been loaded yet.
    // Callers (Node tests) must load output.js if they want sanitization.
    return task.id || null;
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
   * Natural-language image format instruction based on generation.aspectRatio.
   *
   * @param {string|null|undefined} aspectRatio e.g. "16:9", "9:16", "1:1"
   * @returns {string}
   */
  function buildAspectRatioInstruction(aspectRatio) {
    if (!aspectRatio || typeof aspectRatio !== "string") return "";
    const cleanAr = aspectRatio.trim();
    if (!cleanAr) return "";

    if (cleanAr === "16:9") {
      return (
        "IMAGE FORMAT:\n" +
        "Generate the final image in a cinematic 16:9 landscape aspect ratio.\n" +
        "Use a wide horizontal composition.\n" +
        "Do not produce portrait, square, or near-square framing.\n" +
        "Compose for video use, keeping key subjects and essential visual information safely inside the frame with natural breathing room near the edges."
      );
    }

    if (cleanAr === "9:16") {
      return (
        "IMAGE FORMAT:\n" +
        "Generate the final image in a vertical 9:16 portrait aspect ratio.\n" +
        "Use a tall vertical composition optimized for mobile full-screen viewing.\n" +
        "Do not produce landscape, square, or near-square framing.\n" +
        "Keep key subjects and essential visual information centered and safely inside vertical boundaries."
      );
    }

    if (cleanAr === "1:1") {
      return (
        "IMAGE FORMAT:\n" +
        "Generate the final image in a 1:1 square aspect ratio.\n" +
        "Use a balanced square composition with equal width and height.\n" +
        "Do not produce landscape or portrait framing.\n" +
        "Keep key subjects well-centered within the square frame."
      );
    }

    return (
      "IMAGE FORMAT:\n" +
      `Generate the final image in a ${cleanAr} aspect ratio.\n` +
      "Compose subjects clearly and safely within the specified frame dimensions."
    );
  }

  /**
   * Pure, centralized single source of truth for constructing the final prompt
   * to be inserted into Gemini.
   *
   * If the project defines generation, combines:
   *   `${masterPrompt}\n\n${aspectRatioInstruction}${sceneSeparator}${scenePrompt}`
   * where sceneSeparator defaults to "\n\nSCENE:\n".
   *
   * If generation is absent (e.g. schemaVersion 1 or 2), returns
   * the scene prompt verbatim.
   *
   * @param {object} project - Validated project object
   * @param {object|string} task - Task object or prompt string
   * @returns {string} The final composite prompt text
   */
  function buildFinalPrompt(project, task) {
    if (!task) return "";
    const scenePrompt = typeof task === "string" ? task : (task.prompt || "");
    if (!project || !project.generation) {
      return scenePrompt;
    }

    const master = isNonEmptyString(project.generation.masterPrompt)
      ? String(project.generation.masterPrompt).trim()
      : "";
    const aspectInstr = isNonEmptyString(project.generation.aspectRatio)
      ? buildAspectRatioInstruction(project.generation.aspectRatio)
      : "";

    let header = "";
    if (master && aspectInstr) {
      header = `${master}\n\n${aspectInstr}`;
    } else if (master) {
      header = master;
    } else if (aspectInstr) {
      header = aspectInstr;
    }

    if (!header) {
      return scenePrompt;
    }

    const sep = project.generation.sceneSeparator !== undefined
      ? project.generation.sceneSeparator
      : "\n\nSCENE:\n";

    return `${header}${sep}${scenePrompt}`;
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
      generation: parsed.generation ? {
        masterPrompt: parsed.generation.masterPrompt,
        aspectRatio: parsed.generation.aspectRatio,
        sceneSeparator: parsed.generation.sceneSeparator,
      } : null,
      assets: { ...(parsed.assets ?? {}) },
      tasks: parsed.tasks.map((t) => ({
        id: t.id,
        title: t.title ?? "",
        prompt: t.prompt,
        references: Array.isArray(t.references) ? [...t.references] : [],
        output: t.output && t.output.basename ? { basename: t.output.basename } : null,
      })),
    };
  }

  function normalizeText(text) {
    if (typeof text !== "string") return "";
    return text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
  }

  function normalizeExpectedPrompt(text) {
    return normalizeText(text);
  }

  function normalizeGeminiComposerText(text) {
    return normalizeText(text);
  }

  function verifyPromptContent(expectedRaw, actualRaw) {
    const exp = typeof expectedRaw === "string" ? expectedRaw : "";
    const act = typeof actualRaw === "string" ? actualRaw : "";

    const normExp = normalizeExpectedPrompt(exp);
    const normAct = normalizeGeminiComposerText(act);

    if (normExp === normAct) {
      return {
        ok: true,
        expectedRawLength: exp.length,
        actualRawLength: act.length,
        expectedNormLength: normExp.length,
        actualNormLength: normAct.length,
        normalizedMatch: true,
      };
    }

    // Secondary tolerance: check paragraph newline runs (Quill adds extra blank paragraphs)
    const normExpPara = normExp.replace(/\n{3,}/g, "\n\n");
    const normActPara = normAct.replace(/\n{3,}/g, "\n\n");
    if (normExpPara === normActPara) {
      return {
        ok: true,
        expectedRawLength: exp.length,
        actualRawLength: act.length,
        expectedNormLength: normExp.length,
        actualNormLength: normAct.length,
        normalizedMatch: true,
        slackReason: "paragraph-newlines-normalized",
      };
    }

    // Determine first mismatch index
    let mismatchIdx = -1;
    const minLen = Math.min(normExp.length, normAct.length);
    for (let i = 0; i < minLen; i++) {
      if (normExp[i] !== normAct[i]) {
        mismatchIdx = i;
        break;
      }
    }
    if (mismatchIdx === -1 && normExp.length !== normAct.length) {
      mismatchIdx = minLen;
    }

    const startCtx = Math.max(0, mismatchIdx - 25);
    const endCtxExp = Math.min(normExp.length, mismatchIdx + 25);
    const endCtxAct = Math.min(normAct.length, mismatchIdx + 25);

    const expSnippet = normExp.slice(startCtx, endCtxExp);
    const actSnippet = normAct.slice(startCtx, endCtxAct);

    return {
      ok: false,
      expectedRawLength: exp.length,
      actualRawLength: act.length,
      expectedNormLength: normExp.length,
      actualNormLength: normAct.length,
      normalizedMatch: false,
      mismatchIndex: mismatchIdx,
      expectedSnippet: expSnippet,
      actualSnippet: actSnippet,
      error: `Prompt verification failed at char ${mismatchIdx}: expected "...${expSnippet}..." but found "...${actSnippet}..." (expected ${normExp.length} normalized chars, found ${normAct.length})`,
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
    buildFinalPrompt,
    buildAspectRatioInstruction,
    normalizeExpectedPrompt,
    normalizeGeminiComposerText,
    verifyPromptContent,
    firstTaskId,
    indexOfTaskId,
    summarizeProgress,
    nextTaskId,
    prevTaskId,
    isValidStatus,
    resolveReferences,
    countAssets,
    normalizeImportedProject,
    resolveTaskOutputBasename,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalScope.GeminiAssistantProject = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);