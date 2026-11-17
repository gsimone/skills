#!/usr/bin/env node
// In-page export: render, capture and H.264-encode inside the page, then wrap the stream as MP4.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadAdapter, openPage, parseArgs } from './lib.mjs';
const HELP = `usage: node export.mjs <page.html|url> <adapter.mjs> <out.mp4> [flags]
  --from N         first frame (default 0)
  --count N        number of frames (default: to the end)
  --bitrate N      bits per second (default 16000000)
  --silent-audio   add a silent AAC track (some upload targets want one)
  --software       use Chrome's software encoder instead of the hardware one
  --discard        time the export and throw the stream away (out.mp4 is ignored)`;
let args; try { args = parseArgs(process.argv.slice(2), { from: 0, count: -1, bitrate: 16e6, silentAudio: false, software: false, discard: false }); } catch (e) { console.error(e.message + '\n' + HELP); process.exit(2); }
const [target, adapterFile, out] = args.pos, o = args.o;
if (!target || !adapterFile || (!out && !o.discard)) { console.error(HELP); process.exit(2); }
const t0 = Date.now(), adapter = await loadAdapter(adapterFile);
const { browser, page, info } = await openPage(target, adapter, { uncapped: true });
if (!info.htmlInCanvas || !info.webcodecs) { console.error(`Chrome ${info.chrome} lacks ${info.htmlInCanvas ? 'WebCodecs' : 'HTML-in-Canvas (drawElementImage)'}; use screenshot-export.mjs`); await browser.close(); process.exit(3); }
await page.addScriptTag({ path: new URL('./inpage-export.js', import.meta.url).pathname });
const count = o.count < 0 ? info.frames - o.from : o.count;
const r = await page.evaluate(async ({ a, from, count, o }) => { __hicExport.setup(a); return __hicExport.encode({ from, count, fps: a.fps, bitrate: o.bitrate, keep: !o.discard, hardware: !o.software }); },
  { a: { root: adapter.root, gl: adapter.gl || null, size: adapter.size, css: adapter.css, fps: adapter.fps, backdrop: adapter.backdrop || null }, from: o.from, count, o });
if (r.err) { console.error('export failed:', r.err); await browser.close(); process.exit(1); }
let raw = null;
if (!o.discard) { raw = out + '.h264'; const fd = fs.openSync(raw, 'w'), STEP = 12*1024*1024;      // a multiple of 3, so base64 pieces join cleanly
  for (let p = 0; p < r.bytes; p += STEP) fs.writeSync(fd, Buffer.from(await page.evaluate(([a, b]) => __hicExport.slice(a, b), [p, Math.min(r.bytes, p + STEP)]), 'base64'));
  fs.closeSync(fd); }
await browser.close();
if (raw) { const fps = String(adapter.fps), ts = `setts=pts=N/${fps}/TB:dts=N/${fps}/TB`;                 // the raw stream carries no usable timestamps
  const audio = o.silentAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-c:a', 'aac', '-b:a', '128k', '-shortest'] : [];
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-r', fps, '-f', 'h264', '-i', raw, ...audio.slice(0, 4), '-c:v', 'copy', '-bsf:v', ts, ...audio.slice(4), '-movflags', '+faststart', out]); fs.unlinkSync(raw); }
console.log(`${count} frames (${info.frames} in the page) in ${(r.ms/1000).toFixed(1)} s in-page = ${(count*1000/r.ms).toFixed(0)} fps, ${(count/adapter.fps/(r.ms/1000)).toFixed(2)}x real time; ` +
  `${(r.bytes/1e6).toFixed(1)} MB; encoder waits ${r.waits}; wall ${((Date.now() - t0)/1000).toFixed(1)} s; GPU ${info.renderer}; Chrome ${info.chrome}` + (o.discard ? '' : `\nwrote ${out}`));
