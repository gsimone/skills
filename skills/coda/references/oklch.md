# OKLCH palettes for codas

OKLCH is perceptual: equal `L` steps look like equal lightness steps, and rotating `H` at fixed `L`/`C` gives hues that genuinely match in weight. Build every palette here, then convert to sRGB.

`L` ∈ 0–1 (lightness), `C` ≈ 0–0.3 (chroma), `H` ∈ 0–360° (hue).

## Recipes

Pick one recipe per piece. Vary the numbers, not the structure.

- **Constant-L hue arc** — fix `L` (0.65–0.8) and `C` (0.10–0.14), take 3–5 hues along an arc of 60–150°. Calm, sibling colors. The classic multi-color palette.
- **Lightness ramp** — fix `H` and `C`, step `L` from ~0.25 to ~0.95 in 4–6 stops. Monochrome depth; great for layering and fog.
- **Quiet field + loud accent** — 2–3 near-neutrals (`C` 0.01–0.04) spanning light and dark `L`, plus one accent at `C` 0.15–0.2. Use the accent at well under 10% of the ink.
- **Complement pair** — two hues ~180° apart at the same `L`/`C`, plus a paper tone. Tension without noise.
- **Paper tones** — a sheet is rarely pure white or black: light paper `oklch(0.96–0.98, 0.005–0.015, any warm H)`, dark paper `oklch(0.15–0.22, 0.01–0.03, 250–290)`.

Gamut care: sRGB cannot hold high chroma everywhere. Keep `C` ≤ 0.12 as a safe ceiling across all hues and lightnesses; push toward 0.2 only for mid-`L` (0.55–0.75) accents. The converter below clamps, so out-of-gamut colors dull rather than break — but clamping shifts hue, so stay inside.

## Converter

Canvas 2D accepts `oklch()` CSS strings directly in modern browsers, but p5's color parser and three.js do not — so precompute with this and hand sRGB onward. Drop it into the sketch verbatim:

```js
// oklch(L 0–1, C, H deg) → [r, g, b] each 0–255, clamped to sRGB gamut
function oklch(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(x, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  });
}
```

Usage: `fill(...oklch(0.7, 0.12, 200))` in p5; `new THREE.Color(...oklch(0.7, 0.12, 200).map(v => v / 255))` in three (set `renderer.outputColorSpace = THREE.SRGBColorSpace`); `` `rgb(${oklch(0.7, 0.12, 200).join(',')})` `` for CSS.
