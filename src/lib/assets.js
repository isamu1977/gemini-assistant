/*
 * assets.js
 *
 * Pure helpers for resolving v2 Project assets against a real folder.
 * No DOM, no chrome.* — safe to require in Node tests.
 *
 * Asset "states" (from the resolver's perspective):
 *   - "resolved"    the file was found in the bound folder AND its type
 *                   is in SUPPORTED_IMAGE_MIME (PNG / JPEG / WEBP).
 *   - "missing"     the file was NOT found at the given relative path.
 *   - "unsupported" the file exists but its type is not an image we
 *                   support in this milestone.
 *
 * The resolver is intentionally filesystem-only: the caller passes a
 * FileSystemDirectoryHandle (from window.showDirectoryPicker) plus the
 * asset metadata. We do not touch the filesystem ourselves.
 */

(function (globalScope) {
  "use strict";

  const SUPPORTED_IMAGE_MIME = Object.freeze([
    "image/png",
    "image/jpeg",
    "image/webp",
  ]);

  const SUPPORTED_IMAGE_EXTENSIONS = Object.freeze([
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
  ]);

  /**
   * Compute a hex SHA-256 digest from an ArrayBuffer or Uint8Array.
   * Safe across Browser (crypto.subtle) and Node.js environments.
   */
  async function computeSha256(buffer) {
    if (!buffer) return "";
    try {
      if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
        const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch (_) {}
    try {
      // Node.js fallback
      if (typeof require === "function") {
        const nodeCrypto = require("crypto");
        return nodeCrypto.createHash("sha256").update(Buffer.from(buffer)).digest("hex");
      }
    } catch (_) {}
    // FNV-1a 32-bit fallback
    let hash = 2166136261;
    const view = new Uint8Array(buffer);
    for (let i = 0; i < view.length; i++) {
      hash ^= view[i];
      hash = Math.imul(hash, 16777619);
    }
    return "fnv:" + (hash >>> 0).toString(16);
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function isNonEmptyString(v) {
    return typeof v === "string" && v.length > 0;
  }

  /**
   * Normalize an asset's `file` field into a relative path we can walk.
   * - Trims surrounding whitespace
   * - Replaces backslashes with forward slashes
   * - Removes any leading "/"
   * - Collapses "./" segments and runs of "/" (so "refs/./a.png"
   *   becomes "refs/a.png" rather than being rejected)
   * Returns null if the result is empty or contains a ".." segment
   * (we never want to escape the bound folder).
   */
  function normalizeRelativePath(raw) {
    if (!isNonEmptyString(raw)) return null;
    let s = raw.trim();
    s = s.replace(/\\/g, "/");
    while (s.startsWith("/")) s = s.slice(1);
    // Strip a single leading "./" segment only.
    if (s.startsWith("./")) s = s.slice(2);
    if (s.length === 0) return null;
    const parts = s.split("/").filter((seg) => seg !== "" && seg !== ".");
    if (parts.length === 0) return null;
    for (const seg of parts) {
      if (seg === "..") return null;
    }
    return parts.join("/");
  }

  function fileExtension(name) {
    if (!isNonEmptyString(name)) return "";
    const i = name.lastIndexOf(".");
    if (i < 0 || i === name.length - 1) return "";
    return name.slice(i).toLowerCase();
  }

  /**
   * Decide whether a file name + MIME is one we support for this PoC.
   * The MIME is preferred when present (the File object provides it);
   * otherwise we fall back to the extension.
   *
   * When MIME is provided, it is authoritative: a "image/*" MIME we
   * don't recognize is rejected (no extension-based fallback), and a
   * non-image MIME is rejected outright (we never want to advertise
   * support for a file the OS labeled as e.g. application/pdf even
   * if its name ends in .png).
   */
  function isSupportedImage(name, mime) {
    if (isNonEmptyString(mime)) {
      const m = mime.toLowerCase();
      if (SUPPORTED_IMAGE_MIME.includes(m)) return true;
      // Some browsers report "image/jpg" instead of "image/jpeg"
      if (m === "image/jpg") return true;
      // Non-image MIME: trust it over the filename.
      if (!m.startsWith("image/")) return false;
      // image/* but unsupported subtype (gif, bmp, svg, ...)
      return SUPPORTED_IMAGE_MIME.includes(m);
    }
    const ext = fileExtension(name);
    return SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
  }

  /**
   * Pure state derivation from the resolver result. Used by the UI to
   * render the correct badge/button for each reference. Splits
   * "we didn't find it" from "we found it but it's the wrong kind".
   */
  function deriveState({ found, fileName, fileType }) {
    if (!found) return "missing";
    if (!isSupportedImage(fileName, fileType)) return "unsupported";
    return "resolved";
  }

  /**
   * Walk a relative path inside a directory handle. Returns null if any
   * segment is missing. Uses `getDirectoryHandle` for non-leaf segments
   * and `getFileHandle` for the final segment.
   */
  async function getFileHandleAtPath(directoryHandle, relPath) {
    const parts = relPath.split("/");
    let dir = directoryHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    return await dir.getFileHandle(parts[parts.length - 1]);
  }

  /**
   * Resolve one asset against a bound folder.
   *
   * @param {FileSystemDirectoryHandle} directoryHandle  from showDirectoryPicker
   * @param {{label:string,type:string,file:string}} asset
   * @returns {Promise<{state:'resolved'|'missing'|'unsupported', file?:File, error?:string, fileName?:string, fileType?:string, fileSize?:number, path?:string}>}
   */
  async function resolveAssetFile(directoryHandle, asset) {
    if (
      !directoryHandle ||
      typeof directoryHandle.getDirectoryHandle !== "function"
    ) {
      return { state: "missing", error: "No folder bound" };
    }
    if (!isPlainObject(asset)) {
      return { state: "missing", error: "Invalid asset metadata" };
    }
    const path = normalizeRelativePath(asset.file);
    if (!path) {
      return { state: "missing", error: "Invalid asset file path", fileName: asset.file };
    }

    let fileHandle;
    try {
      fileHandle = await getFileHandleAtPath(directoryHandle, path);
    } catch (e) {
      // NotFoundError is the expected case for missing files.
      return {
        state: "missing",
        path,
        error: e?.message ?? "File not found in bound folder",
      };
    }

    let file;
    try {
      file = await fileHandle.getFile();
    } catch (e) {
      return {
        state: "missing",
        path,
        error: e?.message ?? "Could not read file from bound folder",
      };
    }

    const fileName = file?.name ?? path.split("/").pop();
    const fileType = file?.type ?? "";
    const fileSize = file?.size ?? 0;

    const state = deriveState({ found: true, fileName, fileType });
    if (state !== "resolved") {
      return {
        state,
        path,
        fileName,
        fileType,
        fileSize,
        error: `Unsupported file type: ${fileType || "unknown"} (${fileName})`,
      };
    }

    return {
      state: "resolved",
      path,
      file,
      fileName,
      fileType,
      fileSize,
    };
  }

  /**
   * Convenience: resolve a list of refs in order. Caller passes refs in
   * the order they were declared on the task; results are returned in
   * the same order. Failures are isolated — one missing asset does not
   * prevent resolving the rest.
   */
  async function resolveReferences(directoryHandle, refs) {
    if (!Array.isArray(refs)) return [];
    const out = [];
    for (const r of refs) {
      out.push(await resolveAssetFile(directoryHandle, r));
    }
    return out;
  }

  /**
   * Pick out the File objects from a resolved list, preserving order.
   * Convenience for callers that already filtered.
   */
  function filesFromResolved(resolved) {
    if (!Array.isArray(resolved)) return [];
    return resolved.filter((r) => r && r.state === "resolved" && r.file).map((r) => r.file);
  }

  /**
   * Detect a likely "wrong-root selection" — when the user picked a
   * subfolder (e.g. `references/`) instead of the project root that
   * contains it.
   *
   * The heuristic is conservative; it ONLY flags when:
   *   1. Every asset's relative path begins with the same first segment.
   *   2. That first segment equals the bound folder's name.
   *   3. The spot-check I/O confirms: looking up the basename (the part
   *      AFTER the first segment) inside the bound folder SUCCEEDS.
   *      That is, the file the resolver *should* find at
   *      `<boundRoot>/<basename>` actually exists there.
   *
   * When the I/O check succeeds, we know with high confidence that the
   * user's selected folder is the first-segment subfolder, and the
   * intended project root is its parent.
   *
   * This is a SIDE-CHANNEL check: do NOT auto-fix. We return a structured
   * signal that the UI uses to show a banner.
   *
   * Returns:
   *   { isWrongRoot: false } when the heuristic does not apply.
   *   {
   *     isWrongRoot: true,
   *     selectedRootName: "references",
   *     firstSegment: "references",
   *     sampleCount: 3,
   *     sampleRelativePath: "references/character-main.png",
   *     sampleMatchedBasename: "character-main.png",
   *   } when it does.
   */
  async function detectWrongRootSelection(directoryHandle, refs) {
    if (
      !directoryHandle ||
      typeof directoryHandle.getFileHandle !== "function" ||
      !Array.isArray(refs) ||
      refs.length === 0
    ) {
      return { isWrongRoot: false };
    }

    const rootName = typeof directoryHandle.name === "string" ? directoryHandle.name : "";
    if (!rootName) return { isWrongRoot: false };

    // Phase 1: every asset's first segment must match rootName.
    let firstSegment = null;
    let sample = null;
    let sampleCount = 0;
    for (const r of refs) {
      const rel = normalizeRelativePath(r?.file);
      if (!rel) return { isWrongRoot: false };
      const seg = rel.split("/")[0];
      if (!seg) return { isWrongRoot: false };
      if (firstSegment === null) {
        firstSegment = seg;
      } else if (seg !== firstSegment) {
        // Mixed-first-segments: cannot be a single-subfolder misalignment.
        return { isWrongRoot: false };
      }
      if (sample === null) sample = rel;
      sampleCount++;
    }

    if (firstSegment !== rootName) {
      return { isWrongRoot: false };
    }

    // Phase 2: confirm with a single I/O probe against the first asset.
    // If the basename after the first segment actually exists inside the
    // bound folder, we are confident the user picked the wrong root.
    const firstRel = sample;
    const parts = firstRel.split("/");
    if (parts.length < 2) return { isWrongRoot: false };
    const basename = parts[parts.length - 1];
    try {
      const handle = await directoryHandle.getFileHandle(basename);
      // Touch the handle to confirm it's actually usable, not stale.
      if (!handle || typeof handle.getFile !== "function") {
        return { isWrongRoot: false };
      }
      const f = await handle.getFile();
      if (!f) return { isWrongRoot: false };
      return {
        isWrongRoot: true,
        selectedRootName: rootName,
        firstSegment,
        sampleCount,
        sampleRelativePath: firstRel,
        sampleMatchedBasename: basename,
        sampleFoundFile: { name: f.name, size: f.size, type: f.type },
      };
    } catch (_) {
      // NotFoundError or denied. Not a wrong-root case.
      return { isWrongRoot: false };
    }
  }

  /**
   * Build a structured diagnostic object for a missing asset. Safe to
   * call for any state — fields are filled with what is known.
   *
   * Privacy: never include absolute filesystem paths. The caller passes
   * the relative path that the resolver was looking for; we attach the
   * bound folder name (which the user already knows) and a matched flag.
   */
  function buildMissingDiagnostic({ asset, directoryHandle, expectedRelativePath }) {
    return {
      assetId: asset?.id ?? null,
      assetLabel: asset?.label ?? null,
      assetFile: asset?.file ?? null,
      assetType: asset?.type ?? null,
      logicalPath: expectedRelativePath ?? normalizeRelativePath(asset?.file) ?? null,
      selectedRootName:
        directoryHandle && typeof directoryHandle.name === "string"
          ? directoryHandle.name
          : null,
      expectedRelativePath: expectedRelativePath ?? null,
      matched: false,
    };
  }

  const api = Object.freeze({
    SUPPORTED_IMAGE_MIME,
    SUPPORTED_IMAGE_EXTENSIONS,
    computeSha256,
    normalizeRelativePath,
    fileExtension,
    isSupportedImage,
    deriveState,
    resolveAssetFile,
    resolveReferences,
    filesFromResolved,
    detectWrongRootSelection,
    buildMissingDiagnostic,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalScope.GeminiAssistantAssets = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
