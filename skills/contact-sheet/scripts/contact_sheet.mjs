#!/usr/bin/env node

/**
 * Video contact-sheet harness.
 *
 * Turns a screen recording into analyzable visual-change data using only Node
 * built-ins plus ffmpeg/ffprobe on PATH.
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
import process from "node:process";

const INK = "#0b0b0b";
const INK2 = "#52514e";
const MUTED = "#898781";
const GRID = "#e1e0d9";
const BASE = "#c3c2b7";
const SURFACE = "#fcfcfb";
const SERIES = "#2a78d6";
const SERIES_WASH = "#cde2fb";
const MARKER = "#eb6834";
const PNG_COMPRESSION_LEVEL = "1";
const DEFAULT_MAX_FRAMES = 48;
const DEFAULT_THUMB_WIDTH = 800;
const DEFAULT_ANALYSIS_WIDTH = 480;
const DEFAULT_DIFF_PIXEL_THRESHOLD = 24;

const logicalCpuCount = Math.max(1, cpus().length);
const defaultJobs = Math.min(4, Math.max(1, Math.floor(logicalCpuCount / 2)));

function usage() {
  return `Usage: contact_sheet.mjs [options] <video>

Video contact-sheet harness.

Arguments:
  video                         input video

Options:
  -o, --out <dir>               output dir (default: <video-stem>-contact-sheet next to video)
  --threshold <number>          YDIF change threshold (default: auto from noise floor)
  --gap <seconds>               calm that ends a burst (default: 0.12)
  --settle <frames>             frames after a burst to sample (default: 3)
  --max-frames <count>          max captured states (default: 48)
  --thumb-width <pixels>        clean-frame/static-diff width (default: 800)
  --analysis-width <pixels>     downscale width for YDIF analysis (default: 480)
  --diff-pixel-threshold <0-255>
                                max-channel RGB delta for highlights (default: 24)
  --jobs <count>                concurrent transition renderers
                                (default: ${defaultJobs}, derived from ${logicalCpuCount} logical CPUs)
  -h, --help                    show this help

The state cap also caps static triptychs at N-1. Lower-signal dropped bursts
are reported in report.md and meta.json.`;
}

function fail(message, code = 1) {
  console.error(message);
  process.exitCode = code;
  throw new Error("__CONTACT_SHEET_REPORTED__");
}

function parseNumber(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    fail(`${name} requires a number, got: ${value}`);
  }
  return parsed;
}

function parseInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    fail(`${name} requires an integer, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    out: null,
    threshold: null,
    gap: 0.12,
    settle: 3,
    maxFrames: DEFAULT_MAX_FRAMES,
    thumbWidth: DEFAULT_THUMB_WIDTH,
    analysisWidth: DEFAULT_ANALYSIS_WIDTH,
    diffPixelThreshold: DEFAULT_DIFF_PIXEL_THRESHOLD,
    jobs: defaultJobs,
    jobsExplicit: false,
    video: null,
  };
  const valueFlags = new Map([
    ["-o", ["out", String]],
    ["--out", ["out", String]],
    ["--threshold", ["threshold", (value) => parseNumber("--threshold", value)]],
    ["--gap", ["gap", (value) => parseNumber("--gap", value)]],
    ["--settle", ["settle", (value) => parseInteger("--settle", value)]],
    ["--max-frames", ["maxFrames", (value) => parseInteger("--max-frames", value)]],
    ["--thumb-width", ["thumbWidth", (value) => parseInteger("--thumb-width", value)]],
    ["--analysis-width", ["analysisWidth", (value) => parseInteger("--analysis-width", value)]],
    [
      "--diff-pixel-threshold",
      ["diffPixelThreshold", (value) => parseInteger("--diff-pixel-threshold", value)],
    ],
    ["--jobs", ["jobs", (value) => parseInteger("--jobs", value)]],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "-h" || raw === "--help") {
      console.log(usage());
      process.exit(0);
    }

    const equalsIndex = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
    const definition = valueFlags.get(flag);
    if (definition) {
      const [key, convert] = definition;
      const value = equalsIndex === -1 ? argv[index + 1] : raw.slice(equalsIndex + 1);
      if (value === undefined) {
        fail(`${flag} requires a value`);
      }
      if (equalsIndex === -1) {
        index += 1;
      }
      options[key] = convert(value);
      if (flag === "--jobs") {
        options.jobsExplicit = true;
      }
    } else if (raw.startsWith("-")) {
      fail(`unknown option: ${raw}\n\n${usage()}`);
    } else if (options.video === null) {
      options.video = raw;
    } else {
      fail(`unexpected argument: ${raw}`);
    }
  }

  if (options.video === null) {
    fail(`video is required\n\n${usage()}`);
  }
  if (options.maxFrames < 1) {
    fail("--max-frames must be at least 1");
  }
  if (options.jobs < 1) {
    fail("--jobs must be at least 1");
  }
  if (options.diffPixelThreshold < 0 || options.diffPixelThreshold > 255) {
    fail("--diff-pixel-threshold must be between 0 and 255");
  }
  return options;
}

function displayCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(String(part))).join(" ");
}

function feedFiles(files, writable) {
  return (async () => {
    for (const file of files) {
      await new Promise((resolve, reject) => {
        const input = createReadStream(file);
        const cleanup = () => {
          input.removeListener("error", onError);
          writable.removeListener("error", onError);
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        input.once("error", onError);
        writable.once("error", onError);
        input.once("end", () => {
          cleanup();
          resolve();
        });
        input.pipe(writable, { end: false });
      });
    }
    writable.end();
  })();
}

async function run(command, args, { binary = false, inputFiles = null } = {}) {
  const child = spawn(command, args, {
    stdio: [inputFiles ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const feed = inputFiles
    ? feedFiles(inputFiles, child.stdin).catch((error) => {
        if (error.code !== "EPIPE") {
          throw error;
        }
      })
    : Promise.resolve();

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).catch((error) => {
    if (error.code === "ENOENT") {
      fail(`${command} is required on PATH`);
    }
    throw error;
  });
  await feed;

  const output = Buffer.concat(stdout);
  const errorOutput = Buffer.concat(stderr).toString("utf8");
  if (result.code !== 0) {
    const suffix = errorOutput.slice(-2000);
    fail(
      `command failed (${result.signal ?? `exit ${result.code}`}): ${displayCommand(command, args)}\n${suffix}`,
    );
  }
  return binary ? output : output.toString("utf8");
}

function lavfiEscape(value) {
  return String(value).replace(/[\\':,;\[\]]/g, "\\$&");
}

function drawtextEscape(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll("%", "\\%");
}

function drawtext(text, fontSize, y, color, font) {
  const fontSource = font ? `fontfile=${lavfiEscape(font)}:` : "";
  return `drawtext=${fontSource}text='${drawtextEscape(text)}':fontsize=${fontSize}:fontcolor=${color}:x=12:y=${y}`;
}

function findFont() {
  return [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Monaco.ttf",
    "/System/Library/Fonts/Supplemental/Courier New.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  ].find((candidate) => existsSync(candidate)) ?? null;
}

async function checkCapabilities() {
  const [filters] = await Promise.all([
    run("ffmpeg", ["-hide_banner", "-filters"]),
    run("ffprobe", ["-v", "error", "-version"]),
  ]);
  return {
    hasDrawtext: filters.includes("drawtext"),
    font: findFont(),
  };
}

async function probeMeta(video) {
  const output = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    video,
  ]);
  const data = JSON.parse(output);
  const videoStream = data.streams?.find((stream) => stream.codec_type === "video");
  if (!videoStream) {
    fail(`no video stream found in: ${video}`);
  }
  return {
    path: video,
    duration_s: Number(data.format.duration),
    width: Number(videoStream.width),
    height: Number(videoStream.height),
    nb_frames: Number(videoStream.nb_frames ?? 0),
    r_frame_rate: videoStream.r_frame_rate ?? "",
  };
}

async function frameDiffs(video, analysisWidth) {
  const graph = `movie=${lavfiEscape(video)},scale=${analysisWidth}:-2,signalstats`;
  const output = await run("ffprobe", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    graph,
    "-show_entries",
    "frame=pts_time,pkt_pts_time,best_effort_timestamp_time:frame_tags=lavfi.signalstats.YDIF",
    "-print_format",
    "json",
  ]);
  const parsed = JSON.parse(output);
  const frames = (parsed.frames ?? []).map((frame, index) => ({
    n: index,
    t: Number(
      frame.pts_time ??
        frame.pkt_pts_time ??
        frame.best_effort_timestamp_time,
    ),
    ydif: Number(frame.tags?.["lavfi.signalstats.YDIF"] ?? 0),
  }));
  if (frames.length > 0) {
    frames[0].ydif = 0;
  }
  return frames;
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatFixed(value, places) {
  const scale = 10 ** places;
  const scaled = value * scale;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const tolerance =
    Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  const rounded =
    Math.abs(fraction - 0.5) <= tolerance
      ? lower % 2 === 0
        ? lower
        : lower + 1
      : Math.round(scaled);
  return (rounded / scale).toFixed(places);
}

function detectBursts(frames, threshold, gapSeconds) {
  const bursts = [];
  let current = null;
  let lastHotTime = null;
  for (const frame of frames) {
    if (frame.ydif >= threshold) {
      if (current === null) {
        current = {
          start: frame,
          end: frame,
          peak: frame,
          sum: 0,
          hot_frames: 0,
        };
      }
      current.end = frame;
      current.sum += frame.ydif;
      current.hot_frames += 1;
      if (frame.ydif > current.peak.ydif) {
        current.peak = frame;
      }
      lastHotTime = frame.t;
    } else if (
      current !== null &&
      lastHotTime !== null &&
      frame.t - lastHotTime > gapSeconds
    ) {
      bursts.push(current);
      current = null;
    }
  }
  if (current !== null) {
    bursts.push(current);
  }
  for (const burst of bursts) {
    burst.duration_s = burst.end.t - burst.start.t;
  }
  return bursts;
}

function pickStates(frames, bursts, settleFrames, maxFrames) {
  const picks = new Map([[0, { frame: frames[0], why: "initial" }]]);
  const ranked = [...bursts].sort((left, right) => right.sum - left.sum);
  const dropped = Math.max(0, ranked.length - (maxFrames - 1));
  for (const burst of ranked.slice(0, maxFrames - 1)) {
    const index = Math.min(burst.end.n + settleFrames, frames.length - 1);
    picks.set(index, {
      frame: frames[index],
      why: `after burst @${burst.start.t.toFixed(2)}s`,
    });
  }
  const states = [...picks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, state]) => state);
  return { states, dropped };
}

async function removePngs(directory) {
  await mkdir(directory, { recursive: true });
  const names = await readdir(directory);
  await Promise.all(
    names
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .map((name) => rm(path.join(directory, name))),
  );
}

async function extractFrames(video, states, outDir, thumbWidth) {
  const frameNumbers = states.map((state) => state.frame.n);
  const select = frameNumbers.map((number) => `eq(n\\,${number})`).join("+");
  const framesDir = path.join(outDir, "frames");
  await removePngs(framesDir);
  await run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    video,
    "-vf",
    `select='${select}',scale=${thumbWidth}:-2`,
    "-vsync",
    "vfr",
    "-compression_level",
    PNG_COMPRESSION_LEVEL,
    path.join(framesDir, "tmp_%04d.png"),
  ]);
  const produced = (await readdir(framesDir))
    .filter((name) => /^tmp_\d+\.png$/.test(name))
    .sort();
  if (produced.length !== states.length) {
    fail(
      `ffmpeg extracted ${produced.length} state frames; expected ${states.length}`,
    );
  }
  const named = [];
  for (let index = 0; index < produced.length; index += 1) {
    const state = states[index];
    const filename = `${String(state.frame.n).padStart(5, "0")}_t${state.frame.t
      .toFixed(3)
      .padStart(7, "0")}s.png`;
    const destination = path.join(framesDir, filename);
    await rename(path.join(framesDir, produced[index]), destination);
    named.push(destination);
  }
  return named;
}

async function buildSheet(
  video,
  states,
  outDir,
  thumbWidth,
  capabilities,
) {
  const frameNumbers = states.map((state) => state.frame.n);
  const select = frameNumbers.map((number) => `eq(n\\,${number})`).join("+");
  const columns = Math.max(
    1,
    Math.ceil(Math.sqrt((frameNumbers.length * 16) / 9)),
  );
  const rows = Math.ceil(frameNumbers.length / columns);
  const filters = [`select='${select}'`, `scale=${thumbWidth}:-2`];
  if (capabilities.hasDrawtext) {
    const fontSource = capabilities.font
      ? `fontfile=${lavfiEscape(capabilities.font)}:`
      : "";
    filters.push(
      `drawtext=${fontSource}text='%{pts\\:hms}':fontsize=28:fontcolor=white:borderw=3:bordercolor=black:x=12:y=h-th-12`,
    );
  }
  filters.push(
    `tile=${columns}x${rows}:padding=6:margin=8:color=0xfcfcfb`,
  );
  const sheet = path.join(outDir, "contact-sheet.png");
  await run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    video,
    "-vf",
    filters.join(","),
    "-vsync",
    "vfr",
    "-frames:v",
    "1",
    "-compression_level",
    PNG_COMPRESSION_LEVEL,
    sheet,
  ]);
  return sheet;
}

async function probeImageSize(image) {
  const output = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    image,
  ]);
  const stream = JSON.parse(output).streams?.[0];
  if (!stream) {
    fail(`could not probe image dimensions: ${image}`);
  }
  return { width: Number(stream.width), height: Number(stream.height) };
}

async function decodeRgbFrames(frameFiles) {
  const { width, height } = await probeImageSize(frameFiles[0]);
  const raw = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      "1",
      "-i",
      "pipe:0",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { binary: true, inputFiles: frameFiles },
  );
  const frameSize = width * height * 3;
  const expected = frameSize * frameFiles.length;
  if (raw.length !== expected) {
    fail(
      `decoded state frames occupied ${raw.length} bytes; expected ${expected}`,
    );
  }
  return {
    width,
    height,
    decoded: frameFiles.map((_, index) =>
      raw.subarray(index * frameSize, (index + 1) * frameSize),
    ),
  };
}

async function measureTransitions(states, frameFiles, pixelThreshold) {
  const { width, height, decoded } = await decodeRgbFrames(frameFiles);
  const pixelCount = width * height;
  const transitions = [];
  for (let stateIndex = 1; stateIndex < states.length; stateIndex += 1) {
    const previous = decoded[stateIndex - 1];
    const current = decoded[stateIndex];
    let changed = 0;
    let deltaSum = 0;
    let maxDelta = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let byteIndex = 0; byteIndex < previous.length; byteIndex += 3) {
      const previousR = previous[byteIndex];
      const previousG = previous[byteIndex + 1];
      const previousB = previous[byteIndex + 2];
      const currentR = current[byteIndex];
      const currentG = current[byteIndex + 1];
      const currentB = current[byteIndex + 2];
      const red = previousR > currentR ? previousR - currentR : currentR - previousR;
      const green =
        previousG > currentG ? previousG - currentG : currentG - previousG;
      const blue =
        previousB > currentB ? previousB - currentB : currentB - previousB;
      deltaSum += red + green + blue;
      const pixelDelta = Math.max(red, green, blue);
      if (pixelDelta > maxDelta) {
        maxDelta = pixelDelta;
      }
      if (pixelDelta > pixelThreshold) {
        changed += 1;
        const pixelIndex = byteIndex / 3;
        const y = Math.floor(pixelIndex / width);
        const x = pixelIndex - y * width;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const changedPct = (changed / pixelCount) * 100;
    const bbox =
      changed === 0
        ? null
        : {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1,
          };
    transitions.push({
      from_state: stateIndex - 1,
      to_state: stateIndex,
      from_t_s: states[stateIndex - 1].frame.t,
      to_t_s: states[stateIndex].frame.t,
      elapsed_s:
        states[stateIndex].frame.t - states[stateIndex - 1].frame.t,
      changed_pixels: changed,
      total_pixels: pixelCount,
      changed_pct: changedPct,
      mean_abs_rgb: deltaSum / (pixelCount * 3),
      max_channel_delta: maxDelta,
      bbox,
      status:
        changed === 0
          ? "NO VISIBLE CHANGE"
          : changedPct < 0.05
            ? "TINY CHANGE"
            : "CHANGED",
    });
  }
  return { width, height, transitions };
}

function transitionFilename(transition) {
  return `S${String(transition.from_state).padStart(3, "0")}-to-S${String(
    transition.to_state,
  ).padStart(3, "0")}_t${transition.from_t_s
    .toFixed(3)
    .padStart(7, "0")}s-to-t${transition.to_t_s
    .toFixed(3)
    .padStart(7, "0")}s.png`;
}

async function renderTransitionDiff({
  previous,
  current,
  transition,
  output,
  width,
  height,
  pixelThreshold,
  capabilities,
}) {
  const thresholdExpression = `lut=y='if(gt(val\\,${pixelThreshold})\\,255\\,0)'`;
  const bbox = transition.bbox;
  const bboxText =
    bbox === null
      ? "none"
      : `x${bbox.x} y${bbox.y} ${bbox.width}x${bbox.height}`;
  const previousHeader = `PREVIOUS  S${String(transition.from_state).padStart(
    3,
    "0",
  )}  t=${transition.from_t_s.toFixed(3)}s`;
  const currentHeader = `CURRENT  S${String(transition.to_state).padStart(
    3,
    "0",
  )}  t=${transition.to_t_s.toFixed(3)}s`;
  const diffHeader = `DIFF  S${String(transition.from_state).padStart(
    3,
    "0",
  )} -> S${String(transition.to_state).padStart(
    3,
    "0",
  )}  green > ${pixelThreshold} RGB (+1px)`;
  const metricText = `${transition.status} | changed ${formatFixed(
    transition.changed_pct,
    4,
  )} pct | mean abs RGB ${transition.mean_abs_rgb.toFixed(3)} | bbox ${bboxText}`;
  const elapsedText = `elapsed ${(transition.elapsed_s * 1000).toFixed(0)} ms`;
  const filters = [
    "[0:v]format=rgb24,split=2[previous_panel][previous_diff]",
    "[1:v]format=rgb24,split=3[current_panel][current_diff][dim_source]",
    "[previous_diff][current_diff]blend=all_mode=difference,format=gbrp[delta]",
    "[delta]extractplanes=r+g+b[delta_r][delta_g][delta_b]",
    "[delta_r][delta_g]blend=all_mode=lighten[delta_rg]",
    `[delta_rg][delta_b]blend=all_mode=lighten,${thresholdExpression},dilation[display_mask]`,
    `color=c=0x00ff88:s=${width}x${height},format=rgb24[green]`,
    "[green][display_mask]alphamerge[highlight]",
    "[dim_source]eq=brightness=-0.35:saturation=0.45[dimmed]",
    "[dimmed][highlight]overlay=format=rgb[overlay]",
  ];
  let overlaySource = "overlay";
  if (transition.status === "TINY CHANGE" && bbox !== null) {
    const margin = 8;
    const boxX = Math.max(0, bbox.x - margin);
    const boxY = Math.max(0, bbox.y - margin);
    const boxWidth = Math.min(width - boxX, bbox.width + margin * 2);
    const boxHeight = Math.min(height - boxY, bbox.height + margin * 2);
    filters.push(
      `[overlay]drawbox=x=${boxX}:y=${boxY}:w=${boxWidth}:h=${boxHeight}:color=yellow@0.95:t=2[boxed_overlay]`,
    );
    overlaySource = "boxed_overlay";
  }

  if (capabilities.hasDrawtext) {
    filters.push(
      `[previous_panel]pad=iw:ih+76:0:42:color=0x111111,${drawtext(
        previousHeader,
        22,
        10,
        "white",
        capabilities.font,
      )},${drawtext(
        "reference state",
        17,
        "h-th-10",
        "0xb9b9b9",
        capabilities.font,
      )}[labeled_previous]`,
      `[current_panel]pad=iw:ih+76:0:42:color=0x111111,${drawtext(
        currentHeader,
        22,
        10,
        "white",
        capabilities.font,
      )},${drawtext(
        elapsedText,
        17,
        "h-th-10",
        "0xb9b9b9",
        capabilities.font,
      )}[labeled_current]`,
      `[${overlaySource}]pad=iw:ih+76:0:42:color=0x111111,${drawtext(
        diffHeader,
        22,
        10,
        "white",
        capabilities.font,
      )},${drawtext(
        metricText,
        17,
        "h-th-10",
        "white",
        capabilities.font,
      )}[labeled_overlay]`,
    );
  } else {
    filters.push(
      "[previous_panel]copy[labeled_previous]",
      "[current_panel]copy[labeled_current]",
      `[${overlaySource}]copy[labeled_overlay]`,
    );
  }
  filters.push(
    "[labeled_previous][labeled_current][labeled_overlay]hstack=inputs=3[triptych]",
  );
  await run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    previous,
    "-i",
    current,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[triptych]",
    "-frames:v",
    "1",
    "-compression_level",
    PNG_COMPRESSION_LEVEL,
    output,
  ]);
}

async function runPool(tasks, jobs) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(jobs, Math.max(1, tasks.length)) },
    async () => {
      while (nextIndex < tasks.length) {
        const index = nextIndex;
        nextIndex += 1;
        await tasks[index]();
      }
    },
  );
  await Promise.all(workers);
}

async function buildStaticDiffs({
  frameFiles,
  transitions,
  outDir,
  pixelThreshold,
  width,
  height,
  capabilities,
  jobs,
}) {
  const diffDir = path.join(outDir, "diffs");
  await removePngs(diffDir);
  const diffFiles = transitions.map((transition) => {
    const filename = transitionFilename(transition);
    transition.file = `diffs/${filename}`;
    return path.join(diffDir, filename);
  });
  await runPool(
    transitions.map((transition, index) => async () => {
      await renderTransitionDiff({
        previous: frameFiles[transition.from_state],
        current: frameFiles[transition.to_state],
        transition,
        output: diffFiles[index],
        width,
        height,
        pixelThreshold,
        capabilities,
      });
    }),
    jobs,
  );

  const sheet = path.join(outDir, "diff-contact-sheet.png");
  if (diffFiles.length === 0) {
    await rm(sheet, { force: true });
    return { diffFiles, diffSheet: null };
  }
  const columns = Math.max(
    1,
    Math.ceil(Math.sqrt((diffFiles.length * 16) / 9)),
  );
  const rows = Math.ceil(diffFiles.length / columns);
  await run(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      "1",
      "-i",
      "pipe:0",
      "-vf",
      `crop=w=iw/3:h=ih:x=2*iw/3:y=0,scale=480:-2,tile=${columns}x${rows}:nb_frames=${diffFiles.length}:padding=5:margin=8:color=0x111111`,
      "-frames:v",
      "1",
      "-compression_level",
      PNG_COMPRESSION_LEVEL,
      sheet,
    ],
    { inputFiles: diffFiles },
  );
  return { diffFiles, diffSheet: sheet };
}

function formatGeneral(value) {
  return Number(value).toString();
}

async function writeTimelineSvg(
  frames,
  bursts,
  states,
  threshold,
  output,
  title,
) {
  const width = 1280;
  const height = 400;
  const marginLeft = 64;
  const marginRight = 24;
  const marginTop = 64;
  const marginBottom = 74;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;
  const timeMax = frames.at(-1).t || 1;
  const yMax =
    Math.max(
      Math.max(...frames.map((frame) => frame.ydif)),
      threshold,
    ) *
      1.08 || 1;
  const scaleX = (time) => marginLeft + (time / timeMax) * plotWidth;
  const scaleY = (value) =>
    marginTop + plotHeight - (value / yMax) * plotHeight;
  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, -apple-system, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="${SURFACE}"/>`,
    `<text x="${marginLeft}" y="26" font-size="16" font-weight="600" fill="${INK}">${title}</text>`,
    `<text x="${marginLeft}" y="44" font-size="12" fill="${INK2}">Mean per-frame luma change (YDIF, 0–255) · shaded = change burst · ticks = captured visual state</text>`,
  ];
  for (const burst of bursts) {
    const x0 = scaleX(burst.start.t);
    const x1 = scaleX(burst.end.t);
    elements.push(
      `<rect x="${x0.toFixed(1)}" y="${marginTop}" width="${Math.max(
        x1 - x0,
        1.5,
      ).toFixed(1)}" height="${plotHeight}" fill="${SERIES_WASH}" opacity="0.55"/>`,
    );
  }
  for (let index = 0; index < 5; index += 1) {
    const value = (yMax * index) / 4;
    const y = scaleY(value);
    elements.push(
      `<line x1="${marginLeft}" y1="${y.toFixed(
        1,
      )}" x2="${marginLeft + plotWidth}" y2="${y.toFixed(
        1,
      )}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${marginLeft - 8}" y="${(y + 4).toFixed(
        1,
      )}" font-size="11" fill="${MUTED}" text-anchor="end" style="font-variant-numeric: tabular-nums">${value.toFixed(
        1,
      )}</text>`,
    );
  }
  const step = Math.max(1, Math.round(timeMax / 8));
  for (let time = 0; time <= timeMax; time += step) {
    const x = scaleX(time);
    elements.push(
      `<text x="${x.toFixed(1)}" y="${
        marginTop + plotHeight + 18
      }" font-size="11" fill="${MUTED}" text-anchor="middle" style="font-variant-numeric: tabular-nums">${formatGeneral(
        time,
      )}s</text>`,
    );
  }
  elements.push(
    `<line x1="${marginLeft}" y1="${
      marginTop + plotHeight
    }" x2="${marginLeft + plotWidth}" y2="${
      marginTop + plotHeight
    }" stroke="${BASE}" stroke-width="1"/>`,
  );
  const thresholdY = scaleY(threshold);
  elements.push(
    `<line x1="${marginLeft}" y1="${thresholdY.toFixed(
      1,
    )}" x2="${marginLeft + plotWidth}" y2="${thresholdY.toFixed(
      1,
    )}" stroke="${MUTED}" stroke-width="1" stroke-dasharray="4 4"/>`,
    `<text x="${marginLeft + plotWidth}" y="${(
      thresholdY - 5
    ).toFixed(
      1,
    )}" font-size="11" fill="${MUTED}" text-anchor="end">threshold ${formatGeneral(
      threshold,
    )}</text>`,
  );
  const points = frames
    .map(
      (frame) =>
        `${scaleX(frame.t).toFixed(1)},${scaleY(
          Math.min(frame.ydif, yMax),
        ).toFixed(1)}`,
    )
    .join(" ");
  elements.push(
    `<polyline points="${points}" fill="none" stroke="${SERIES}" stroke-width="2" stroke-linejoin="round"/>`,
  );
  for (const state of states) {
    const x = scaleX(state.frame.t);
    elements.push(
      `<line x1="${x.toFixed(1)}" y1="${
        marginTop + plotHeight
      }" x2="${x.toFixed(1)}" y2="${
        marginTop + plotHeight + 8
      }" stroke="${MARKER}" stroke-width="2"/>`,
    );
  }
  const legendY = height - 26;
  elements.push(
    `<line x1="${marginLeft}" y1="${legendY}" x2="${
      marginLeft + 22
    }" y2="${legendY}" stroke="${SERIES}" stroke-width="2"/>`,
    `<text x="${marginLeft + 28}" y="${
      legendY + 4
    }" font-size="12" fill="${INK2}">frame difference</text>`,
    `<rect x="${marginLeft + 140}" y="${
      legendY - 7
    }" width="22" height="14" fill="${SERIES_WASH}" opacity="0.55"/>`,
    `<text x="${marginLeft + 168}" y="${
      legendY + 4
    }" font-size="12" fill="${INK2}">change burst</text>`,
    `<line x1="${marginLeft + 268}" y1="${legendY - 5}" x2="${
      marginLeft + 268
    }" y2="${legendY + 5}" stroke="${MARKER}" stroke-width="2"/>`,
    `<text x="${marginLeft + 276}" y="${
      legendY + 4
    }" font-size="12" fill="${INK2}">captured state</text>`,
    "</svg>",
  );
  await writeFile(output, elements.join("\n"));
}

function literalTemplate(strings) {
  return strings.raw[0]
    .replaceAll("\\`", "`")
    .replaceAll("\\${", "${");
}

const VISUALIZER_TEMPLATE = literalTemplate`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  :root {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --blue: #3987e5; --orange: #d95926;
    --green: #00ff88;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--ink);
         font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 14px 20px 10px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header p { margin: 2px 0 0; color: var(--ink2); font-size: 12px; }
  #stage { display: flex; justify-content: center; background: #000;
           border-block: 1px solid var(--grid); }
  #frameWrap { position: relative; font-size: 0; }
  #frame { max-width: 100vw; max-height: 66vh; }
  #diff { position: absolute; inset: 0; width: 100%; height: 100%;
          pointer-events: none; display: none; }
  .flashing #diff { animation: flashPulse 0.8s ease-in-out infinite; }
  @keyframes flashPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
  #controls { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center;
              padding: 10px 20px; }
  button, select { background: var(--surface); color: var(--ink);
    border: 1px solid var(--grid); border-radius: 6px; padding: 5px 12px;
    font: inherit; cursor: pointer; }
  button:hover, select:hover { border-color: var(--muted); }
  button.on { border-color: var(--green); color: var(--green); }
  label { color: var(--ink2); display: inline-flex; gap: 6px; align-items: center; }
  input[type=range] { accent-color: var(--blue); width: 120px; }
  #info { color: var(--ink2); font-variant-numeric: tabular-nums; }
  #diffpct { color: var(--green); font-variant-numeric: tabular-nums; }
  #tlwrap { margin: 4px 20px 8px; cursor: ew-resize; touch-action: none;
            background: var(--surface); border: 1px solid var(--grid);
            border-radius: 8px; padding: 4px 6px; }
  #tl { display: block; width: 100%; height: 76px; }
  #tlmeta { display: flex; justify-content: space-between; padding: 0 22px 12px;
            color: var(--muted); font-size: 12px;
            font-variant-numeric: tabular-nums; }
  footer { padding: 0 20px 16px; color: var(--muted); font-size: 12px; }
  kbd { background: var(--surface); border: 1px solid var(--grid);
        border-radius: 4px; padding: 0 5px; font-family: inherit; }
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <p id="meta"></p>
</header>
<div id="stage"><div id="frameWrap">
  <img id="frame" alt="captured state frame"><canvas id="diff"></canvas>
</div></div>
<div id="controls">
  <button id="btnPrev" title="previous state (←)">←</button>
  <button id="btnNext" title="next state (→)">→</button>
  <button id="btnDiff" title="toggle diff mode (D)">Diff</button>
  <button id="btnFlash" title="toggle flashing (F)">Flash</button>
  <label>vs <select id="refsel">
    <option value="prev" selected>previous state</option>
    <option value="first">first state</option>
    <option value="pinned">pinned state</option>
  </select></label>
  <button id="btnPin" title="pin current state as diff reference (P)">Pin</button>
  <label>sensitivity <input type="range" id="thr" min="4" max="80" value="24"></label>
  <span id="diffpct"></span>
</div>
<div id="tlwrap"><svg id="tl" viewBox="0 0 1000 76" preserveAspectRatio="none"
  xmlns="http://www.w3.org/2000/svg"></svg></div>
<div id="tlmeta"><span id="info"></span><span id="scrubt"></span></div>
<footer>Scrub or click the timeline (orange ticks = captured states, shaded =
change bursts, blue = frame difference). <kbd>←</kbd><kbd>→</kbd> step ·
<kbd>D</kbd> diff · <kbd>F</kbd> flash · <kbd>P</kbd> pin reference.
Diff mode paints every changed pixel bright green over the dimmed frame.</footer>
<script>
'use strict';
const DATA = __DATA__;
const $ = id => document.getElementById(id);
const S = DATA.states, N = S.length, DUR = DATA.video.duration_s;
const img = $('frame'), cv = $('diff'), ctx = cv.getContext('2d');
let cur = 0, diffOn = false, flashOn = true, refMode = 'prev', pinned = 0;
let thr = 24, ready = false;

$('meta').textContent = \`\${DATA.video.width}×\${DATA.video.height} · \` +
  \`\${DUR.toFixed(2)}s · \${N} captured states · \` +
  \`\${DATA.bursts.length} change bursts · diff threshold \${DATA.threshold}\`;

const imgs = S.map(s => { const m = new Image(); m.src = s.src; return m; });
Promise.all(imgs.map(m => m.decode().catch(() => {}))).then(() => {
  ready = true; render();
});

const fmtT = t => t.toFixed(3) + 's';

function refIdx() {
  if (refMode === 'first') return cur > 0 ? 0 : -1;
  if (refMode === 'pinned') return pinned !== cur ? pinned : -1;
  return cur - 1;
}

function grab(m, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(m, 0, 0, w, h);
  return x.getImageData(0, 0, w, h).data;
}

function drawDiff() {
  const b = imgs[cur], ri = refIdx();
  const w = b.naturalWidth, h = b.naturalHeight;
  cv.width = w; cv.height = h;
  ctx.clearRect(0, 0, w, h);
  if (ri < 0) { $('diffpct').textContent = 'no reference state'; return; }
  const da = grab(imgs[ri], w, h), db = grab(b, w, h);
  const n = w * h, mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const d = Math.max(Math.abs(da[p] - db[p]), Math.abs(da[p + 1] - db[p + 1]),
                       Math.abs(da[p + 2] - db[p + 2]));
    if (d > thr) { mask[i] = 1; count++; }
  }
  const mx = new Uint8Array(n), my = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const i = r + x;
      if (mask[i] || (x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1])) mx[i] = 1;
    }
  }
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const i = r + x;
      if (mx[i] || (y > 0 && mx[i - w]) || (y < h - 1 && mx[i + w])) my[i] = 1;
    }
  }
  const out = ctx.createImageData(w, h), od = out.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (my[i]) { od[p] = 0; od[p + 1] = 255; od[p + 2] = 136; od[p + 3] = 235; }
  }
  ctx.putImageData(out, 0, 0);
  $('diffpct').textContent =
    (100 * count / n).toFixed(2) + '% of pixels changed vs t=' + fmtT(S[ri].t);
}

function buildTimeline() {
  const W = 1000, H = 76, parts = [];
  const ymax = Math.max(1e-6, ...DATA.curve.map(c => c[1]));
  DATA.bursts.forEach(b => {
    const x0 = b.s / DUR * W, x1 = Math.max(b.e / DUR * W, x0 + 1.4);
    parts.push(\`<rect x="\${x0.toFixed(1)}" y="0" width="\${(x1 - x0).toFixed(1)}" \` +
      \`height="\${H}" fill="#3987e5" opacity="0.16"/>\`);
  });
  const pts = DATA.curve.map(c =>
    \`\${(c[0] / DUR * W).toFixed(1)},\${(H - 8 - c[1] / ymax * (H - 24)).toFixed(1)}\`
  ).join(' ');
  parts.push(\`<polyline points="\${pts}" fill="none" stroke="#3987e5" \` +
    \`stroke-width="1.2" opacity="0.9" vector-effect="non-scaling-stroke"/>\`);
  S.forEach((s, i) => {
    const x = (s.t / DUR * W).toFixed(1);
    parts.push(\`<line class="tick" data-i="\${i}" x1="\${x}" y1="\${H - 16}" \` +
      \`x2="\${x}" y2="\${H}" stroke="#d95926" stroke-width="3.5" \` +
      \`vector-effect="non-scaling-stroke"><title>state \${i + 1} · \` +
      \`t=\${fmtT(s.t)}</title></line>\`);
  });
  parts.push(\`<line id="playhead" x1="0" y1="0" x2="0" y2="\${H}" \` +
    \`stroke="#ffffff" stroke-width="1.5" vector-effect="non-scaling-stroke"/>\`);
  $('tl').innerHTML = parts.join('');
}

function render() {
  if (!ready) return;
  const s = S[cur];
  img.src = s.src;
  $('info').textContent = \`state \${cur + 1}/\${N} · t=\${fmtT(s.t)} · \` +
    \`held \${Math.round((s.held_until - s.t) * 1000)}ms · \${s.why}\`;
  document.querySelectorAll('.tick').forEach(el =>
    el.setAttribute('stroke', +el.dataset.i === cur ? '#ffffff' : '#d95926'));
  const x = (s.t / DUR * 1000).toFixed(1);
  const ph = $('playhead');
  ph.setAttribute('x1', x); ph.setAttribute('x2', x);
  cv.style.display = diffOn ? 'block' : 'none';
  img.style.opacity = diffOn ? 0.32 : 1;
  $('btnDiff').classList.toggle('on', diffOn);
  $('btnFlash').classList.toggle('on', flashOn);
  $('frameWrap').classList.toggle('flashing', diffOn && flashOn);
  if (diffOn) drawDiff(); else $('diffpct').textContent = '';
}

function step(d) { cur = Math.min(N - 1, Math.max(0, cur + d)); render(); }
function toggleDiff() { diffOn = !diffOn; render(); }

$('btnPrev').onclick = () => step(-1);
$('btnNext').onclick = () => step(1);
$('btnDiff').onclick = toggleDiff;
$('btnFlash').onclick = () => { flashOn = !flashOn; render(); };
$('btnPin').onclick = () => {
  pinned = cur; refMode = 'pinned'; $('refsel').value = 'pinned'; render();
};
$('refsel').onchange = e => { refMode = e.target.value; render(); };
$('thr').oninput = e => { thr = +e.target.value; if (diffOn) drawDiff(); };

const tlwrap = $('tlwrap');
let scrubbing = false;
function scrubTo(ev) {
  const r = tlwrap.getBoundingClientRect();
  const t = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1) * DUR;
  $('scrubt').textContent = 'scrub ' + fmtT(t);
  let i = 0;
  S.forEach((s, k) => { if (s.t <= t) i = k; });
  if (i !== cur) { cur = i; render(); }
}
tlwrap.addEventListener('pointerdown', e => {
  scrubbing = true; tlwrap.setPointerCapture(e.pointerId); scrubTo(e);
});
tlwrap.addEventListener('pointermove', e => { if (scrubbing) scrubTo(e); });
tlwrap.addEventListener('pointerup', () => { scrubbing = false; });

addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'd' || e.key === 'D') toggleDiff();
  else if (e.key === 'f' || e.key === 'F') { flashOn = !flashOn; render(); }
  else if (e.key === 'p' || e.key === 'P') $('btnPin').onclick();
});

buildTimeline();
render();
</script>
</body>
</html>
`;

function rounded(value, places) {
  return Number(value.toFixed(places));
}

async function writeVisualizer(
  outDir,
  meta,
  frames,
  bursts,
  states,
  threshold,
  frameFiles,
) {
  const sizes = await Promise.all(frameFiles.map((file) => stat(file)));
  const total = sizes.reduce((sum, item) => sum + item.size, 0);
  const embed = total <= 25 * 1024 * 1024;
  const contents = embed
    ? await Promise.all(frameFiles.map((file) => readFile(file)))
    : [];
  const visualizerStates = states.map((state, index) => {
    const heldUntil =
      index + 1 < states.length
        ? states[index + 1].frame.t
        : meta.duration_s;
    const filename = path.basename(frameFiles[index]);
    return {
      t: rounded(state.frame.t, 4),
      held_until: rounded(heldUntil, 4),
      why: state.why,
      file: filename,
      src: embed
        ? `data:image/png;base64,${contents[index].toString("base64")}`
        : `frames/${filename}`,
    };
  });
  const duration = frames.at(-1).t || 1;
  const buckets = new Map();
  for (const frame of frames) {
    const bucket = Math.min(
      Math.floor((frame.t / duration) * 1500),
      1499,
    );
    if (!buckets.has(bucket) || frame.ydif > buckets.get(bucket)[1]) {
      buckets.set(bucket, [frame.t, frame.ydif]);
    }
  }
  const curve = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, [time, difference]]) => [
      rounded(time, 3),
      rounded(difference, 4),
    ]);
  const data = {
    video: {
      width: meta.width,
      height: meta.height,
      duration_s: meta.duration_s,
    },
    threshold: rounded(threshold, 3),
    states: visualizerStates,
    bursts: bursts.map((burst) => ({
      s: rounded(burst.start.t, 3),
      e: rounded(burst.end.t, 3),
      peak: rounded(burst.peak.ydif, 2),
    })),
    curve,
  };
  const title = `Contact sheet — ${path.basename(meta.path)}`;
  const html = VISUALIZER_TEMPLATE.replaceAll("__TITLE__", title).replace(
    "__DATA__",
    JSON.stringify(data),
  );
  await writeFile(path.join(outDir, "visualizer.html"), html);
  if (!embed) {
    console.log(
      `frames total ${Math.floor(total / 1048576)}MB > 25MB: visualizer references frames/ by path — serve the folder (for example, npx serve .) for diff mode`,
    );
  }
  return embed;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

async function writeOutputs({
  outDir,
  meta,
  frames,
  bursts,
  states,
  dropped,
  threshold,
  frameFiles,
  sheet,
  transitions,
  pixelThreshold,
  diffSheet,
  maxFrames,
  frameWidth,
  frameHeight,
}) {
  await writeFile(
    path.join(outDir, "diff.csv"),
    csv([
      ["frame", "pts_time_s", "ydif"],
      ...frames.map((frame) => [
        frame.n,
        frame.t.toFixed(4),
        frame.ydif.toFixed(4),
      ]),
    ]),
  );
  await writeFile(
    path.join(outDir, "transitions.csv"),
    csv([
      [
        "from_state",
        "to_state",
        "from_time_s",
        "to_time_s",
        "elapsed_s",
        "changed_pixels",
        "total_pixels",
        "changed_pct",
        "mean_abs_rgb",
        "max_channel_delta",
        "status",
        "bbox_x",
        "bbox_y",
        "bbox_width",
        "bbox_height",
        "file",
      ],
      ...transitions.map((transition) => [
        transition.from_state,
        transition.to_state,
        transition.from_t_s.toFixed(4),
        transition.to_t_s.toFixed(4),
        transition.elapsed_s.toFixed(4),
        transition.changed_pixels,
        transition.total_pixels,
        transition.changed_pct.toFixed(6),
        transition.mean_abs_rgb.toFixed(6),
        transition.max_channel_delta,
        transition.status,
        transition.bbox?.x ?? "",
        transition.bbox?.y ?? "",
        transition.bbox?.width ?? "",
        transition.bbox?.height ?? "",
        transition.file ?? "",
      ]),
    ]),
  );

  const noChangeCount = transitions.filter(
    (transition) => transition.status === "NO VISIBLE CHANGE",
  ).length;
  const tinyChangeCount = transitions.filter(
    (transition) => transition.status === "TINY CHANGE",
  ).length;
  const lines = [
    `# Contact sheet — ${path.basename(meta.path)}`,
    "",
    `${meta.width}×${meta.height}, ${meta.duration_s.toFixed(2)}s, ${
      frames.length
    } frames (${meta.r_frame_rate} nominal). Diff threshold ${formatGeneral(
      threshold,
    )} (YDIF, 0–255 scale).`,
    "",
    `**${bursts.length} change bursts** → **${states.length} captured visual states**${
      dropped
        ? ` (${dropped} smaller bursts dropped by --max-frames; see diff.csv)`
        : ""
    }.`,
    "",
    "## Read these first",
    "",
    "1. `report.md` — locate state numbers/timestamps and suspicious transitions.",
  ];
  if (transitions.length > 0) {
    lines.push(
      "2. `diff-contact-sheet.png` — scan every consecutive-state diff in time order.",
      "3. Open the matching `diffs/S...png` triptych for full-size previous, current, and highlighted-diff panels. Green highlights are dilated one pixel around pixels that exceeded the RGB threshold; a yellow box calls out tiny changes.",
      "",
      `Static comparisons use max-channel RGB delta > ${pixelThreshold} at the ${frameWidth}px extracted-frame width. **${noChangeCount} no-visible-change** and **${tinyChangeCount} tiny-change** transitions are labeled explicitly. A no-visible-change result means the two captured images match at this threshold; an input/history event may still have occurred.`,
    );
  } else {
    lines.push(
      "No consecutive captured states exist, so no static transition images or `diff-contact-sheet.png` were generated.",
    );
  }
  lines.push(
    "",
    `Output is bounded by \`--max-frames ${maxFrames}\`: at most ${Math.max(
      0,
      maxFrames - 1,
    )} consecutive-state diff triptychs. ${
      dropped
        ? `${dropped} lower-signal bursts were omitted before comparison.`
        : "No detected bursts were omitted."
    }`,
    "",
    "## Change bursts",
    "",
    "| # | start | end | duration | peak YDIF | changed frames |",
    "|---|-------|-----|----------|-----------|----------------|",
  );
  bursts.forEach((burst, index) => {
    lines.push(
      `| ${index + 1} | ${burst.start.t.toFixed(
        3,
      )}s | ${burst.end.t.toFixed(3)}s | ${(
        burst.duration_s * 1000
      ).toFixed(0)}ms | ${burst.peak.ydif.toFixed(2)} | ${
        burst.hot_frames
      } |`,
    );
  });
  lines.push(
    "",
    "## Captured states",
    "",
    "| state | time | held until | held for | file |",
    "|-------|------|------------|----------|------|",
  );
  states.forEach((state, index) => {
    const time = state.frame.t;
    const nextTime =
      index + 1 < states.length ? states[index + 1].frame.t : meta.duration_s;
    const filename = frameFiles[index] ? path.basename(frameFiles[index]) : "?";
    lines.push(
      `| ${index} | ${time.toFixed(3)}s | ${nextTime.toFixed(3)}s | ${(
        (nextTime - time) *
        1000
      ).toFixed(0)}ms | frames/${filename} |`,
    );
  });
  lines.push(
    "",
    "## Consecutive-state comparisons",
    "",
    "| comparison | times | changed | mean abs RGB | bbox | status | artifact |",
    "|------------|-------|---------|--------------|------|--------|----------|",
  );
  for (const transition of transitions) {
    const bbox = transition.bbox;
    const bboxText =
      bbox === null
        ? "—"
        : `${bbox.x},${bbox.y} ${bbox.width}×${bbox.height}`;
    lines.push(
      `| S${String(transition.from_state).padStart(3, "0")} → S${String(
        transition.to_state,
      ).padStart(3, "0")} | ${transition.from_t_s.toFixed(
        3,
      )}s → ${transition.to_t_s.toFixed(
        3,
      )}s | ${formatFixed(
        transition.changed_pct,
        4,
      )}% | ${transition.mean_abs_rgb.toFixed(3)} | ${bboxText} | ${
        transition.status
      } | \`${transition.file ?? "—"}\` |`,
    );
  }
  lines.push("", "## Files", "");
  if (transitions.length > 0) {
    lines.push(
      "- `diff-contact-sheet.png` — chronological overview of highlighted differences",
      "- `diffs/` — one labeled previous/current/highlight triptych per state transition",
    );
  }
  lines.push(
    "- `transitions.csv` — thresholded RGB metrics and bounding boxes (header only when no transitions were captured)",
    "- `contact-sheet.png` — all states tiled, timestamps burned in",
    "- `frames/` — individual state frames (clean, no label — diffable)",
    "- `timeline.svg` — difference over time with bursts and state markers",
    "- `diff.csv` — raw per-video-frame YDIF data",
    "- `meta.json` — machine-readable summary",
    "- `visualizer.html` — optional interactive scrub/diff UI",
    "",
  );
  await writeFile(path.join(outDir, "report.md"), lines.join("\n"));

  await writeFile(
    path.join(outDir, "meta.json"),
    JSON.stringify(
      {
        video: meta,
        threshold,
        bursts: bursts.map((burst) => ({
          start_s: burst.start.t,
          end_s: burst.end.t,
          duration_s: burst.duration_s,
          peak_ydif: burst.peak.ydif,
          sum_ydif: burst.sum,
          hot_frames: burst.hot_frames,
        })),
        states: states.map((state) => ({
          frame: state.frame.n,
          t_s: state.frame.t,
          why: state.why,
        })),
        pixel_diff: {
          threshold: pixelThreshold,
          comparison: "max absolute RGB channel delta > threshold",
          resolution: {
            width: frameWidth,
            height: frameHeight,
          },
          tiny_change_below_pct: 0.05,
        },
        transitions,
        dropped_bursts: dropped,
        limits: {
          max_states: maxFrames,
          max_transition_diffs: Math.max(0, maxFrames - 1),
          dropped_bursts: dropped,
        },
        contact_sheet: sheet,
        diff_contact_sheet: diffSheet,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 18) {
    fail(`Node 18+ is required (found ${process.versions.node})`);
  }
  const options = parseArgs(process.argv.slice(2));
  const video = path.resolve(options.video);
  await access(video).catch(() => fail(`no such file: ${options.video}`));
  const parsedVideo = path.parse(video);
  const outDir = path.resolve(
    options.out ??
      path.join(parsedVideo.dir, `${parsedVideo.name}-contact-sheet`),
  );
  await mkdir(outDir, { recursive: true });

  const capabilities = await checkCapabilities();
  if (!capabilities.hasDrawtext) {
    console.log(
      "warning: ffmpeg lacks drawtext; image labels are only in filenames/report",
    );
  }
  console.log(
    `render jobs ${options.jobs} (${
      options.jobsExplicit
        ? "from --jobs"
        : `default from ${logicalCpuCount} logical CPUs`
    })`,
  );
  const meta = await probeMeta(video);
  console.log(`probing diffs (${meta.nb_frames} frames)…`);
  const frames = await frameDiffs(video, options.analysisWidth);
  if (frames.length < 2) {
    fail("video has fewer than 2 frames");
  }

  const nonzero = frames
    .slice(1)
    .filter((frame) => frame.ydif > 0)
    .map((frame) => frame.ydif);
  const threshold =
    options.threshold ?? Math.max(0.2, median(nonzero) * 5);
  console.log(
    `threshold ${threshold.toFixed(3)} (median nonzero YDIF ${median(
      frames.slice(1).map((frame) => frame.ydif),
    ).toFixed(4)})`,
  );
  const bursts = detectBursts(frames, threshold, options.gap);
  const { states, dropped } = pickStates(
    frames,
    bursts,
    options.settle,
    options.maxFrames,
  );
  console.log(
    `${bursts.length} bursts → ${states.length} states${
      dropped ? ` (${dropped} bursts dropped)` : ""
    }`,
  );

  const [frameFiles, sheet] = await Promise.all([
    extractFrames(video, states, outDir, options.thumbWidth),
    buildSheet(video, states, outDir, options.thumbWidth, capabilities),
  ]);
  console.log(
    `measuring ${Math.max(0, states.length - 1)} state transitions…`,
  );
  const { width, height, transitions } = await measureTransitions(
    states,
    frameFiles,
    options.diffPixelThreshold,
  );
  const staticDiffPromise = buildStaticDiffs({
    frameFiles,
    transitions,
    outDir,
    pixelThreshold: options.diffPixelThreshold,
    width,
    height,
    capabilities,
    jobs: options.jobs,
  });
  const [, , staticDiffs] = await Promise.all([
    writeTimelineSvg(
      frames,
      bursts,
      states,
      threshold,
      path.join(outDir, "timeline.svg"),
      `Visual change over time — ${path.basename(video)}`,
    ),
    writeVisualizer(
      outDir,
      meta,
      frames,
      bursts,
      states,
      threshold,
      frameFiles,
    ),
    staticDiffPromise,
  ]);
  console.log(
    `rendered ${staticDiffs.diffFiles.length} static diff triptychs${
      staticDiffs.diffSheet
        ? ` + ${path.basename(staticDiffs.diffSheet)}`
        : ""
    }`,
  );
  await writeOutputs({
    outDir,
    meta,
    frames,
    bursts,
    states,
    dropped,
    threshold,
    frameFiles,
    sheet,
    transitions,
    pixelThreshold: options.diffPixelThreshold,
    diffSheet: staticDiffs.diffSheet,
    maxFrames: options.maxFrames,
    frameWidth: width,
    frameHeight: height,
  });
  if (staticDiffs.diffSheet) {
    console.log(
      `done → read ${path.join(
        outDir,
        "report.md",
      )}, then ${staticDiffs.diffSheet}`,
    );
  } else {
    console.log(
      `done → read ${path.join(
        outDir,
        "report.md",
      )} (no state transitions captured)`,
    );
  }
}

main().catch((error) => {
  if (error.message !== "__CONTACT_SHEET_REPORTED__") {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
});
