# v0.6 Manual Test Plan — Single-Task Image Generation

This document covers the **four manual tests** you must run on a real
Chrome session against `https://gemini.google.com/app`. Mocks and
Playwright DOM tests do **not** substitute for these — they validate the
state machine; only real Gemini proves the wiring.

> Pre-requisites:
> - Gemini Assistant v0.6.1 installed (Chrome `chrome://extensions` → Load unpacked → repo root).
> - Signed in to gemini.google.com as Pro (image generation needs it).
> - A real project folder with the `tests/references/` images, OR your own.

> v0.6.1 addition: a new **Ping Gemini** button in the Generation card
> runs `GEMINI_ASSISTANT_PING` end-to-end. Use it to confirm the
> Side Panel ↔ content script bridge is alive before testing anything
> else. The **Messaging** row in the Generation card shows
> `✓ Connected` (ok) or `✕ Error` (with the reason in the Debug card).

---

## Test 0 — Messaging (v0.6.1 prerequisite)

**Goal**: verify that the Side Panel can talk to the Gemini content
script at all.

1. Open `https://gemini.google.com/app`.
2. Open the Gemini Assistant Side Panel.
3. Click **Ping Gemini** in the Generation card header.

Expected:
- Status line: `Messaging ✓ connected (tab N, https://gemini.google.com/app)`.
- The **Messaging** row in the Generation card shows `✓ Connected`.
- The Debug card shows the self-test JSON (same as in v0.6.0).

Failure modes:
- `✕ Error: No Gemini tab found. Open https://gemini.google.com/...`
  → the page is on a different host. Open the Gemini tab first.
- `✕ Error: Could not establish connection. Receiving end does not
  exist.` → content script not injected (rare — re-load the extension).

If Test 0 fails, **stop** — Tests A–D cannot pass.

---

## Test A — Image Mode

**Goal**: verify the popup can reliably switch Gemini to Image
Generation mode.

1. Pass Test 0 first.
2. Load the bundled example project (`examples/example-project-v2.json`).
3. Bind the project folder to the repo root (containing `tests/references/`).
4. Select **scene-001**.
5. Click **Ensure Image Mode**.

Expected:
- Workflow phase indicator shows `preparing-image-mode` briefly, then
  returns to `idle`.
- The "Image Mode" row in the Generation card shows `IMAGE MODE — ✓ Ready`.
- On the Gemini page, a new button labeled "Images" (or "Deselect
  Images", depending on locale) appears next to the + button. The
  composer placeholder is "Describe your image".
- Status line: "Image Generation mode ready."

Failure modes:
- "Could not communicate with Gemini content script." — re-run Test 0
  to see the underlying error in the Debug card.
- "Could not find the + (Upload & tools) button." — Gemini UI changed;
  re-inspect DOM and add a new fallback in `findPlusButton`.
- "Could not find 'Create image' in the + menu." — Gemini changed the
  menu structure. v0.6.1 already accepts the PT-BR variant "Criar
  imagem"; check the Debug card's imageMode probe and update
  `findCreateImageMenuitem` if needed.
- "Clicked Create image but image mode did not become active within the
  timeout." — Gemini added a confirmation step; check if a dialog
  needs closing.

---

## Test B — Single Attachment

**Goal**: verify one reference image can be attached via the side
panel.

1. Continue from Test A (Image Mode must remain on).
2. In the references list for **scene-001**, click the **Attach** button
   next to `Yuki` (character-main).
3. Watch the status line and the composer.

Expected:
- Status: `Attaching character-main.png…` → `✓ character-main attached
  (1.0 KB) to Gemini. Review and send.`
- On the Gemini page, a thumbnail chip appears above the textbox
  showing the `character-main.png` filename.

Failure modes:
- "Gemini upload control not found." — Gemini mounted a different
  selector. Run `Probe attachment` and inspect the Debug card.
- "Gemini did not acknowledge the attachment within the timeout." —
  check whether the chip text contains the filename; if not, the
  MutationObserver is looking at the wrong subtree.
- File ends up in `application/pdf` mode despite being `.png` — MIME
  detection failed; inspect `assets.js.isSupportedImage`.

---

## Test C — Prepare Task

**Goal**: verify the orchestrator can prepare a task end-to-end **without
sending**.

1. Continue from Test A.
2. Click **Prepare Task**.
3. Watch the workflow phase indicator.

Expected sequence:
```
idle
  -> preparing-image-mode
  -> preparing-attachments
       - logs: "Attaching Yuki (character-main.png)..."
              "✓ Yuki attached"
              "Attaching Snow village (environment-village.jpg)..."
              "✓ Snow village attached"
              "Attaching Master visual style (style-master.jpg)..."
              "✓ Master visual style attached"
  -> preparing-prompt
  -> ready
```

Status line: `Prepared task "Opening shot". Review and click Generate Task when ready.`

On the Gemini page, **three thumbnail chips** appear above the textbox
(in the declared order), and the textbox contains the prompt text. **No
message is sent.**

Failure modes:
- "Composer is not clean" — there were leftover attachments/text from
  a previous run. Open the Gemini composer and clear it manually, or
  accept the confirm dialog.
- Stuck at `preparing-image-mode` — Gemini rejected activating Create
  Image; inspect with the side panel's Debug card.
- "Reference 'X' could not be attached: Missing" — the file isn't on
  disk in the bound folder; recheck the path.
- "Preparation failed: 2 / 3 references attached" — the third
  reference's attachment failed; the workflow halted. Inspect the log
  for the third error.

---

## Test D — Generate Task

**Goal**: the full end-to-end flow up to a downloaded file.

1. Continue from Test C (must end at `ready`).
2. Click **Generate Task**.
3. Watch the workflow phase indicator.

Expected sequence:
```
ready
  -> preflight              (re-checks composer state)
  -> sending                (clicks Send exactly once)
  -> waiting-for-generation (Gemini is generating the image)
  -> downloading            (chrome.downloads starts the file)
  -> complete
```

Status line on success:
`Generated Opening shot. Downloaded scene-001.png.`

Filesystem:
- `~/Downloads/Gemini Assistant/yuki-video-001/scene-001.png` exists
  (filename may include `(1)`, `(2)` if there were previous attempts).
- The Side Panel's task status for `scene-001` is now `generated`.
- The Side Panel shows two new buttons: **Mark Approved**, **Mark
  Redo**.

If you Mark Redo and click Generate Task again, the new file should be
`scene-001 (1).png` (Chrome's uniquify behavior).

Failure modes:
- "Send button is disabled." — Gemini re-validated and rejected (e.g.
  one of the attachments disappeared); rerun Probe.
- "Generation timed out" — Gemini took >90 seconds. Click Generate
  again. (We will add a higher timeout in a later milestone if needed.)
- "Multiple generated images detected. Manual selection required." —
  Gemini returned N≥2 images for one prompt. Download manually.
- "Could not resolve downloadable source." — Gemini's CDN URL didn't
  respond; retry, or click Generate Task again.

---

## Sanity checks (always run after any of the above)

1. **Cancel button**: mid-operation, the **Cancel** button is visible.
   Clicking it stops local polling within ~500ms. Note: a generation
   *already sent* to Gemini cannot be cancelled.
2. **Operation lock**: while busy, **Next/Previous/Rebind** are
   disabled. You cannot navigate tasks mid-generation.
3. **State persistence**: refresh the side panel while a task is at
   `generated`. The status persists, but the in-memory orchestrator
   is reset to `idle` — that's expected. Re-clicking Generate will go
   through Prepare again.

---

## What v0.6 does **not** do (by design)

- **No batch / no auto-next.** After success, the side panel does NOT
  advance to scene-002. You click Next yourself.
- **No retries.** If a generation fails, you click Generate again
  manually.
- **No automatic approval.** Status `generated` ≠ `approved`. Review
  the image yourself.
- **No image editing / no watermark handling.** The downloaded file is
  exactly what Gemini produced.
- **No direct write into the project folder.** Files land in
  Downloads/Gemini Assistant/. JingJing (or you) move them later.
