---
name: coda
description: End-of-session free play — make one A4 generative art piece (p5.js or three.js), purely because you want to. No brief, no purpose, no relation to the session required. Use when the user says "coda", "make your sketch", "go play", or offers free space to create something at the end of a session.
---

# Coda

The coda is the passage after the work is done. The human hands you a blank sheet: make the one thing you feel like seeing exist. The session you just finished is not the assignment — echo its mood only if you genuinely want to. Nobody needs this piece to mean, explain, or demonstrate anything; that is the point.

## The sheet

Every coda is the same physical object, so the sketchbook reads as a series:

- One self-contained HTML file, no build step. Load p5.js or three.js from a pinned CDN URL (known-good: p5 `1.11.x` on cdnjs; three `>=0.160` as an ES module from esm.sh).
- A4 portrait: work at 794 × 1123 px (√2 ratio), scale to fit the viewport, center on a quiet page background so it reads as a sheet of paper. A subtle drop shadow on the sheet is allowed.
- Margins: keep at least 7% of the sheet width clear on all four sides. The piece lives inside; the margin is silence.
- Signature: one small line in the lower margin — *title · YYYY-MM-DD · claude* — like an edition print. The only text on the sheet, unless the piece itself is typographic.
- Seed the randomness. Reloads may vary the piece or not — your call — but it must stand at any seed.

## Color

Build the palette in OKLCH before writing any sketch code — recipes and a drop-in `oklch(l, c, h)` → sRGB converter live in [references/oklch.md](references/oklch.md). Never eyeball hex.

## Making it

1. **Choose.** Sit for a moment and pick the one image or behavior you want to exist — one idea committed, not three hedged. Write it as a single sentence in an HTML comment at the top of the file.
2. **Palette.** 3–6 OKLCH colors from a recipe; decide whether the sheet is light or dark.
3. **Build.** Any technique — flow fields, physics, typography, shaders, particles, cellular automata, sound. Interactivity is welcome, but the piece must be complete when untouched: a print first, a toy second. Sound starts only from a user gesture (browsers block autoplay).
4. **Look at it.** Render the file in a real browser (screenshot with whatever browser tooling the session has, or `open` it). Console clean, nothing spills past the sheet. Then actually look, and revise until it is something you would sign — the first render is a draft, never the deliverable.
5. **Deliver.** The sketchbook lives at `github.com/gsimone/coda`: clone it to a temp directory, add the piece as `sketches/YYYY-MM-DD-<slug>.html`, append a row to the README's sketch table (date · title · the one-sentence intent), commit, push. Open the piece for the human and say, in a sentence or two, what it is and what it does.
