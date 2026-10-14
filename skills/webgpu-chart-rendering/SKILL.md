---
name: webgpu-chart-rendering
description: Build or optimize interactive line and area charts with WebGPU and TypeGPU. Covers cached rendering, SDF lines, styling, multiple charts, and performance measurement.
---

# WebGPU chart rendering with TypeGPU

A rendering recipe for charts with zoom, pan, hover, area fills, forecasts, and glows. Choose the parts that fit the chart and the project's existing stack. The architecture, style values, debug tools, and checks below are defaults and options; they do not all need implementing.

## Choosing a renderer

SVG or Canvas2D often handles a few thousand points comfortably. WebGPU becomes useful for dense interactive data, many charts, streaming updates, or effects such as glows and hatching. Weigh those benefits against device setup, shader compilation, browser support, and accessibility work. Keep an existing renderer if it meets the task.

DOM text is a useful default for labels, legends, and tooltips: it supports selection, localization, and accessibility. Position labels with the chart's coordinate transform. GPU text may help when many labels move each frame.

## Cached scene and overlay

For a chart where hover or animation changes more often than the data, separate rendering by update frequency:

| Layer | Content | Update trigger |
| --- | --- | --- |
| Data prep | Visible polyline | View or data changes |
| Pass A | Segment capsules in an `rgba16float` coverage texture, using `max` blending | Geometry or line style changes |
| Pass B | Scene quad: background, fill, hatch, grid, limit, static markers, line coverage, forecast | Scene changes |
| Overlay | Cached scene plus cursor, hover dots, and animated effects | Scene or overlay changes |
| Idle | No submission or present | Nothing changed |

Include view, data, y-range, size, DPR, theme, and style in scene invalidation. A dependency key is one way to track this. Keep moving elements in the overlay so hover and pulses can reuse the scene cache.

WebGPU canvas contents do not persist between presented frames. In this architecture, composite the cached scene into each presented frame before drawing the overlay. Skip presentation while the chart is unchanged.

Cull overlay quads using their full extent, including glow and pulse rings. Clip visible fragments to the plot so a dot just outside the plot can retain the part of its glow that overlaps it. This avoids a sudden disappearance at the boundary and skips off-screen fragment work.

Dirty rectangles or tiling can help if profiling still shows expensive scene redraws; the cache and overlay are a simpler starting point.

## Line and fill geometry

Capsules with `max` blending combine overlapping segment coverage without darkening joins. For a shared radius and a coverage function that decreases with distance, the maximum coverage equals the coverage of the nearest segment. A separate channel can hold line glow.

The scene shader can evaluate fills and decorations directly: compare the pixel with `curve(t)` for the fill, use `fract((x + y) / spacing)` for hatching, a periodic x coordinate for dashes, and `round()` to find the nearest evenly spaced grid rule. A straight forecast usually needs one `sdSeg` call or capsule instance.

Clip segments in data space before converting to pixels. Deep zoom can otherwise produce huge pixel coordinates with poor f32 precision. Upload time relative to the view's left edge; for large sample indices, an integer base plus a small f32 fraction helps retain local precision.

For per-pixel curve lookup, prefer a direct index or per-column lookup table when the data layout supports it. A known layout, such as four points per pixel column or a fixed time grid, can give a first guess followed by a short local search. Profile more general searches if they become a bottleneck.

### WGSL helpers

These bodies can sit inside TypeGPU function shells:

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

For the capsule's bounding quad, start with half the line width plus 1.5 px for antialiasing, extending it for glow if needed. Pass A writes `vec4f(lineCoverage, glow, 0, 0)` into the `max`-blended target.

Vertical distance to the curve produces an uneven fill edge on steep slopes. Near the edge, use distance to nearby segments, signed by which side of the curve the pixel occupies. Vertical distance is sufficient farther inside the fill. The same distance can define an optional gap between line and fill.

A circle SDF can draw a dot and ring. An exponential falloff such as `exp(-pow(x, falloff))` beyond the ring gives a glow without a blur pass.

## TypeGPU integration

These API examples come from TypeGPU 0.12.x. Adapt them to the project's installed version. For a standalone page, a pinned version and an esbuild IIFE bundle are one packaging option.

- Raw WGSL functions can use ``tgpu.fn([d.vec2f], d.f32)`(p: vec2f) -> f32 { ... }`.$uses({ u, pts })``. Entry points use `tgpu.vertexFn({ in, out })`, `fragmentFn`, or `computeFn({ in, workgroupSize })`, with `in.x` and `var o: Out;` in their bodies.
- Identifiers matching a `$uses` key get substituted. Give locals different names from those externals.
- Resource examples include `root.createUniform(Struct)`, `root.createReadonly(...)`, `root.createMutable(...)`, and `buffer.as('readonly' | 'mutable')` for two views of a buffer. Texture examples use `root['~unstable'].createTexture({...}).$usage('sampled', 'render')` and `tex.createView(d.texture2d(d.f32))`.
- Slots can specialize discrete variants: define `const AA = tgpu.slot(0)`, reference `AA` in WGSL, and create a pipeline with `root.with(AA, 1).createRenderPipeline(...)`. Each combination adds a pipeline; uniforms suit continuous style values.
- `pipeline.initAsync()` allows compilation while the old variant remains visible. Time this call when investigating startup or variant-switching delays.
- `pipeline.with(passEncoder).draw(...)` lets TypeGPU pipelines share a raw WebGPU render pass, useful for timestamps, scissor, or custom attachments.

## Styling

Use the project's theme tokens where available. Read colors with `getComputedStyle`, upload them as uniforms, and invalidate the scene when the app changes theme. Match the app's theme mechanism, whether it uses `prefers-color-scheme`, a `data-theme` attribute, or another signal.

Express widths and spacing in CSS pixels, then convert to the shader's pixel units using DPR. These values are starting points for a usage or spend chart:

| Element | Starting value |
| --- | --- |
| Line | 2–2.5 CSS px |
| Fill | About 0.15 opacity near the line, fading with `pow(k, 3)`, plus a 0.03 floor |
| Grid | About 8% ink opacity |
| Limit | 4 px on / 3 px off, about 35% ink |
| Hatch | 6 px spacing, about 11% opacity |
| Dot | 4.75 px radius, 1.6 px ring |
| Focal glow | 13 px radius, 0.5 intensity; optional pulse depth 0.18 |

A glow can draw attention to a forecast end or limit crossing. Tune it against the rest of the page. Check light and dark palettes separately if the product supports both.

Analytic antialiasing is a good default for SDF content. `fwidth` helps with fields that lack a usable distance function. MSAA is another option if it improves the result enough to justify its cost. Compute derivative-dependent fields in uniform control flow; suppressing a diagnostic does not make divergent derivatives reliable.

If adding motion, easing zoom in log-span gives a consistent feel across scales. The y-range can ease independently. Respect reduced-motion preferences by removing decorative pulses and easing.

## Verification

Choose checks that cover the changed behavior and supported environments. A renderer refactor warrants broader comparison than a color adjustment. Debug views, readbacks, and hardware benchmarks are useful when they answer a specific question.

- For cache or overlay changes, compare an overlay-only frame with a full render of the same frozen state. Identical rendering paths should produce a zero pixel diff. Check that an unchanged chart with no animation submits no GPU work.
- For geometry changes, inspect joins, steep fill edges, optional gaps, and dots crossing the plot boundary. Deep zoom helps expose precision loss.
- For layout or theme changes, check the supported palettes, representative DPRs, and narrow layouts. Handle a zero-size canvas while layout is pending.
- For browser support, provide an appropriate fallback or clear unsupported message. A text summary or data table makes the chart's information available outside the canvas.
- For diagnostics, a full/overlay/idle readout can expose unnecessary redraws. Wireframe and additive overdraw views can help explain geometry or fragment cost.

### Performance measurements

Frame interval measures pacing and includes vsync; it does not isolate rendering cost. For GPU timing, request the optional `timestamp-query` feature when available, write timestamps around the work, resolve them into a buffer, and map it asynchronously. Sample periodically and keep full-render and overlay timings separate.

Omit `timestampWrites` on passes with neither timestamp index. An empty object invalidates the command buffer. Detect timestamp support on the device and show `n/a` when unavailable.

CPU frame time, shader compile time, data preparation time, and segment count help locate bottlenecks. Add the measurements relevant to the investigation. Use target hardware for claims about user-facing performance; SwiftShader is useful for correctness and limited relative comparisons, but its timings describe a software renderer.

### Headless testing options

For a Playwright/Chromium setup using SwiftShader, these flags are a starting point:

```text
--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-webgpu-adapter=swiftshader
```

Some setups also need `--enable-dawn-features=allow_unsafe_apis` to expose timestamp queries. Flags and capabilities depend on the browser build. Serve the test page over `http://localhost` and check that `navigator.gpu` and the requested adapter are available.

If canvas screenshots are blank, an offscreen render target with buffer readback can provide a deterministic image for comparison. Account for row padding and BGRA channel order where applicable. Keep readback out of rendering benchmarks: bracket a batch of renders with `device.queue.onSubmittedWorkDone()` and divide the elapsed time by the batch size.

For a substantial renderer change, useful cases include zero-size startup, timestamps when supported, representative dense data at full view and deep zoom, and the AA or debug modes the chart implements. During pixel comparisons, freeze animation or compare static regions.

## Multiple series and charts

Share a TypeGPU root and compatible pipelines across charts when practical. Keep chart state in separate uniforms and bind groups, or use dynamic offsets.

For several series in one chart, capsule instances can carry a series id. A coverage texture can hold up to four series in RGBA, with additional targets or array layers for more. Account for channels used by glow. Composite the series in z-order and evaluate their fills and hatches in the scene pass.

One canvas per chart is straightforward for a small dashboard. A shared canvas can reduce presentation overhead for larger dashboards, at the cost of viewport, scissor, and cache management. Use visibility tracking, such as `IntersectionObserver`, to suspend hidden charts where useful. Series with shared timestamps and x-ranges can reuse bin boundaries; their extrema still depend on their values.

## Data preparation

Choose decimation based on the dataset and the accuracy the reader needs.

- Per-column min/max decimation (first, min, max, last, often called M4) preserves extrema and is a useful starting point for money, quotas, or metrics. A CPU min/max pyramid can accelerate range queries during zoom. Check the output against raw data at representative scales.
- Smoothing can reduce visual noise and segment count, but changes the displayed values. A zero-phase filter needs samples on both sides, so the live edge can shift as data arrives. Make smoothing opt-in or label it, and keep raw values available in the hover readout.
- GPU decimation may help with large or streaming datasets already resident on the GPU. It adds complexity and can introduce readback latency for y auto-fit. CPU decimation is often sufficient for smaller datasets.

For the CPU path, upload the visible polyline with time relative to the view. Keeping raw data resident on the GPU may suit a compute-based path better.

## Further options

Consider these when the corresponding cost or product need appears:

- Render bundles to reduce overlay encoding cost across many charts.
- WGSL `override` constants as an alternative to slots, with compile-time measurements on target devices.
- Incremental coverage and cache updates for streaming data; a GPU min/max pyramid for larger streams.
- Tile-to-series lookup for dense dashboards. If the task grows into general rasterization, an existing renderer such as Skia or Vello may be a better fit.
- Device-loss recovery that recreates resources and uploads data again; a Canvas2D fallback that reuses the decimated polyline.
- TypeGPU `'use gpu'` TypeScript with `unplugin-typegpu` for type-checked shader authoring where the project supports it.
