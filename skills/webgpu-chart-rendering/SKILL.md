---
name: "webgpu-chart-rendering"
description: "Build fast, polished interactive charts on WebGPU with TypeGPU: SDF lines, cached scene plus overlay, culling, styling, multi-chart, and how to measure and verify performance."
---

# WebGPU chart rendering with TypeGPU

A recipe for line/area charts (usage, spend, metrics, forecasts) drawn with a few TypeGPU shaders instead of SVG or Canvas2D. Distilled from building a workspace-usage chart: cumulative spend line, area fill, a straight forecast segment with hatching, a dashed limit, glowing dots, a hover cursor, zoom and pan.

## Decide first: is the GPU worth it?

SVG or Canvas2D already draws a few thousand points in well under a frame. The GPU path pays off when at least one of these is true:

- interaction at display refresh rate (zoom, pan, scrubbing, hover crosshair) over dense data;
- many charts on one page;
- effects that are expensive in SVG/CSS (glows, hatching, gradients, soft edges);
- very large or streaming datasets.

It costs: async device setup and shader compile before first paint, a fallback for browsers without WebGPU, device-loss handling, and accessibility work (a canvas exposes nothing to screen readers). If none of the bullets apply, use SVG.

**Keep text in the DOM.** Headline numbers, legends, labels, links and tooltips need selection, accessibility, localization and tabular numerals. Position DOM labels with the same transform the shader uses. GPU text (MSDF/Slug, e.g. pmndrs/text) is only worth it for large numbers of labels that move every frame.

## Architecture (the part that matters)

Performance comes from not drawing, not from clever shading. The frame is split by how often things change:

| Layer | What | When it runs |
|---|---|---|
| Data prep | build the visible polyline for the current view | only when view or data changes |
| Pass A | line coverage: one capsule per segment into an `rgba16float` texture, blend op `max` | only on a real change |
| Pass B | the static scene as ONE full-canvas quad into a cached texture: background, fill, hatch, grid, limit, markers, line (sampled from pass A), forecast segment | only on a real change |
| Overlay | copy cache to canvas, then composite the cursor and dots (pulses, glows) as a few small quads | only when something moves |
| Idle | nothing: no GPU work, no present | every other frame |

Rules:

1. **Re-render only on a real change**: view, data, y-range, size, DPR, theme, or a style setting. Build a key from everything the scene depends on and compare.
2. **Anything that moves every frame goes on the overlay**, never into the scene: cursor, hover dot, pulsing or glowing dots, any time-based animation.
3. **WebGPU does not preserve canvas contents between frames.** Every presented frame must copy the cache in, so present only when the overlay changes. With nothing animating, skip the frame entirely.
4. **Cull overlay quads by their full extent** (dot plus glow or pulse ring) in the vertex shader, so off-screen glow costs nothing. A dot panned just outside the plot keeps the part of its glow that reaches into the plot (multiply by a plot x-clip), so it fades out instead of popping.
5. **Tiling / dirty rectangles are not needed** once the overlay exists. Don't add them back unless profiling shows full re-renders on hot paths.

### Why these techniques

- **Capsules + `max` blending = exact line union.** Coverage only grows as distance to a segment shrinks, so the max over overlapping capsules equals the coverage of the nearest segment. No neighbour search, no double-blended joins, round joins for free. A line glow goes in another channel the same way.
- **One scene quad, analytic everything.** Area fill is "pixel is below curve(t)"; hatch is `fract((x + y) / spacing)`; dashed lines are `mod` on x; the nearest grid rule is one `round()`, not a loop over rules.
- **The forecast is one segment.** A straight line is one `sdSegment` call in the scene shader (or one instance). Never split it.
- **Clip segments in data space before converting to pixels.** At deep zoom, a segment spanning days becomes a 10^7-px coordinate and loses f32 precision.
- **Make time relative to the view's left edge** before upload (and split large indices into an integer base plus a small f32 fraction), so f32 stays exact at any zoom.
- **Finding the segment under a pixel must be O(1).** If the polyline has a known layout (4 points per pixel column for min/max decimation, or a fixed time grid), compute the first guess from a formula, then step once or twice. A per-column lookup table works too. Never binary-search per pixel.

## Core shader snippets (WGSL bodies inside TypeGPU shells)

```wgsl
// distance from p to segment ab
fn sdSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a; let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
// rotated quad around a capsule: c is the quad corner in [-1,1]^2
fn capsuleCorner(a: vec2f, b: vec2f, r: f32, c: vec2f) -> vec2f {
  let ab = b - a; let len = length(ab);
  var dir = vec2f(1.0, 0.0); if (len > 1e-4) { dir = ab / len; }
  let n = vec2f(-dir.y, dir.x);
  return (a + b) * 0.5 + dir * (c.x * (len * 0.5 + r)) + n * (c.y * r);
}
// signed distance (px, + inside) -> coverage, ~1px antialiased edge
fn cover(sd: f32) -> f32 { return clamp(sd + 0.5, 0.0, 1.0); }
```

Capsule radius = half line width + 1.5 px for AA (+ glow reach when glow is on). Pass A fragment writes `vec4f(lineCoverage, glow, 0, 0)` into the `max`-blended target.

Area fill edge: vertical distance to the curve is wrong on steep slopes (the edge thins out). Near the edge (|vertical distance| < a few px) use the exact distance to the nearby segments, signed by side. Elsewhere vertical distance is fine.

Dots: a disc and ring from one circle SDF; glow is `exp(-pow(x, falloff))` of distance beyond the ring. No blur pass.

## TypeGPU notes (0.12.x)

- Pin the version and bundle into a single page (esbuild IIFE) if it must run as a self-contained artifact.
- Raw-WGSL style: `tgpu.fn([d.vec2f], d.f32)\`(p: vec2f) -> f32 { ... }\`.$uses({ u, pts }). Entry points: tgpu.vertexFn({ in, out }) / fragmentFn / computeFn({ in, workgroupSize }), with bodies using in.x and var o: Out;`.
- Identifiers in a WGSL body that match a `$uses` key get substituted. Don't name locals after externals.
- "external-omitted" console warnings for `in.*` are harmless.
- Resources: `root.createUniform(Struct)`, `root.createReadonly(...)`, `root.createMutable(...)`, `buffer.as('readonly' | 'mutable')` for one buffer in two roles, `root['~unstable'].createTexture({...}).$usage('sampled', 'render')`, `tex.createView(d.texture2d(d.f32))`.
- Compile-time variants: `const AA = tgpu.slot(0)`, used in WGSL as `if (AA == 1) {...}`, specialised with `root.with(AA, 1).createRenderPipeline(...)`. Each combination is its own pipeline with dead branches removed. Use slots for debug views and AA modes, uniforms for continuous style values.
- Compile asynchronously with `pipeline.initAsync()`, keep drawing the old variant until the new one is ready, and time it.
- Mixing with raw WebGPU: `pipeline.with(passEncoder).draw(...)` lets several TypeGPU pipelines share one render pass you begin yourself (needed for timestamps, scissor, custom attachments).

## Styling: what good looks like

- **Colours come from CSS tokens.** Read `--chart-bg`, `--chart-ink`, series colours with `getComputedStyle`, upload as uniforms, re-read and re-render on `prefers-color-scheme` change and on `data-theme` mutation. Design light and dark, not an inversion.
- **Size everything in CSS px × DPR.** Line width, AA width, dash lengths, hatch spacing, dot radii and glow radii are all `cssPx * dpr`.
- **Starting values that read well:**
  - line 2–2.5 css px;
  - area fill opacity ~0.15 at the line, falling off with `pow(k, 3)` toward the baseline, plus a faint 0.03 floor;
  - grid rules at ~8% ink;
  - limit line dashed (4 on / 3 off) at ~35% ink;
  - hatch 6 px spacing at ~11%, slightly stronger above the limit;
  - dot radius ~4.75 px with a 1.6 px ring;
  - end-point glow radius ~13 px at 0.5 intensity, pulse depth ~0.18.
- **One focal glow.** Glow the point the reader should look at (forecast end, limit crossing), not everything.
- **An optional small gap** between line and fill (measured from the line's edge using exact distance) reads cleaner on dark backgrounds.
- **Analytic AA by default.** It's exact for SDFs and cheap. Derivative-based (`fwidth`) AA is a fallback for fields with no closed-form distance. MSAA costs ~4× shading for no visible gain on SDF content. If you use derivatives inside branches, compute the fields in uniform control flow first, or wrap them in `@diagnostic(off, derivative_uniformity)` only when the branch is uniform per primitive.
- **Respect `prefers-reduced-motion`**: no pulse or ring animation, no eased transitions. That also makes the chart fully idle.
- **Motion:** ease zoom in log-span so it feels uniform; ease the y-range separately; a short reveal on first load is fine, never a loop.
- **Debug views worth keeping:**
  - wireframe: quad edges plus triangle diagonal from interpolated quad-local UVs and `fwidth`;
  - overdraw heatmap: additive fragment count;
  - a "last frame: full / overlay / idle" readout.

### Done checklist

- [ ] Idle page shows "idle": zero GPU submissions with the mouse still and no animation on screen.
- [ ] Hover produces overlay-only frames, and an overlay frame is pixel-identical to a full re-render of the same state.
- [ ] Line joins are seamless at any zoom; no darker overlaps (check the overdraw view).
- [ ] Fill edge stays even on steep slopes; the gap stays even around corners.
- [ ] Deep zoom (minutes over a month of data) shows no jitter or precision steps.
- [ ] Correct in light and dark, at 1× and 2–3× DPR, and at phone width.
- [ ] A 0×0 canvas at startup (hidden tab, layout not done) doesn't throw.
- [ ] Off-screen dots and glow cost nothing (culled), and edge dots fade instead of popping.
- [ ] No-WebGPU browsers get a clear message or a fallback, and screen readers get a text summary or table.

## Measuring and verifying performance

Measure the right thing:

- **Frame interval (rAF to rAF) is not frame cost.** It's capped by vsync, so a 10 ms reading on a 100 Hz screen means nothing.
- **GPU time** comes from timestamp queries (`optionalFeatures: ['timestamp-query']`). Write the begin index on the first pass and the end index on the last, resolve into a buffer, and map it asynchronously. Sample every Nth frame and keep "full" and "overlay" times separate.
- **A pass with neither index must not get a `timestampWrites` object at all.** An empty one invalidates the whole command buffer, and the chart goes black on exactly the GPUs that support timing.
- **Also report:** CPU time per frame, shader compile time (around `initAsync`), data-prep/decimation time, segment count, and which kind of frame ran (full, overlay or idle).
- **Safari has no timestamps.** Show n/a there rather than a wrong number.

Headless verification (Playwright + Chromium):

- **Flags:** `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-webgpu-adapter=swiftshader`. Add `--enable-dawn-features=allow_unsafe_apis` to expose `timestamp-query`, otherwise your timing code paths never run in tests.
- **Serve over `http://localhost`.** `about:blank` has no `navigator.gpu`.
- **Headless can't present a WebGPU canvas** (screenshots come out blank or white). Add a debug mode (e.g. `#grab`) that renders into an offscreen texture, copies it to a mappable buffer, and returns a PNG (watch for BGRA order).
- **Benchmark without readback:** loop `render()` N times between two `await device.queue.onSubmittedWorkDone()` calls and divide. Compare variants relative to each other only.
- **SwiftShader (software GPU) numbers are not real GPU costs.** It rasterizes so slowly that a flat-colour quad costs the same as the full shader. Use it for correctness and rough A/B comparisons, never for absolute claims. Get real numbers from the on-page GPU stat on actual hardware (desktop and a phone).
- **Pixel-diff tests:** overlay-only frame vs full re-render (expect max diff 0); old vs new renderer for refactors (animated bits will differ, compare the static region).
- **Edge cases to always run:** zero-size canvas at startup, timestamps enabled, dense data (millions of samples) at full view and at deep zoom, each AA mode, wireframe and overdraw, light and dark.

## Rendering multiple series or charts

- **One device, shared pipelines.** Create the TypeGPU root once. Every chart uses the same pipelines; per-chart state lives in its own uniform buffer and bind group (or one buffer with dynamic offsets).
- **Multiple series in one chart:**
  - add a series id to each capsule instance;
  - write coverage for up to 4 series into the RGBA channels of the pass-A target (more via a texture array or a second target);
  - composite them in the scene pass in z-order.

  Fills and hatches stay analytic per series.
- **Several charts on a page:** one canvas per chart is simplest and fine for a handful, but each canvas has its own swap chain and present cost. For dashboards or small multiples, prefer one shared canvas covering the region, with a viewport and scissor per chart, a cache per chart (or one atlas texture), and one overlay pass.
- **Skip work for invisible charts.** Use an `IntersectionObserver`; off-screen or hidden charts don't render, and charts that never animate are idle after their first frame.
- **Small multiples share an x-scale.** Decimate once per x-range when series share timestamps.

## Data (briefly — decide case by case)

Data handling is the least settled part of this recipe and is **not a clear win**. Choose per dataset and per audience:

- **Exact min/max decimation per pixel column** (first, min, max, last; "M4") is visually lossless for line charts. Back it with a CPU min/max pyramid for fast zoom. This is the safe default for numbers people make decisions on (money, quotas, SLAs).
- **Smoothing** (e.g. a zero-phase 1€ filter, then resampling on a fixed time grid every ~2 px) makes curves calmer and cuts segment counts a lot. But it changes what the data says, needs samples on both sides (a live right edge will wobble as data arrives), and has to be tuned. If you use it, make it opt-in or clearly labelled, and show the raw value next to the smoothed one in the hover readout.
- **GPU decimation** (raw samples resident on the GPU, a compute pass per view change, atomics for visible min/max) helps only for very large or streaming data. It adds async readback latency to the y auto-fit and more code. For a few hundred to a few hundred thousand points, CPU decimation is simpler and fast enough.
- **Upload only what the view needs**, with time relative to the view, whatever you choose.

## Future improvements

- **Text:** move axis ticks and the floating value label to GPU text (pmndrs/text MSDF or Slug) once its API is stable, or keep DOM labels driven by the same transform.
- **Specialisation:** try WGSL `override` constants in place of slots if pipeline count grows; measure compile time on real devices (should be tens of ms).
- **Render bundles** for the overlay to cut CPU encode cost on many charts.
- **Incremental updates for streaming data:** append segments to pass A and re-render only the changed x-range of the cache instead of a full re-render.
- **GPU min/max pyramid** built by compute for streaming 10M+ point series.
- **Many series / dense dashboards:** classify screen tiles by which series touch them (compute pass) so the scene shader only evaluates relevant series. Stop there. A full compute rasterizer means you're rebuilding Skia or Vello; use one of those instead.
- **Robustness:** device-loss recovery (recreate root, re-upload, re-render), a Canvas2D fallback that reuses the same decimated polyline, and an accessible data table.
- **Ergonomics:** port WGSL bodies to TypeGPU `'use gpu'` TypeScript with `unplugin-typegpu` for type-checked shaders shared with CPU code.
