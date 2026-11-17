#!/usr/bin/env node
// Fallback export: step the page frame by frame and screenshot each one. Works on any Chrome and any page the adapter can drive.
// Slow (about 200 ms per 1080p frame per browser), so frames are split across parallel browsers, kept lossless, then encoded once.
import fs from 'node:fs';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { loadAdapter, openPage, parseArgs } from './lib.mjs';
const HELP = `usage: node screenshot-export.mjs <page.html|url> <adapter.mjs> <out.mp4> [flags]
  --from N --count N   frame range (default: all)
  --workers N          parallel browsers (default: min(6, half the cores))
  --crf N              x264 quality (default 16)
  --silent-audio       add a silent AAC track
  needs about 0.5 MB of free disk per 1080p frame for the lossless intermediates`;
let args; try { args = parseArgs(process.argv.slice(2), { from: 0, count: -1, workers: Math.max(1, Math.min(6, os.cpus().length >> 1)), crf: 16, silentAudio: false, worker: '' }); } catch (e) { console.error(e.message + '\n' + HELP); process.exit(2); }
const [target, adapterFile, out] = args.pos, o = args.o; if (!target || !adapterFile || !out) { console.error(HELP); process.exit(2); }
const adapter = await loadAdapter(adapterFile);

if (o.worker) {                                                   // one browser, one frame range -> one lossless segment
  const { browser, page } = await openPage(target, adapter);
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(adapter.fps), '-c:v', 'png', '-i', '-', '-c:v', 'libx264rgb', '-qp', '0', '-preset', 'ultrafast', o.worker], { stdio: ['pipe', 'inherit', 'inherit'] });
  const root = page.locator(adapter.root), want = adapter.size.join('x');
  for (let n = o.from; n < o.from + o.count; n++) {
    await page.evaluate(n => { __adapter.renderFrame(n); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }, n);
    const png = await root.screenshot({ type: 'png', scale: 'device' });
    if (`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` !== want) throw new Error(`frame ${n} is ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}, expected ${want}: fix pageCss/viewport in the adapter`);
    if (!ff.stdin.write(png)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end(); const [code] = await once(ff, 'close'); await browser.close(); process.exit(code);
}

const t0 = Date.now();
let total = o.count; if (total < 0) { const { browser, info } = await openPage(target, adapter); total = info.frames - o.from; await browser.close(); }
const parts = out + '.parts'; fs.mkdirSync(parts, { recursive: true });
const W = Math.min(o.workers, total), per = Math.ceil(total/W), segs = [], jobs = [];
for (let k = 0; k < W; k++) { const a = o.from + k*per, c = Math.min(per, o.from + total - a); if (c <= 0) break; const seg = `${parts}/seg${k}.mkv`; segs.push(seg);
  const p = spawn(process.execPath, [new URL(import.meta.url).pathname, target, adapterFile, out, '--from', a, '--count', c, '--worker', seg].map(String), { stdio: 'inherit' });
  jobs.push(once(p, 'close').then(([code]) => { if (code) throw new Error(`worker ${k} failed (${code})`); })); }
await Promise.all(jobs);
fs.writeFileSync(`${parts}/list.txt`, segs.map(s => `file '${s.split('/').pop()}'`).join('\n'));
const fps = String(adapter.fps), audio = o.silentAudio ? [['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'], ['-c:a', 'aac', '-b:a', '128k', '-shortest']] : [[], []];
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${parts}/list.txt`, ...audio[0],
  '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p',
  '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', String(o.crf), '-maxrate', '25M', '-bufsize', '50M', '-r', fps, '-g', String(2*adapter.fps),
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', ...audio[1], '-movflags', '+faststart', out], { stdio: 'inherit' });
fs.rmSync(parts, { recursive: true, force: true });
console.log(`${total} frames with ${segs.length} browsers in ${((Date.now() - t0)/1000).toFixed(0)} s\nwrote ${out}`);
