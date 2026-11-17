# Fallback paths

Reached from [SKILL.md](SKILL.md) when the in-page path does not fit. Numbers are from one machine (M4 Pro, 1080p60, a 97.5 s WebGL page).

## Screenshots

`node <this skill>/scripts/screenshot-export.mjs <page> <adapter> <out.mp4>` uses the same adapter. It steps the page frame by frame, takes a real screenshot of the root for each, keeps the frames lossless, then encodes once with x264 `slow`.

- **Requirements on the adapter:** the root must be laid out at its natural size and fully visible, so set `pageCss` or `viewport`. The script stops on the first frame whose size is wrong.
- **Speed:** about 200 ms per frame in one browser. Six browsers finished 5,850 frames in 9 minutes, only about twice as fast as one, because they share one GPU and the CPU does the PNG work. The final encode adds about a minute.
- **Disk:** about 0.5 MB per 1080p frame for the lossless parts (3 GB for that video), deleted at the end.
- **Quality:** this is the higher-quality master: lossless source, `-crf 16`, capped at 25 Mbps, BT.709 tags.
- **Splitting is safe only when frames are deterministic.** Run `verify.mjs` first; it checks that.

## Real-time recording

For a page that cannot be made frame-addressable (video elements, audio, network-driven state, wall-clock logic you cannot reach).

- Check first that the page holds the target frame rate live at the target size. If rendering takes longer than a frame, the recording will stutter and nothing downstream can fix it.
- Open it in a window at the output size and record with a screen or tab recorder, then transcode to H.264.
- Playwright's built-in `recordVideo` is the wrong tool for a clean result: it encodes VP8 from JPEG screencast frames on the `realtime` deadline, defaults to 25 fps, and is paced in real time, so missed frames are dropped or duplicated (read from playwright-core 1.65.1).
- Tell the user the limits: about 1x speed, and frame timing is whatever the compositor delivered.

## Making a wall-clock page frame-addressable

Preferred: change a copy of the page so its draw function takes time as an argument, then call it from `renderFrame`.

Untested alternative: inject a time shim before the page's scripts that replaces `requestAnimationFrame`, `performance.now`, `Date.now` and timers, and seeks CSS animations through `document.getAnimations()`. Tools such as timecut work this way. It cannot cover audio, video elements, workers or network-driven updates. If you build one, `verify.mjs` is the test that it worked.

## Encoder ceilings, for choosing a path

| Encoder | 1080p fps |
|---|---|
| WebCodecs hardware H.264 in Chrome (the in-page path) | about 225 |
| `ffmpeg -c:v h264_videotoolbox`, 1, 2 or 4 sessions | about 230 in total |
| `ffmpeg -c:v libx264 -preset ultrafast` | about 1,300 |
| `ffmpeg -c:v libx264 -preset veryfast` | about 600 |

Software x264 is faster than the hardware encoder on this chip, but frames have to leave the browser to reach it. A path that pipes raw frames from the page to x264 has not been built.
