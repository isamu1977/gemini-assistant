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

  const api = Object.freeze({
    SUPPORTED_IMAGE_MIME,
    SUPPORTED_IMAGE_EXTENSIONS,
    normalizeRelativePath,
    fileExtension,
    isSupportedImage,
    deriveState,
    resolveAssetFile,
    resolveReferences,
    filesFromResolved,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalScope.GeminiAssistantAssets = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
