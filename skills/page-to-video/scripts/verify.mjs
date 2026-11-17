#!/usr/bin/env node
// Checks an adapter before a long export: are frames deterministic, and does the in-page capture match a real screenshot?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadAdapter, openPage, parseArgs } from './lib.mjs';
const HELP = `usage: node verify.mjs <page.html|url> <adapter.mjs> [frame ...] [--keep dir] [--min-psnr 45]
  frames default to 8 spread across the video; pick ones that show each kind of overlay (text, SVG, 2D canvases, fades)
  --keep dir       save the screenshot (ref_N.png) and in-page (exp_N.png) frames there`;
let args; try { args = parseArgs(process.argv.slice(2), { keep: '', minPsnr: 45 }); } catch (e) { console.error(e.message + '\n' + HELP); process.exit(2); }
const [target, adapterFile, ...want] = args.pos; if (!target || !adapterFile) { console.error(HELP); process.exit(2); }
const adapter = await loadAdapter(adapterFile), dir = args.o.keep || fs.mkdtempSync(path.join(os.tmpdir(), 'p2v-')); fs.mkdirSync(dir, { recursive: true });
const dims = b => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`, size = adapter.size.join('x');

// 1. reference: real screenshots of the root element
let frames, shotOK = true;
{ const { browser, page, info } = await openPage(target, adapter);
  frames = want.length ? want.map(Number) : Array.from({ length: 8 }, (_, k) => Math.min(info.frames - 1, Math.round((k + .5)*info.frames/8)));
  const shot = async n => { await page.evaluate(n => { __adapter.renderFrame(n); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }, n); return page.locator(adapter.root).screenshot({ type: 'png', scale: 'device' }); };
  for (const n of frames) { const b = await shot(n); fs.writeFileSync(`${dir}/ref_${n}.png`, b); if (dims(b) !== size) { shotOK = false; console.log(`screenshot of frame ${n} is ${dims(b)}, expected ${size}: the root is not laid out at its css size (set pageCss or viewport in the adapter)`); } }
  // determinism: the same frame after a far jump and after stepping up to it
  const n = frames[Math.floor(frames.length/2)], far = frames[0] === n ? frames[frames.length - 1] : frames[0];
  await shot(far); const cold = await shot(n); for (let k = Math.max(0, n - 20); k < n; k++) await shot(k); const warm = await shot(n);
  console.log(cold.equals(warm) ? `deterministic: frame ${n} is identical after a jump and after stepping` : `NOT DETERMINISTIC: frame ${n} differs after a jump vs after stepping; renderFrame depends on history`);
  if (!cold.equals(warm)) shotOK = false;
  await browser.close(); }

// 2. the in-page capture of the same frames
const { browser, page, info } = await openPage(target, adapter, { uncapped: true });
if (!info.htmlInCanvas) { console.log(`Chrome ${info.chrome} has no HTML-in-Canvas: use screenshot-export.mjs`); await browser.close(); process.exit(3); }
await page.addScriptTag({ path: new URL('./inpage-export.js', import.meta.url).pathname });
await page.evaluate(a => __hicExport.setup(a), { root: adapter.root, gl: adapter.gl || null, size: adapter.size, css: adapter.css, backdrop: adapter.backdrop || null });
let ok = shotOK; const again = {};
for (const n of frames) { const b = Buffer.from(await page.evaluate(n => __hicExport.png(n), n), 'base64'); fs.writeFileSync(`${dir}/exp_${n}.png`, b); again[n] = b; }
for (const n of [...frames].reverse()) { const b = Buffer.from(await page.evaluate(n => __hicExport.png(n), n), 'base64'); if (!b.equals(again[n])) { ok = false; console.log(`in-page frame ${n} differs between two captures`); } }
await browser.close();
console.log(`frame      PSNR vs screenshot   (GPU ${info.renderer}, Chrome ${info.chrome}, ${info.frames} frames)`);
for (const n of frames) { let p = 'error';
  try { p = execSync(`ffmpeg -hide_banner -nostats -i "${dir}/ref_${n}.png" -i "${dir}/exp_${n}.png" -lavfi psnr -f null - 2>&1 | grep -oE "average:[0-9a-z.]+"`).toString().trim().split(':')[1]; } catch {}
  const good = p === 'inf' || +p >= args.o.minPsnr; if (!good) ok = false;
  console.log(`${String(n).padEnd(10)} ${p === 'inf' ? 'identical' : p + ' dB'}${good ? '' : '   <-- below ' + args.o.minPsnr + ' dB: open both PNGs and compare'}`); }
console.log(ok ? 'PASS' : `FAIL (frames kept in ${dir})`); if (ok && !args.o.keep) fs.rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
