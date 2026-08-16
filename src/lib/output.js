/*
 * output.js
 *
 * Pure helpers for the optional `task.output` block added in v0.6.
 * No DOM, no chrome.* — safe to require in Node tests.
 *
 * Schema (optional, additive over v2):
 *
 *   tasks: [
 *     {
 *       "id": "scene-001",
 *       "title": "Opening shot",
 *       "prompt": "...",
 *       "references": ["character-main", "environment-village", "style-master"],
 *       "output": {
 *         "basename": "scene-001"
 *       }
 *     },
 *     ...
 *   ]
 *
 * Contract:
 *   - `output` is optional. When absent, callers fall back to `task.id`.
 *   - `output.basename` is the LOGICAL identifier only. Never a path.
 *   - When sanitized, the basename is safe to splice into a filename
 *     (the extension is appended later from the detected MIME).
 *
 * Sanitization rules:
 *   - Reject empty / whitespace-only inputs.
 *   - Reject any segment containing:
 *       * path separators: `/`, `\`
 *       * traversal segments: `..` (anywhere)
 *       * null bytes, control chars (< 0x20)
 *       * characters illegal in filenames on macOS / Windows / Linux
 *   - Collapse runs of whitespace into a single space.
 *   - Trim leading/trailing whitespace and dots.
 *   - Truncate to MAX_BASENAME_LENGTH chars.
 *
 * The sanitizer is intentionally strict: anything ambiguous is rejected.
 * Callers should treat a rejection as "fall back to task.id".
 */

(function (globalScope) {
  "use strict";

  const MAX_BASENAME_LENGTH = 80;

  // Illegal filename characters on at least one of macOS / Windows / Linux.
  // We are more conservative than any single OS would require, to keep the
  // resulting name portable across Downloads folders, sync tools, and shells.
  // Excludes: path separators (handled separately), control chars,
  // shell metacharacters, and Windows-reserved characters.
  const ILLEGAL_CHAR_PATTERN = /[<>:"|?*\x00-\x1f\\\/]/;

  function isString(v) {
    return typeof v === "string";
  }

  function isNonEmptyString(v) {
    return isString(v) && v.length > 0;
  }

  /**
   * Strict sanitize for `output.basename`.
   *
   * Returns { ok: true, basename } on success.
   * Returns { ok: false, error, reason } on rejection. The caller decides
   * whether to fall back to task.id (recommended) or surface the error.
   *
   * @param {unknown} raw
   */
  function sanitizeBasename(raw) {
    if (!isString(raw)) {
      return { ok: false, error: "basename must be a string", reason: "not-a-string" };
    }
    // Strip BOM if present.
    let s = raw;
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    s = s.trim();

    if (s.length === 0) {
      return { ok: false, error: "basename is empty", reason: "empty" };
    }

    // Hard rejections first.
    if (s.includes("..")) {
      return { ok: false, error: "basename contains '..' (path traversal)", reason: "traversal" };
    }
    if (ILLEGAL_CHAR_PATTERN.test(s)) {
      return {
        ok: false,
        error:
          "basename contains an illegal character (path separator or control char)",
        reason: "illegal-char",
      };
    }

    // Collapse runs of whitespace.
    s = s.replace(/\s+/g, " ").trim();
    // Trim leading/trailing dots (Windows reserves trailing dot).
    s = s.replace(/^\.+|\.+$/g, "").trim();

    if (s.length === 0) {
      return { ok: false, error: "basename is empty after sanitization", reason: "empty-after" };
    }

    // Reserved Windows device names. We don't want "scene-001" but also
    // we don't want "CON" or "PRN" by accident.
    const reserved = new Set([
      "CON", "PRN", "AUX", "NUL",
      "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
      "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]);
    if (reserved.has(s.toUpperCase())) {
      return { ok: false, error: `basename is a reserved Windows name: ${s}`, reason: "reserved" };
    }

    // Truncate if too long. We don't truncate mid-grapheme; for our scope
    // (ASCII and CJK/Latin names) simple char truncation is acceptable.
    if (s.length > MAX_BASENAME_LENGTH) {
      s = s.slice(0, MAX_BASENAME_LENGTH);
    }

    return { ok: true, basename: s };
  }

  /**
   * Validate the `output` block of a task. Returns:
   *   { ok: true, output: { basename } }            — valid, normalized
   *   { ok: true, output: null }                    — absent or empty
   *   { ok: false, error, reason }                  — malformed
   *
   * On error, callers should treat output as absent.
   *
   * @param {unknown} raw
   */
  function validateTaskOutput(raw) {
    if (raw === undefined || raw === null) return { ok: true, output: null };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "task.output must be an object", reason: "not-an-object" };
    }

    // For now, only `basename` is recognized. Future keys land here.
    const recognizedKeys = new Set(["basename"]);
    for (const k of Object.keys(raw)) {
      if (!recognizedKeys.has(k)) {
        return {
          ok: false,
          error: `task.output has unknown key: "${k}"`,
          reason: "unknown-key",
        };
      }
    }

    if (raw.basename === undefined) {
      // An empty output object is allowed and means "use task.id as fallback".
      // We normalize to `null` here so callers can treat absence uniformly.
      return { ok: true, output: null };
    }

    const r = sanitizeBasename(raw.basename);
    if (!r.ok) {
      return { ok: false, error: r.error, reason: r.reason };
    }
    return { ok: true, output: { basename: r.basename } };
  }

  /**
   * Resolve the effective basename for a task.
   *
   * Priority:
   *   1. task.output.basename (already sanitized at parse-time).
   *   2. task.id (sanitized defensively — task ids are usually safe but
   *      older projects may contain colons, slashes, or whitespace).
   *
   * Never returns a string containing `/`, `\`, or `..`.
   *
   * @param {{ id: string, output?: { basename?: string|null } | null }} task
   */
  function resolveTaskBasename(task) {
    if (!task || !isNonEmptyString(task.id)) {
      return { ok: false, error: "task has no id", reason: "no-task-id" };
    }
    const fromOutput = task?.output?.basename;
    if (isNonEmptyString(fromOutput)) {
      return { ok: true, basename: fromOutput, source: "output" };
    }
    const r = sanitizeBasename(task.id);
    if (!r.ok) {
      // This shouldn't happen for normal v2 tasks. If the task id itself is
      // bad, we return the raw id rather than nothing — the caller decides.
      return {
        ok: false,
        error: `task.id is not a safe basename: ${r.error}`,
        reason: r.reason,
        rawId: task.id,
      };
    }
    return { ok: true, basename: r.basename, source: "task.id" };
  }

  /**
   * Build the final download filename from a basename + detected MIME.
   * Returns null if extension cannot be derived.
   *
   * @param {string} basename  already sanitized
   * @param {string} mimeOrExt  MIME type ("image/png") or extension (".png")
   */
  const MIME_TO_EXT = Object.freeze({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  });

  function buildDownloadFilename(basename, mimeOrExt) {
    if (!isNonEmptyString(basename)) return null;
    let ext = "";
    if (isString(mimeOrExt)) {
      const lower = mimeOrExt.toLowerCase();
      if (lower.startsWith(".")) {
        ext = lower.slice(1);
      } else if (MIME_TO_EXT[lower]) {
        ext = MIME_TO_EXT[lower];
      } else if (/^[a-z0-9]{2,5}$/.test(lower)) {
        // Caller passed a bare extension.
        ext = lower;
      }
    }
    if (!ext) return null;
    // Final defensive sanity-check on the assembled filename.
    const candidate = `${basename}.${ext}`;
    if (candidate.includes("/") || candidate.includes("\\") || candidate.includes("..")) {
      return null;
    }
    return candidate;
  }

  /**
   * Build the relative folder under the user's Downloads directory.
   *   "Gemini Assistant/<project-id>/"
   *
   * project-id is sanitized with the same rules as basename.
   * The folder name "Gemini Assistant" is fixed for this milestone.
   *
   * @param {string} projectId
   */
  function buildDownloadFolder(projectId) {
    if (!isNonEmptyString(projectId)) return null;
    const r = sanitizeBasename(projectId);
    if (!r.ok) return null;
    return `Gemini Assistant/${r.basename}`;
  }

  const api = Object.freeze({
    MAX_BASENAME_LENGTH,
    sanitizeBasename,
    validateTaskOutput,
    resolveTaskBasename,
    buildDownloadFilename,
    buildDownloadFolder,
    MIME_TO_EXT,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalScope.GeminiAssistantOutput = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
