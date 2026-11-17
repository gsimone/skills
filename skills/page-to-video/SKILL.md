---
name: page-to-video
description: Export a web page, HTML animation or WebGL canvas to an MP4, frame-exact and faster than real time. Use when asked to encode, record, render or export a page or artifact as video.
---

# Page to video

Turns a **frame-addressable** page into an MP4. A page is frame-addressable when one synchronous call draws frame `n` and the picture depends only on `n`. Everything here follows from that contract: frames can be rendered in any order, faster than real time, and checked for exactness.

## Pick the path

| Path | Use when | Speed at 1080p60 (M4 Pro) |
|---|---|---|
| **In-page** (`scripts/export.mjs`) | Default. Chrome 157+. | about 200 fps, bounded by the hardware encoder |
| **Screenshots** (`scripts/screenshot-export.mjs`) | Older Chrome, or `verify` fails and the page cannot be adjusted. Also when you want an x264 quality master. | about 5 fps per browser |
| **Real-time recording** | The page cannot be made frame-addressable. | 1x, frames not guaranteed |

Screenshots and real-time recording: [FALLBACKS.md](FALLBACKS.md).

## Steps

1. **Make the page frame-addressable.** Read its script and find: the element that is the video frame (the *root*), the clock and the `requestAnimationFrame` loop that advances it, the WebGL canvas if there is one, and the duration. Then decide how frame `n` gets drawn: usually stop the loop and call the page's own seek or render function with `n / fps`. Patch a copy of the page when it needs changes (a render-scale switch so the WebGL canvas is drawn at output resolution, a draw function that takes time as an argument). Done when you can write `renderFrame(n)` and the frame count.
2. **Write the adapter.** Copy [adapter.template.mjs](adapter.template.mjs) next to the page and fill it in; the template documents every field.
3. **Install the driver's one dependency** in the directory you will run from: `npm i playwright-core`. The scripts use the installed Google Chrome and `ffmpeg`.
4. **Verify.** `node <this skill>/scripts/verify.mjs <page> <adapter> [frame ...]`. Name frames that show each kind of content the video has: plain WebGL, text, SVG, each 2D canvas panel, a fade. Done when it prints `PASS`. On `FAIL`, use the table below; every fix is in the adapter or the page copy.
5. **Export.** `node <this skill>/scripts/export.mjs <page> <adapter> <out.mp4>` (`--help` lists the flags; `--silent-audio` for upload targets that want an audio track). Done when the printed frame count equals the page's, `ffprobe` reports the same `nb_frames`, and you have looked at a contact sheet of at least four frames spread across the video.
6. **Report** the wall time, where the file is, and that the video is hardware-encoded: at the same bitrate it is somewhat below x264 `slow`. If the user needs the best master, re-run with the screenshot path.

## When verify fails

| Symptom | Cause | Fix |
|---|---|---|
| `NOT DETERMINISTIC` | `renderFrame` depends on history: accumulated `dt`, a physics step, a feedback buffer, a random seed | Make the state a function of `n` (integrate from frame 0, seed by frame) |
| Screenshot is the wrong size | The root is scaled or clipped by the page layout | Set `pageCss` or `viewport` in the adapter so the root sits at its natural size |
| A 2D canvas panel is shifted or clipped | Chrome 157 drops a nested canvas's own offsets in the snapshot. `inpage-export.js` repairs left/top and border; padding or percentage offsets are not covered | Extend `fixCanvases`, or position that canvas with a transform |
| WebGL area black or missing | Wrong `gl` selector, or the canvas does not fill the root | Fix the selector; the WebGL canvas must cover the root and sit below everything else in it |
| WebGL looks soft | Canvas backing store is smaller than the output (the driver warns) | Render it at output size in the page copy |
| Colours differ only where WebGL is translucent | The page shows something behind the root | Set `backdrop` in the adapter to that colour |
| 55–60 dB on frames with bordered canvases | The border workaround | Expected; leave it |
| Whole frame around 10–15 dB | A layer is missing or covers the others | Open `ref_N.png` and `exp_N.png` from `--keep` and compare |

## How the in-page path works

Read this before changing `scripts/inpage-export.js`; each line is a measured finding.

- **Snapshot API.** The root is re-parented into `<canvas content="drawable">` and marked `drawable`; `ctx.drawElementImage(root, …)` draws it. These names changed across Chrome versions before 157, so the driver feature-detects and exits with code 3 when the API is absent.
- **Wait for `paint`.** After `renderFrame(n)`, call `canvas.requestPaint()` and draw inside the `paint` event. Drawing sooner returns the previous frame's DOM. With the wait, frames are exact.
- **WebGL stays out of the snapshot.** The WebGL canvas is hidden from the snapshot and copied with `drawImage`. With WebGL inside the snapshot, capture adds about 4 ms to every frame; outside, about 1 ms. Output order: backdrop, root background, WebGL, the rest of the root.
- **Uncapped paint cycle.** `--disable-frame-rate-limit --disable-gpu-vsync` let Chrome paint faster than the display. Without them the loop is locked to the refresh rate, which is real time.
- **Real GPU in headless.** `--use-angle=metal` on macOS; the driver prints the WebGL renderer and warns on a software one. Linux and Windows flags are untested.
- **Encoder.** WebCodecs H.264 High level 4.2 (`avc1.64002A`), Annex B, hardware. Back-pressure waits on the encoder's `dequeue` event, because nested timers are clamped to 4 ms. The hardware encoder is the ceiling (about 225 fps at 1080p on an M4 Pro) and parallel sessions add nothing on a single-engine chip.
- **Getting the file out.** The stream leaves the page as base64 slices over the DevTools connection, then `ffmpeg -c copy` wraps it as MP4 with timestamps rebuilt from the frame index.

## When it is slower than expected

Time the page alone: in the page, call `renderFrame(n)` in a loop and force the GPU to finish each frame with a 1-pixel `gl.readPixels`. If that rate is close to the export rate, the page's own drawing is the limit. That work is on one GPU, so more browsers will not help; the page's rendering has to get cheaper.

Verified on Chrome 157, macOS, M4 Pro: a WebGL page with DOM, SVG and 2D-canvas overlays (1080p60, 5,850 frames in 29 s) and a DOM-only page.
