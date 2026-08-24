# Gemini Assistant — AI Agent Specification (Hermes Agent Guide)

This document is the authoritative specification for AI Agents (such as **Hermes Agent**) tasked with generating project packages, assets, and JSON files for **Gemini Assistant**.

Gemini Assistant is a Chrome Extension (Manifest V3) that automates image generation workflows on `gemini.google.com` by reading a **Project JSON**, resolving reference images from a **bound local folder**, and executing tasks via DOM automation.

---

## 1. Package Directory Structure

When creating a new project for Gemini Assistant, generate a self-contained directory with this exact layout:

```text
<project-id>/
├── project.json              # Project definition (Schema v3)
└── references/               # Subdirectory holding all reference image files
    ├── character-main.png
    ├── character-secondary.jpeg
    ├── environment-village.jpg
    └── style-master.webp
```

### Folder Rules
1. All reference image files MUST reside inside the `references/` subdirectory (or nested under `references/`).
2. The user will bind the `<project-id>` root folder in Gemini Assistant.
3. Every file path declared in `assets.<asset-id>.file` MUST be a relative path starting with `references/` (e.g. `"references/character-main.png"`).
4. Do NOT use absolute paths (`/Users/...`, `C:\...`) or parent traversal (`../`).

---

## 2. Supported Image Formats

Reference images in `references/` must be in one of the following formats:

| Format | Allowed Extensions | MIME Type |
| :--- | :--- | :--- |
| PNG | `.png` | `image/png` |
| JPEG | `.jpg`, `.jpeg` | `image/jpeg` |
| WebP | `.webp` | `image/webp` |

> [!WARNING]
> `.gif`, `.svg`, `.bmp`, and `.tiff` are **unsupported** as reference assets.

---

## 3. Project JSON Schema (Version 3)

The project file (typically `project.json`) must strictly adhere to **Schema Version 3**.

### Schema Definition

```jsonc
{
  "schemaVersion": 3,
  "project": {
    "id": "project-slug-id",            // Required: string, non-empty, safe slug
    "name": "Human Readable Name",      // Required: string, non-empty
    "description": "Optional summary"   // Optional: string
  },
  "generation": {
    "masterPrompt": "...",              // Required: string, non-empty (art direction & style)
    "aspectRatio": "16:9",              // Optional: "16:9" | "9:16" | "1:1" | "4:3" | "3:4"
    "sceneSeparator": "\n\nSCENE:\n"    // Optional: string (defaults to "\n\nSCENE:\n")
  },
  "assets": {                           // Optional (or object of asset objects)
    "<asset-id>": {
      "label": "Display Label",         // Required: string, non-empty
      "type": "character",              // Required: "character" | "environment" | "style" | "object" | "other"
      "file": "references/filename.png" // Required: string, relative path under references/
    }
  },
  "tasks": [                            // Required: array with at least 1 task
    {
      "id": "scene-001",                // Required: string, unique per project
      "title": "Scene Title",           // Optional: string
      "prompt": "...",                  // Required: string, non-empty (scene specific)
      "references": [                   // Optional: array of asset IDs
        "character-main",
        "style-master"
      ],
      "output": {                       // Optional: output file naming config
        "fileName": "scene-001-custom"  // Optional: string, sanitized filename (no extension)
      }
    }
  ]
}
```

---

## 4. Field Details & Constraints

### 4.1 `project`
- **`id`** (`string`, required): Unique identifier for the project. Used to create the download directory: `Downloads/Gemini Assistant/<project.id>/`.
  - Use alphanumeric characters, hyphens, or underscores (e.g. `"yuki-onna-vol1"`).
- **`name`** (`string`, required): Display title in the Gemini Assistant side panel.
- **`description`** (`string`, optional): Brief context about the project.

### 4.2 `generation` (Schema v3)
- **`masterPrompt`** (`string`, required): The global art style, rendering technique, color palette, lighting guidelines, and negative exclusions.
- **`aspectRatio`** (`string`, optional): Target framing (e.g. `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"`, `"3:4"`).
- **`sceneSeparator`** (`string`, optional): Separator placed between master instructions and the scene prompt. Default: `"\n\nSCENE:\n"`.

### 4.3 `assets`
- Keys are unique asset IDs (e.g. `"character-yuki"`, `"env-mountain-path"`).
- **`label`** (`string`, required): Descriptive name shown in the UI.
- **`type`** (`string`, required): Must be strictly one of:
  - `"character"` — character portraits, facial expressions, outfits.
  - `"environment"` — scenery, locations, backgrounds, weather.
  - `"style"` — art medium, brushwork, lighting reference, master mood.
  - `"object"` — items, weapons, vehicles, artifacts.
  - `"other"` — miscellaneous reference.
- **`file`** (`string`, required): Path relative to the project root (e.g. `"references/yuki_portrait.png"`).

### 4.4 `tasks`
- **`id`** (`string`, required): Unique task ID (e.g. `"scene-001"`, `"shot-02"`).
- **`title`** (`string`, optional): Brief title for the shot/scene.
- **`prompt`** (`string`, required): Scene-specific content describing composition, action, characters, framing, and mood.
- **`references`** (`string[]`, optional): Array of asset IDs defined in `assets`.
  - **Ordering matters**: Gemini Assistant attaches images to Gemini's composer in the exact order listed in this array.
  - Maximum recommended references per task: 1 to 4 images.
- **`output.fileName`** (`string`, optional): Base filename for downloaded images (without extension).
  - If omitted, Gemini Assistant automatically falls back to `<task.id>-<slugified-title>` (or `<task.id>` if title is absent).

---

## 5. Prompt Composition Mechanics

When Gemini Assistant executes a task, it automatically runs `buildFinalPrompt()`:

```text
${masterPrompt}

IMAGE FORMAT:
Generate the final image in a ${aspectRatio} aspect ratio.
Compose subjects clearly and safely within the specified frame dimensions.

SCENE:
${task.prompt}
```

### Prompt Authoring Guidelines for Agents:
1. **Never duplicate the style in task prompts**: Keep `generation.masterPrompt` responsible for the medium (e.g., "19th-century Japanese woodblock sumi-e print"), camera/brushwork, lighting rules, and negative constraints ("STYLE EXCLUSIONS: no 3D render, no modern items...").
2. **Keep task prompts focused on the scene**: Detail only the specific characters, actions, poses, emotional expressions, lighting nuances, and background environment for that particular frame.
3. **Reference consistency**: When mentioning characters or objects in the scene prompt, use visual descriptions that align with the attached `references`.

---

## 6. Sanitization & Safe Naming Rules

When generating `id`, `output.fileName`, or asset files:
- **Prohibited Characters**: `[<>:"|?*\\/\x00-\x1f]` and traversal segment `..`.
- **Reserved Windows Names**: Do NOT use `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`.
- **Length Limit**: Filenames and IDs are truncated to a maximum of 80 characters.

---

## 7. Complete Reference Example (One-Shot)

```json
{
  "schemaVersion": 3,
  "project": {
    "id": "yuki-onna-legend",
    "name": "Legend of Yuki-onna",
    "description": "5-scene cinematic dark fantasy story set in Edo-period Japan."
  },
  "generation": {
    "masterPrompt": "Cinematic semi-realistic historical dark fantasy digital painting, grounded painterly realism, natural human anatomy, textured fabric and weathered wood.\n\nMoody cinematic lighting, soft volumetric mist, muted charcoal and indigo palette with warm amber lantern highlights.\n\nSTYLE EXCLUSIONS:\nno anime, no manga, no 3D render, no glossy fantasy, no modern objects, no oversaturated colors.",
    "aspectRatio": "16:9",
    "sceneSeparator": "\n\nSCENE:\n"
  },
  "assets": {
    "char-yuki": {
      "label": "Yuki-onna Portrait",
      "type": "character",
      "file": "references/yuki_portrait.png"
    },
    "env-snow-village": {
      "label": "Snow Village",
      "type": "environment",
      "file": "references/village_snow.jpg"
    },
    "style-master": {
      "label": "Ukiyo-e Master Style",
      "type": "style",
      "file": "references/style_reference.png"
    }
  },
  "tasks": [
    {
      "id": "scene-001",
      "title": "First Snowfall",
      "prompt": "Wide establishing shot of a remote snow-covered village at dusk. Paper lanterns glow faintly amber behind frosted shoji screens. Heavy snowfall over cedar trees.",
      "references": ["env-snow-village", "style-master"],
      "output": {
        "fileName": "scene-001-first-snowfall"
      }
    },
    {
      "id": "scene-002",
      "title": "Yuki-onna on the Bridge",
      "prompt": "Medium shot of Yuki-onna standing barefoot on a snow-covered wooden footbridge over an icy stream. Pale translucent skin, long straight black hair, wearing a white kimono.",
      "references": ["char-yuki", "style-master"],
      "output": {
        "fileName": "scene-002-yuki-bridge"
      }
    }
  ]
}
```

---

## 8. Agent Pre-Flight Checklist

Before finalizing and saving files to disk, Hermes Agent should verify:

- [ ] `project.json` exists at the root of `<project-folder>/`.
- [ ] `references/` directory exists and contains all image files referenced in `assets`.
- [ ] All image files are valid `.png`, `.jpg`, `.jpeg`, or `.webp`.
- [ ] `schemaVersion` is `3`.
- [ ] `project.id` and `project.name` are non-empty strings.
- [ ] `generation.masterPrompt` is non-empty.
- [ ] Every asset `id` in `assets` has `label`, valid `type` enum, and relative `file` path.
- [ ] Every reference string in `tasks[].references` matches an existing key in `assets`.
- [ ] Task IDs are unique non-empty strings.
- [ ] No `..` or absolute paths are used anywhere in the JSON.
