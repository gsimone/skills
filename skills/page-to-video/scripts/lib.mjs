// Shared driver code: load the adapter, launch Chrome on the real GPU, open the page, install the adapter in it.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function playwright() {
  try { return createRequire(path.join(process.cwd(), 'noop.js'))('playwright-core'); }
  catch { console.error('playwright-core not found. Run `npm i playwright-core` in the directory you run this script from.'); process.exit(2); }
}

// a URL as given, or a local file path with an optional ?query#hash kept intact
export function toUrl(target) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return target;
  const m = target.match(/^(.*?\.x?html?)([?#].*)?$/i) || [null, target, ''];
  return pathToFileURL(path.resolve(m[1])).href + (m[2] || '');
}

export async function loadAdapter(file) {
  const a = (await import(pathToFileURL(path.resolve(file)).href)).default;
  for (const k of ['root', 'css', 'size', 'fps', 'frames', 'renderFrame']) if (a?.[k] == null) throw new Error(`adapter is missing "${k}"`);
  if (Math.abs(a.size[0]/a.css[0] - a.size[1]/a.css[1]) > 1e-6) throw new Error('adapter size and css must have the same aspect ratio');
  return a;
}

// page-side functions travel as source text; accept arrows, function expressions and method shorthand
const src = (key, fn, fallback) => {
  if (fn == null) return fallback;
  if (typeof fn !== 'function') return `() => (${JSON.stringify(fn)})`;
  const s = fn.toString();
  return /^(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(s) ? s : `({ ${s} }).${key}`;
};

export async function openPage(target, adapter, { uncapped = false } = {}) {
  const { chromium } = playwright();
  const args = ['--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
  if (process.platform === 'darwin') args.push('--use-angle=metal');                         // headless Chrome on the real GPU
  if (uncapped) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');               // let the paint cycle run faster than the display
  const browser = await chromium.launch({ channel: adapter.channel || 'chrome', headless: true, args });
  const vp = adapter.viewport || adapter.css;
  const ctx = await browser.newContext({ viewport: { width: vp[0], height: vp[1] }, deviceScaleFactor: adapter.size[0]/adapter.css[0] });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('page error:', e.message));
  await page.goto(toUrl(target), { waitUntil: 'load' });
  if (adapter.pageCss) await page.addStyleTag({ content: adapter.pageCss });
  await page.evaluate(`(async () => {
    await document.fonts.ready;
    await Promise.all([...document.fonts].map(f => f.load().catch(() => {})));   // faces load lazily; a caption that first appears mid-video would flash a fallback font
    window.__adapter = { prepare: ${src('prepare', adapter.prepare, '() => {}')}, renderFrame: ${src('renderFrame', adapter.renderFrame)}, frames: ${src('frames', adapter.frames)} };
    await window.__adapter.prepare();
  })()`);
  const info = await page.evaluate(({ root, gl }) => {
    const r = document.querySelector(root), g = gl ? document.querySelector(gl) : null;
    const t = document.createElement('canvas').getContext('webgl2'), e = t && t.getExtension('WEBGL_debug_renderer_info');
    return { frames: Math.round(window.__adapter.frames()), rootFound: !!r, rootCss: r ? [r.offsetWidth, r.offsetHeight] : null, glFound: !gl || !!g, glSize: g ? [g.width, g.height] : null,
      renderer: e ? t.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown', chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1],
      htmlInCanvas: 'drawElementImage' in CanvasRenderingContext2D.prototype, webcodecs: 'VideoEncoder' in window };
  }, { root: adapter.root, gl: adapter.gl || null });
  if (!info.rootFound) throw new Error(`root "${adapter.root}" not found in the page`);
  if (!info.glFound) throw new Error(`gl "${adapter.gl}" not found in the page`);
  if (/swiftshader|llvmpipe|software/i.test(info.renderer)) console.error(`WARNING: software GPU (${info.renderer}); rendering will be slow and may differ`);
  if (info.glSize && (info.glSize[0] !== adapter.size[0] || info.glSize[1] !== adapter.size[1])) console.error(`WARNING: WebGL canvas is ${info.glSize.join('x')}, output is ${adapter.size.join('x')}; it will be scaled, not rendered at output resolution`);
  return { browser, page, info };
}

export const parseArgs = (argv, flags = {}) => { const pos = []; const o = { ...flags };
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); if (!(k in flags)) throw new Error('unknown flag ' + a);
    o[k] = typeof flags[k] === 'boolean' ? true : (typeof flags[k] === 'number' ? +argv[++i] : argv[++i]); }
  return { pos, o }; };
