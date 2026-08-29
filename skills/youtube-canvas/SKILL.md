---
name: youtube-canvas
description: Turn long YouTube videos into editable tldraw Offline research canvases with timestamped extracts, summaries, thematic grouping, an interactive player, and room for human notes. Use when the user asks to study, summarize, map, dissect, annotate, or make a spatial canvas/notebook from a YouTube video, talk, interview, lecture, podcast, demo, or conference recording. Also use when they want timestamp-linked spatial notes rather than a linear transcript.
---

# YouTube → tldraw research canvas

Compile a long YouTube video into a spatial, editable `.tldraw` research board.

The canvas is a **research artifact**, not a transcript dump. Select the moments that materially help someone understand or revisit the video.

## Core principles

1. **Preserve provenance.** Every generated extract must retain an exact YouTube timestamp link.
2. **Prefer information density over coverage.** Do not create one card every N minutes.
3. **Keep the board navigable.** Use thematic grouping, compact text cards, whitespace, and the interactive player.
4. **Keep generated content replaceable.** The renderer tags generated shapes. Re-rendering removes only generated shapes for this video; human notes, arrows, drawings, and unrelated canvas content survive.
5. **Use a small intermediate representation.** Analysis lives in `analysis.json`; canvas layout is deterministic.
6. **Do not hand-edit `.tldraw` files.** Drive tldraw Offline through its local Canvas API.
7. **Keep the source watchable.** Local canvases include a fixed, movable, resizable, collapsible video player; timestamp buttons seek that player while separate links preserve the YouTube fallback.

## Requirements

- `python3`
- `yt-dlp`
- tldraw Offline **v1.12+**, running locally
- Recommended: in tldraw Offline, run **Develop → Install Agent Skills** once so the host agent also has tldraw's version-matched canvas instructions.

At the start of the workflow, resolve `SKILL_DIR` to the directory containing this `SKILL.md` if the host has not already provided it. Do not assume the current working directory is the skill directory.

Run the doctor before first use:

```bash
python3 "$SKILL_DIR/scripts/tldraw_api.py" doctor
```

## Workflow

### 1. Prepare the video

Use a temporary/work directory outside the user's repository unless they explicitly request otherwise.

```bash
python3 "$SKILL_DIR/scripts/youtube.py" prepare \
  "<youtube-url>" \
  --out "<workdir>" \
  --language en \
  --chunk-minutes 12
```

This writes:

- `manifest.json` — video metadata and source URL
- `transcript.json` — normalized timestamped cues
- `transcript.md` — readable timestamped transcript
- `chunks/*.md` — bounded transcript chunks for analysis

If subtitles are unavailable, explain that this MVP needs YouTube captions. Do not fabricate a transcript. You may use an available local transcription tool if the environment already has one, then create the same `transcript.json` shape.

### 2. Analyze the video into `analysis.json`

Read `references/analysis-guide.md` and `references/analysis.schema.json`.

Analyze **all** transcript chunks. For very long videos, summarize each chunk first, then consolidate. Do not infer the whole video from only the first chunk.

Write `<workdir>/analysis.json`.

Validate it:

```bash
python3 "$SKILL_DIR/scripts/validate_analysis.py" \
  "<workdir>/analysis.json" \
  --manifest "<workdir>/manifest.json"
```

Default research target:

- 8–20 segments for a 45–150 minute video
- 2–6 thematic clusters
- 5–12 key ideas

For `watch` mode, increase segment density and reduce prose. For `research` mode, favor synthesis and thematic grouping.

### 3. Render the canvas

Create a new tldraw Offline document by default:

```bash
python3 "$SKILL_DIR/scripts/render_canvas.py" \
  --workdir "<workdir>" \
  --analysis "<workdir>/analysis.json" \
  --new \
  --name "<short descriptive title>"
```

To intentionally render into the currently focused document instead:

```bash
python3 "$SKILL_DIR/scripts/render_canvas.py" \
  --workdir "<workdir>" \
  --analysis "<workdir>/analysis.json" \
  --focused
```

Never silently fall back from `--new` to an existing focused document.

The board should contain:

- compact source/title area with a YouTube link
- concise overall summary
- key ideas
- thematic cluster columns
- timestamp-linked segment cards
- a fixed video player that remains visible while panning and zooming, moves by dragging its header, resizes from the **↔** header control, and collapses to **Watch**
- timestamp buttons that seek the fixed player, plus separate YouTube deep links
- enough whitespace for human notes and arrows

The renderer installs its managed board script into local documents. If an existing document already has an unrelated board script, it preserves that script and degrades to YouTube deep links rather than overwriting user behavior.

### 4. Verify

After rendering:

```bash
python3 "$SKILL_DIR/scripts/tldraw_api.py" screenshot --doc-id "<doc-id>"
```

Inspect the screenshot if the host supports image inspection. At minimum verify via Canvas API that generated shapes exist.

Check:

- no obvious overlap
- readable text at a normal zoom
- timestamp links are present
- clicking a timestamp button seeks and opens the fixed player at that segment
- dragging the player header moves it within the window and dragging the **↔** header control resizes it
- collapsing the player leaves a small **Watch** control
- 2–6 clusters, not a 30-column mess
- user-authored shapes and unrelated board scripts remain after a re-render

If layout is poor, change `analysis.json` grouping or renderer parameters and re-render. Do not manually patch dozens of coordinates.

## Re-render semantics

Generated shapes include metadata like:

```json
{
  "youtubeCanvas": {
    "generated": true,
    "videoId": "...",
    "kind": "segment"
  }
}
```

On re-render, remove only generated shapes/assets whose `videoId` matches the current source.

Never delete shapes without this marker.

## Analysis quality bar

A good segment answers: **why would I ever want to jump back to this exact moment?**

Keep segments for:

- a new claim or conceptual shift
- an architecture or mechanism explanation
- an important example
- a useful demo/code moment
- a surprising caveat or failure mode
- a diagram/slide that compresses lots of information
- a conclusion that changes how earlier material should be interpreted

Usually discard:

- greetings/sponsor reads
- repeated framing
- anecdotes that add no explanatory value
- long stretches whose only value is already captured by a neighboring segment
- generic talking-head filler

## Timestamp rules

- `start` and `end` are seconds from video start.
- Deep links use the exact `start` second.
- Use an interval when the idea spans time; do not pretend everything is a single instant.

## Failure handling

- Missing `yt-dlp`: tell the user `brew install yt-dlp` on macOS.
- tldraw API unavailable: ask them to open tldraw Offline; do not edit `.tldraw` directly.
- No captions: state that transcript extraction failed and use an already-installed local transcription option if available.
- Canvas API schema mismatch: read `http://localhost:<port>/readme` through `tldraw_api.py readme`, adapt to the running app, and keep changes localized to the bridge/renderer.
- Existing unrelated board script: preserve it, report that the fixed player was not installed, and keep the timestamp deep links functional.

## User-facing completion

When done, report:

- canvas file path / document name
- number of clusters and segments
- any degraded behavior (for example: no captions or no interactive player)

Do not paste the entire transcript or analysis into chat unless requested.
