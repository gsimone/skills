---
name: contact-sheet
description: Turn a screen recording or any video into analyzable visual-change data — unique frames, per-frame difference timeline, and a tiled contact sheet. Use when asked to analyze a video for layout shifts, layout thrashing, flashes, reload behavior, animation timing, or "what visually happens when" in a recording.
---

# Contact sheet — video visual-change harness

One command turns a video into data an agent can actually read:

```bash
python3 ~/.agents/skills/contact-sheet/scripts/contact_sheet.py <video.mp4> [-o outdir]
```

Requires `ffmpeg`/`ffprobe` on PATH; python stdlib only, no ImageMagick.

## Default agent workflow

Read static artifacts first; the HTML is optional:

1. Read `report.md`. Use its consecutive-state table to find suspicious
   timestamps, especially `NO VISIBLE CHANGE`, `TINY CHANGE`, unexpectedly
   small changes, or large bounding boxes.
2. Open `diff-contact-sheet.png`. It is a chronological overview of the
   highlighted third panel from every captured state transition.
3. Open a matching `diffs/S###-to-S###_...png` for a full-size triptych:
   **previous state | current state | highlighted diff**. Headers include both
   state numbers and timestamps. Green means a pixel's largest RGB-channel
   delta exceeded `--diff-pixel-threshold`; the display mask grows one pixel
   around it for visibility. Tiny changes also get a yellow locating box.
4. Open the clean PNGs named in `report.md` only when the triptych needs closer
   visual confirmation. Use `timeline.svg`/`diff.csv` for exact timing.

`NO VISIBLE CHANGE` is meaningful: the captured before/after images match at
the configured pixel threshold even though a detected burst, keyboard action,
history transition, or invisible DOM/editor state change may have occurred.
`TINY CHANGE` means fewer than 0.05% of extracted pixels changed; inspect the
green pixels/yellow box for caret movement, ZWSP rendering, one-pixel flicker,
or small layout shifts.

## What it produces (in `<video-stem>-contact-sheet/`)

| File | What it is | Read it when |
|---|---|---|
| `report.md` | Bursts + states with timestamps and hold durations | **Always start here** |
| `diff-contact-sheet.png` | Every consecutive-state highlight tiled chronologically | **Scan second** |
| `diffs/S###-to-S###_...png` | Labeled previous/current/highlight triptych | Inspecting one subtle/no-op-looking transition |
| `transitions.csv` | Changed-pixel %, mean RGB delta, status, bounding box, artifact path | Sorting/scripting transition metrics |
| `contact-sheet.png` | Every captured state tiled, timestamp burned in | Getting the visual gestalt |
| `frames/NNNNN_tXX.XXXs.png` | Individual state frames (clean, no label) | Zooming into one transition |
| `timeline.svg` | Diff-over-time chart: line + burst spans + state ticks | Judging rhythm/cadence |
| `diff.csv` | frame, pts_time, YDIF per frame | Custom analysis |
| `meta.json` | All of the above, machine-readable | Scripting |
| `visualizer.html` | Optional scrub/diff UI — see below | Interactive human inspection |

## The visualizer

`visualizer.html` is self-contained (frames embedded as data URIs up to 25MB
total, past that it falls back to `frames/` paths and needs
`python3 -m http.server` for diff mode) — open it in any browser, or point the
user at it as the proof artifact for before/after comparisons.

- **Timeline scrubbing**: the strip shows the frame-difference sparkline, burst
  spans, and an orange accent tick per captured state. Click or drag to scrub;
  `←`/`→` step states; the white playhead tracks the current state.
- **Diff mode** (`D` or the Diff button): paints every changed pixel bright
  green (flashing — `F` toggles) over the dimmed frame, with a %-of-pixels
  readout. Compare against the previous state, the first state, or pin any
  state as the reference (`P`) — pinning is how you show "nothing moved after
  X" or compare the same phase across two reloads. The sensitivity slider sets
  the per-channel threshold.

## How it works

1. Per-frame **YDIF** (mean absolute luma delta vs previous frame, 0–255) via
   `signalstats` on a downscaled stream. Near-0 = static screen; screen
   recordings are mostly 0 with spikes on change.
2. An auto **threshold** (5× median nonzero YDIF, floor 0.2) splits signal from
   compression noise. Override with `--threshold` if the auto pick misreads —
   check the printed median and `timeline.svg`.
3. Above-threshold frames group into **change bursts** (lulls under `--gap`
   seconds don't split one). Each burst's settled aftermath (+`--settle` frames)
   is captured as a **visual state** — the unique frames.
4. States render as individual PNGs and one tiled sheet. Caps at `--max-frames`
   (48), dropping the *smallest* bursts — never silently; the report says how many.
5. Every pair of consecutive captured states is compared at `--thumb-width`
   resolution. The default static RGB threshold is 24/255. The script records
   changed-pixel percentage, mean absolute RGB delta, maximum channel delta,
   and changed-pixel bounding box, then renders a labeled triptych and tiled
   static diff overview.

The default is bounded to 48 states and therefore at most 47 transition
triptychs. Raising `--max-frames` explicitly raises both bounds. The report and
`meta.json` record the configured caps and how many lower-signal bursts were
dropped before state-to-state comparison. A video with only one captured state
has no state pair to compare, so the report explains that no static diff sheet
was generated.

## Reading it for layout thrashing / reloads

- A **reload signature** is a burst cluster: big spike (blank/navigation) →
  skeleton state → several medium bursts as content pops in → calm. Count the
  states between navigation and calm — that's how many distinct layouts the
  user was shown.
- **Thrash** = states that are *held* only tens of ms before the next burst
  replaces them (see "held for" in report.md), or repeated late bursts after
  the page looked settled. Start with the matching static triptych to name
  exactly what moved.
- A long tail of small, regular bursts after settle = an animation or polling
  repaint loop, not thrash — check the cadence in `timeline.svg`.
- Multiple reloads in one recording show as repeating burst clusters; compare
  the same-phase state across reloads to check consistency.

## Tuning

- Diffs look noisy / bursts merge together → raise `--threshold` or `--gap`.
- Subtle shifts missed (small text reflow) → lower `--threshold`, or crop first:
  `ffmpeg -i in.mp4 -vf crop=w:h:x:y region.mp4` and analyze the region.
- Static green highlights are noisy → raise `--diff-pixel-threshold` (default
  24). Small anti-aliased/caret changes are absent → lower it. This threshold
  changes static state comparisons, not burst detection.
- Very long videos → raise `--max-frames`; the sheet tiles whatever count you allow.
- 120fps recordings work as-is; YDIF is per decoded frame, timestamps are true pts.
