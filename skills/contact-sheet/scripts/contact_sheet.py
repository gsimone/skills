#!/usr/bin/env python3
"""Video contact-sheet harness.

Turns a screen recording into analyzable visual-change data:
  - diff.csv           per-frame luma difference (YDIF) with timestamps
  - timeline.svg       difference-over-time chart with change bursts + state markers
  - frames/            one PNG per detected visual state (timestamped filenames)
  - contact-sheet.png  tiled sheet of those frames
  - diffs/             labeled previous/current/highlight triptychs
  - diff-contact-sheet.png  tiled highlighted state-to-state differences
  - transitions.csv    state-to-state pixel-change metrics
  - report.md          bursts, states, durations, stats — the analysis entry point
  - meta.json          machine-readable version of everything

Pure python stdlib + ffmpeg/ffprobe on PATH. No ImageMagick.
"""

import argparse
import base64
import csv
import functools
import json
import math
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------- ffmpeg io


def run(cmd, **kw):
    res = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if res.returncode != 0:
        sys.exit(f"command failed: {' '.join(map(str, cmd))}\n{res.stderr[-2000:]}")
    return res.stdout


def run_bytes(cmd, **kw):
    res = subprocess.run(cmd, capture_output=True, **kw)
    if res.returncode != 0:
        stderr = res.stderr.decode(errors="replace")
        sys.exit(f"command failed: {' '.join(map(str, cmd))}\n{stderr[-2000:]}")
    return res.stdout


def lavfi_escape(path):
    # escape for use inside movie=... filter argument
    out = str(path)
    for ch in ("\\", "'", ":", ",", ";", "[", "]"):
        out = out.replace(ch, "\\" + ch)
    return out


def probe_meta(video):
    out = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(video),
    ])
    data = json.loads(out)
    vstream = next(s for s in data["streams"] if s.get("codec_type") == "video")
    return {
        "path": str(video),
        "duration_s": float(data["format"]["duration"]),
        "width": int(vstream["width"]),
        "height": int(vstream["height"]),
        "nb_frames": int(vstream.get("nb_frames", 0)),
        "r_frame_rate": vstream.get("r_frame_rate", ""),
    }


def frame_diffs(video, analysis_width):
    """Per-frame (pts_time, YDIF): mean abs luma delta vs previous frame, 0–255 scale."""
    graph = f"movie={lavfi_escape(video)},scale={analysis_width}:-2,signalstats"
    out = run([
        "ffprobe", "-v", "error", "-f", "lavfi", "-i", graph,
        # pts_time on ffmpeg>=5, pkt_pts_time on 4.x
        "-show_entries",
        "frame=pts_time,pkt_pts_time,best_effort_timestamp_time"
        ":frame_tags=lavfi.signalstats.YDIF",
        "-print_format", "json",
    ])
    frames = []
    for i, fr in enumerate(json.loads(out)["frames"]):
        t = fr.get("pts_time") or fr.get("pkt_pts_time") \
            or fr.get("best_effort_timestamp_time")
        frames.append({
            "n": i,
            "t": float(t),
            "ydif": float(fr.get("tags", {}).get("lavfi.signalstats.YDIF", 0.0)),
        })
    if frames:
        frames[0]["ydif"] = 0.0  # first frame has no predecessor
    return frames


@functools.lru_cache(maxsize=1)
def has_drawtext():
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"],
                         capture_output=True, text=True)
    return "drawtext" in out.stdout


@functools.lru_cache(maxsize=1)
def find_font():
    for cand in (
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Monaco.ttf",
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ):
        if Path(cand).exists():
            return cand
    return None


def drawtext_escape(text):
    return (str(text).replace("\\", "\\\\").replace("'", "\\'")
            .replace(":", "\\:").replace("%", "\\%"))


def drawtext(text, fontsize, y, color="white"):
    font = find_font()
    fontsrc = f"fontfile={lavfi_escape(font)}:" if font else ""
    return (
        "drawtext=" + fontsrc + f"text='{drawtext_escape(text)}':"
        f"fontsize={fontsize}:fontcolor={color}:x=12:y={y}"
    )


# ------------------------------------------------------------- burst logic


def detect_bursts(frames, threshold, gap_s):
    """Group above-threshold frames into change bursts; a lull shorter than
    gap_s does not split a burst."""
    bursts = []
    cur = None
    last_hot_t = None
    for fr in frames:
        if fr["ydif"] >= threshold:
            if cur is None:
                cur = {"start": fr, "end": fr, "peak": fr, "sum": 0.0, "hot_frames": 0}
            cur["end"] = fr
            cur["sum"] += fr["ydif"]
            cur["hot_frames"] += 1
            if fr["ydif"] > cur["peak"]["ydif"]:
                cur["peak"] = fr
            last_hot_t = fr["t"]
        elif cur is not None and last_hot_t is not None and fr["t"] - last_hot_t > gap_s:
            bursts.append(cur)
            cur = None
    if cur is not None:
        bursts.append(cur)
    for b in bursts:
        b["duration_s"] = b["end"]["t"] - b["start"]["t"]
    return bursts


def pick_states(frames, bursts, settle_frames, max_frames):
    """A visual state = the settled frame just after each burst, plus frame 0.
    Returns (states, dropped_burst_count)."""
    picks = {0: {"frame": frames[0], "why": "initial"}}
    ranked = sorted(bursts, key=lambda b: b["sum"], reverse=True)
    dropped = max(0, len(ranked) - (max_frames - 1))
    for b in ranked[: max_frames - 1]:
        idx = min(b["end"]["n"] + settle_frames, len(frames) - 1)
        picks[idx] = {"frame": frames[idx], "why": f"after burst @{b['start']['t']:.2f}s"}
    states = [picks[k] for k in sorted(picks)]
    return states, dropped


# --------------------------------------------------------------- extraction


def extract_frames(video, states, out_dir, thumb_width):
    """Clean frames, no label burn-in — the visualizer diffs these pixel-for-pixel."""
    ns = [s["frame"]["n"] for s in states]
    select = "+".join(f"eq(n\\,{n})" for n in ns)
    vf = [f"select='{select}'", f"scale={thumb_width}:-2"]
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    for old_frame in frames_dir.glob("*.png"):
        old_frame.unlink()
    run([
        "ffmpeg", "-y", "-v", "error", "-i", str(video),
        "-vf", ",".join(vf), "-vsync", "vfr",
        str(frames_dir / "tmp_%04d.png"),
    ])
    produced = sorted(frames_dir.glob("tmp_*.png"))
    named = []
    for path, st in zip(produced, states):
        t = st["frame"]["t"]
        new = frames_dir / f"{st['frame']['n']:05d}_t{t:07.3f}s.png"
        path.rename(new)
        named.append(new)
    return named


def build_sheet(video, states, out_dir, thumb_width):
    """One pass straight from the source so drawtext sees the true pts."""
    ns = [s["frame"]["n"] for s in states]
    select = "+".join(f"eq(n\\,{n})" for n in ns)
    cols = max(1, math.ceil(math.sqrt(len(ns) * 16 / 9)))  # bias wide for wide thumbs
    rows = math.ceil(len(ns) / cols)
    vf = [f"select='{select}'", f"scale={thumb_width}:-2"]
    if has_drawtext():
        font = find_font()
        fontsrc = f"fontfile={font}:" if font else ""
        vf.append(
            "drawtext=" + fontsrc +
            "text='%{pts\\:hms}':fontsize=28:fontcolor=white:borderw=3:"
            "bordercolor=black:x=12:y=h-th-12"
        )
    vf.append(f"tile={cols}x{rows}:padding=6:margin=8:color=0xfcfcfb")
    sheet = out_dir / "contact-sheet.png"
    run([
        "ffmpeg", "-y", "-v", "error", "-i", str(video),
        "-vf", ",".join(vf), "-vsync", "vfr", "-frames:v", "1", str(sheet),
    ])
    return sheet


def probe_image_size(path):
    out = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", str(path),
    ])
    stream = json.loads(out)["streams"][0]
    return int(stream["width"]), int(stream["height"])


def decode_rgb_frames(frame_files):
    """Decode all clean state PNGs once. Returns width, height, RGB byte views."""
    width, height = probe_image_size(frame_files[0])
    raw = run_bytes([
        "ffmpeg", "-v", "error", "-framerate", "1", "-pattern_type", "glob",
        "-i", str(frame_files[0].parent / "*.png"),
        "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ])
    frame_size = width * height * 3
    expected = frame_size * len(frame_files)
    if len(raw) != expected:
        sys.exit(
            f"decoded state frames occupied {len(raw)} bytes; expected {expected}. "
            "Remove unrelated PNGs from frames/ and retry."
        )
    data = memoryview(raw)
    decoded = [
        data[i * frame_size:(i + 1) * frame_size]
        for i in range(len(frame_files))
    ]
    return width, height, decoded


def measure_transitions(states, frame_files, pixel_threshold):
    """Compare consecutive state PNGs using max-channel RGB change per pixel."""
    width, height, decoded = decode_rgb_frames(frame_files)
    pixel_count = width * height
    transitions = []
    for state_index in range(1, len(states)):
        previous = decoded[state_index - 1]
        current = decoded[state_index]
        changed = 0
        delta_sum = 0
        max_delta = 0
        min_x, min_y = width, height
        max_x = max_y = -1
        for byte_index in range(0, len(previous), 3):
            dr = abs(previous[byte_index] - current[byte_index])
            dg = abs(previous[byte_index + 1] - current[byte_index + 1])
            db = abs(previous[byte_index + 2] - current[byte_index + 2])
            delta_sum += dr + dg + db
            pixel_delta = max(dr, dg, db)
            max_delta = max(max_delta, pixel_delta)
            if pixel_delta > pixel_threshold:
                changed += 1
                pixel_index = byte_index // 3
                y, x = divmod(pixel_index, width)
                min_x, min_y = min(min_x, x), min(min_y, y)
                max_x, max_y = max(max_x, x), max(max_y, y)
        changed_pct = changed / pixel_count * 100
        if changed == 0:
            status = "NO VISIBLE CHANGE"
            bbox = None
        else:
            status = "TINY CHANGE" if changed_pct < 0.05 else "CHANGED"
            bbox = {
                "x": min_x, "y": min_y,
                "width": max_x - min_x + 1, "height": max_y - min_y + 1,
            }
        transitions.append({
            "from_state": state_index - 1,
            "to_state": state_index,
            "from_t_s": states[state_index - 1]["frame"]["t"],
            "to_t_s": states[state_index]["frame"]["t"],
            "elapsed_s": (
                states[state_index]["frame"]["t"]
                - states[state_index - 1]["frame"]["t"]
            ),
            "changed_pixels": changed,
            "total_pixels": pixel_count,
            "changed_pct": changed_pct,
            "mean_abs_rgb": delta_sum / (pixel_count * 3),
            "max_channel_delta": max_delta,
            "bbox": bbox,
            "status": status,
        })
    return width, height, transitions


def transition_filename(transition):
    return (
        f"S{transition['from_state']:03d}-to-S{transition['to_state']:03d}"
        f"_t{transition['from_t_s']:07.3f}s-to-t{transition['to_t_s']:07.3f}s.png"
    )


def render_transition_diff(previous, current, transition, out_path, width,
                           height, pixel_threshold):
    """Render previous | current | dimmed-current-with-green-diff."""
    threshold_expr = (
        f"lut=y='if(gt(val\\,{pixel_threshold})\\,255\\,0)'"
    )
    status = transition["status"]
    bbox = transition["bbox"]
    bbox_text = (
        "none"
        if bbox is None
        else (
            f"x{bbox['x']} y{bbox['y']} "
            f"{bbox['width']}x{bbox['height']}"
        )
    )
    previous_header = (
        f"PREVIOUS  S{transition['from_state']:03d}  "
        f"t={transition['from_t_s']:.3f}s"
    )
    current_header = (
        f"CURRENT  S{transition['to_state']:03d}  "
        f"t={transition['to_t_s']:.3f}s"
    )
    diff_header = (
        f"DIFF  S{transition['from_state']:03d} -> "
        f"S{transition['to_state']:03d}  green > {pixel_threshold} RGB (+1px)"
    )
    metric_text = (
        f"{status} | changed {transition['changed_pct']:.4f} pct | "
        f"mean abs RGB {transition['mean_abs_rgb']:.3f} | bbox {bbox_text}"
    )
    elapsed_text = f"elapsed {transition['elapsed_s'] * 1000:.0f} ms"
    filters = [
        "[0:v]format=rgb24,split=2[previous_panel][previous_diff]",
        "[1:v]format=rgb24,split=3[current_panel][current_diff][dim_source]",
        "[previous_diff][current_diff]blend=all_mode=difference,"
        "format=gbrp[delta]",
        "[delta]extractplanes=r+g+b[delta_r][delta_g][delta_b]",
        "[delta_r][delta_g]blend=all_mode=lighten[delta_rg]",
        f"[delta_rg][delta_b]blend=all_mode=lighten,{threshold_expr},"
        "dilation[display_mask]",
        f"color=c=0x00ff88:s={width}x{height},format=rgb24[green]",
        "[green][display_mask]alphamerge[highlight]",
        "[dim_source]eq=brightness=-0.35:saturation=0.45[dimmed]",
        "[dimmed][highlight]overlay=format=rgb[overlay]",
    ]
    if status == "TINY CHANGE" and bbox is not None:
        margin = 8
        box_x = max(0, bbox["x"] - margin)
        box_y = max(0, bbox["y"] - margin)
        box_width = min(width - box_x, bbox["width"] + margin * 2)
        box_height = min(height - box_y, bbox["height"] + margin * 2)
        filters.append(
            f"[overlay]drawbox=x={box_x}:y={box_y}:w={box_width}:h={box_height}:"
            "color=yellow@0.95:t=2[boxed_overlay]"
        )
        overlay_source = "boxed_overlay"
    else:
        overlay_source = "overlay"

    if has_drawtext():
        filters += [
            f"[previous_panel]pad=iw:ih+76:0:42:color=0x111111,"
            f"{drawtext(previous_header, 22, 10)},"
            f"{drawtext('reference state', 17, 'h-th-10', '0xb9b9b9')}"
            "[labeled_previous]",
            f"[current_panel]pad=iw:ih+76:0:42:color=0x111111,"
            f"{drawtext(current_header, 22, 10)},"
            f"{drawtext(elapsed_text, 17, 'h-th-10', '0xb9b9b9')}"
            "[labeled_current]",
            f"[{overlay_source}]pad=iw:ih+76:0:42:color=0x111111,"
            f"{drawtext(diff_header, 22, 10)},"
            f"{drawtext(metric_text, 17, 'h-th-10', 'white')}"
            "[labeled_overlay]",
        ]
    else:
        print("warning: ffmpeg lacks drawtext; diff labels are only in filenames/report")
        filters += [
            "[previous_panel]copy[labeled_previous]",
            "[current_panel]copy[labeled_current]",
            f"[{overlay_source}]copy[labeled_overlay]",
        ]
    filters.append(
        "[labeled_previous][labeled_current][labeled_overlay]"
        "hstack=inputs=3[triptych]"
    )
    run([
        "ffmpeg", "-y", "-v", "error", "-i", str(previous), "-i", str(current),
        "-filter_complex", ";".join(filters), "-map", "[triptych]",
        "-frames:v", "1", str(out_path),
    ])


def build_static_diffs(frame_files, states, transitions, out_dir,
                       pixel_threshold, width, height):
    diff_dir = out_dir / "diffs"
    diff_dir.mkdir(parents=True, exist_ok=True)
    for old_diff in diff_dir.glob("*.png"):
        old_diff.unlink()
    diff_files = []
    for transition in transitions:
        filename = transition_filename(transition)
        out_path = diff_dir / filename
        render_transition_diff(
            frame_files[transition["from_state"]],
            frame_files[transition["to_state"]],
            transition,
            out_path,
            width,
            height,
            pixel_threshold,
        )
        transition["file"] = f"diffs/{filename}"
        diff_files.append(out_path)

    sheet = out_dir / "diff-contact-sheet.png"
    if not diff_files:
        if sheet.exists():
            sheet.unlink()
        return diff_files, None
    cols = max(1, math.ceil(math.sqrt(len(diff_files) * 16 / 9)))
    rows = math.ceil(len(diff_files) / cols)
    run([
        "ffmpeg", "-y", "-v", "error", "-framerate", "1",
        "-pattern_type", "glob", "-i", str(diff_dir / "*.png"),
        "-vf", (
            "crop=w=iw/3:h=ih:x=2*iw/3:y=0,scale=480:-2,"
            f"tile={cols}x{rows}:nb_frames={len(diff_files)}:"
            "padding=5:margin=8:color=0x111111"
        ),
        "-frames:v", "1", str(sheet),
    ])
    return diff_files, sheet


# ------------------------------------------------------------------- chart

INK = "#0b0b0b"
INK2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
BASE = "#c3c2b7"
SURFACE = "#fcfcfb"
SERIES = "#2a78d6"      # diff line
SERIES_WASH = "#cde2fb"  # burst spans (same hue, light step)
MARKER = "#eb6834"      # state markers


def timeline_svg(frames, bursts, states, threshold, out_path, title):
    W, H = 1280, 400
    ml, mr, mt, mb = 64, 24, 64, 74
    pw, ph = W - ml - mr, H - mt - mb
    tmax = frames[-1]["t"] or 1.0
    ymax = max(max(f["ydif"] for f in frames), threshold) * 1.08 or 1.0

    def sx(t):
        return ml + t / tmax * pw

    def sy(v):
        return mt + ph - v / ymax * ph

    e = []
    e.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
        f'viewBox="0 0 {W} {H}" font-family="system-ui, -apple-system, sans-serif">'
    )
    e.append(f'<rect width="{W}" height="{H}" fill="{SURFACE}"/>')
    e.append(f'<text x="{ml}" y="26" font-size="16" font-weight="600" fill="{INK}">{title}</text>')
    e.append(
        f'<text x="{ml}" y="44" font-size="12" fill="{INK2}">'
        f'Mean per-frame luma change (YDIF, 0–255) · shaded = change burst · '
        f'ticks = captured visual state</text>'
    )
    # burst spans
    for b in bursts:
        x0, x1 = sx(b["start"]["t"]), sx(b["end"]["t"])
        e.append(
            f'<rect x="{x0:.1f}" y="{mt}" width="{max(x1 - x0, 1.5):.1f}" '
            f'height="{ph}" fill="{SERIES_WASH}" opacity="0.55"/>'
        )
    # gridlines + y ticks
    for i in range(5):
        v = ymax * i / 4
        y = sy(v)
        e.append(f'<line x1="{ml}" y1="{y:.1f}" x2="{ml + pw}" y2="{y:.1f}" stroke="{GRID}" stroke-width="1"/>')
        e.append(
            f'<text x="{ml - 8}" y="{y + 4:.1f}" font-size="11" fill="{MUTED}" '
            f'text-anchor="end" style="font-variant-numeric: tabular-nums">{v:.1f}</text>'
        )
    # x ticks every ~5s
    step = max(1, round(tmax / 8))
    t = 0
    while t <= tmax:
        x = sx(t)
        e.append(
            f'<text x="{x:.1f}" y="{mt + ph + 18}" font-size="11" fill="{MUTED}" '
            f'text-anchor="middle" style="font-variant-numeric: tabular-nums">{t:g}s</text>'
        )
        t += step
    e.append(f'<line x1="{ml}" y1="{mt + ph}" x2="{ml + pw}" y2="{mt + ph}" stroke="{BASE}" stroke-width="1"/>')
    # threshold
    ty = sy(threshold)
    e.append(
        f'<line x1="{ml}" y1="{ty:.1f}" x2="{ml + pw}" y2="{ty:.1f}" '
        f'stroke="{MUTED}" stroke-width="1" stroke-dasharray="4 4"/>'
    )
    e.append(
        f'<text x="{ml + pw}" y="{ty - 5:.1f}" font-size="11" fill="{MUTED}" '
        f'text-anchor="end">threshold {threshold:g}</text>'
    )
    # diff line
    pts = " ".join(f"{sx(f['t']):.1f},{sy(min(f['ydif'], ymax)):.1f}" for f in frames)
    e.append(
        f'<polyline points="{pts}" fill="none" stroke="{SERIES}" '
        f'stroke-width="2" stroke-linejoin="round"/>'
    )
    # state markers
    for s in states:
        x = sx(s["frame"]["t"])
        e.append(
            f'<line x1="{x:.1f}" y1="{mt + ph}" x2="{x:.1f}" y2="{mt + ph + 8}" '
            f'stroke="{MARKER}" stroke-width="2"/>'
        )
    # legend
    ly = H - 26
    e.append(f'<line x1="{ml}" y1="{ly}" x2="{ml + 22}" y2="{ly}" stroke="{SERIES}" stroke-width="2"/>')
    e.append(f'<text x="{ml + 28}" y="{ly + 4}" font-size="12" fill="{INK2}">frame difference</text>')
    e.append(f'<rect x="{ml + 140}" y="{ly - 7}" width="22" height="14" fill="{SERIES_WASH}" opacity="0.55"/>')
    e.append(f'<text x="{ml + 168}" y="{ly + 4}" font-size="12" fill="{INK2}">change burst</text>')
    e.append(f'<line x1="{ml + 268}" y1="{ly - 5}" x2="{ml + 268}" y2="{ly + 5}" stroke="{MARKER}" stroke-width="2"/>')
    e.append(f'<text x="{ml + 276}" y="{ly + 4}" font-size="12" fill="{INK2}">captured state</text>')
    e.append("</svg>")
    out_path.write_text("\n".join(e))


# -------------------------------------------------------------- visualizer

VISUALIZER_TEMPLATE = r"""<!doctype html>
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

$('meta').textContent = `${DATA.video.width}×${DATA.video.height} · ` +
  `${DUR.toFixed(2)}s · ${N} captured states · ` +
  `${DATA.bursts.length} change bursts · diff threshold ${DATA.threshold}`;

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
  // dilate 1px so hairline changes stay visible
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
    parts.push(`<rect x="${x0.toFixed(1)}" y="0" width="${(x1 - x0).toFixed(1)}" ` +
      `height="${H}" fill="#3987e5" opacity="0.16"/>`);
  });
  const pts = DATA.curve.map(c =>
    `${(c[0] / DUR * W).toFixed(1)},${(H - 8 - c[1] / ymax * (H - 24)).toFixed(1)}`
  ).join(' ');
  parts.push(`<polyline points="${pts}" fill="none" stroke="#3987e5" ` +
    `stroke-width="1.2" opacity="0.9" vector-effect="non-scaling-stroke"/>`);
  S.forEach((s, i) => {
    const x = (s.t / DUR * W).toFixed(1);
    parts.push(`<line class="tick" data-i="${i}" x1="${x}" y1="${H - 16}" ` +
      `x2="${x}" y2="${H}" stroke="#d95926" stroke-width="3.5" ` +
      `vector-effect="non-scaling-stroke"><title>state ${i + 1} · ` +
      `t=${fmtT(s.t)}</title></line>`);
  });
  parts.push(`<line id="playhead" x1="0" y1="0" x2="0" y2="${H}" ` +
    `stroke="#ffffff" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`);
  $('tl').innerHTML = parts.join('');
}

function render() {
  if (!ready) return;
  const s = S[cur];
  img.src = s.src;
  $('info').textContent = `state ${cur + 1}/${N} · t=${fmtT(s.t)} · ` +
    `held ${Math.round((s.held_until - s.t) * 1000)}ms · ${s.why}`;
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
"""


def write_visualizer(out_dir, meta, frames, bursts, states, threshold, frame_files):
    """Self-contained scrub/diff page. Frames embed as data URIs so diff mode's
    canvas reads work from file:// (embedding skipped past 25MB, reported)."""
    total = sum(f.stat().st_size for f in frame_files)
    embed = total <= 25 * 1024 * 1024
    st = []
    for i, (s, f) in enumerate(zip(states, frame_files)):
        held_until = (states[i + 1]["frame"]["t"] if i + 1 < len(states)
                      else meta["duration_s"])
        src = ("data:image/png;base64," + base64.b64encode(f.read_bytes()).decode()
               if embed else f"frames/{f.name}")
        st.append({
            "t": round(s["frame"]["t"], 4), "held_until": round(held_until, 4),
            "why": s["why"], "file": f.name, "src": src,
        })
    dur = frames[-1]["t"] or 1.0
    buckets = {}
    for fr in frames:  # downsample to ≤1500 points, keeping each bucket's spike
        b = min(int(fr["t"] / dur * 1500), 1499)
        if b not in buckets or fr["ydif"] > buckets[b][1]:
            buckets[b] = (fr["t"], fr["ydif"])
    curve = [[round(t, 3), round(d, 4)] for b, (t, d) in sorted(buckets.items())]
    data = {
        "video": {k: meta[k] for k in ("width", "height", "duration_s")},
        "threshold": round(threshold, 3),
        "states": st,
        "bursts": [{"s": round(b["start"]["t"], 3), "e": round(b["end"]["t"], 3),
                    "peak": round(b["peak"]["ydif"], 2)} for b in bursts],
        "curve": curve,
    }
    html = (VISUALIZER_TEMPLATE
            .replace("__TITLE__", f"Contact sheet — {Path(meta['path']).name}")
            .replace("__DATA__", json.dumps(data, separators=(",", ":"))))
    (out_dir / "visualizer.html").write_text(html)
    if not embed:
        print(f"frames total {total // 1048576}MB > 25MB: visualizer references "
              "frames/ by path — serve the folder (python3 -m http.server) "
              "for diff mode to work")
    return embed


# ------------------------------------------------------------------ report


def write_outputs(out_dir, meta, frames, bursts, states, dropped, threshold,
                  frame_files, sheet, transitions, pixel_threshold, diff_sheet,
                  max_frames):
    with open(out_dir / "diff.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["frame", "pts_time_s", "ydif"])
        for fr in frames:
            w.writerow([fr["n"], f"{fr['t']:.4f}", f"{fr['ydif']:.4f}"])

    with open(out_dir / "transitions.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([
            "from_state", "to_state", "from_time_s", "to_time_s", "elapsed_s",
            "changed_pixels", "total_pixels", "changed_pct", "mean_abs_rgb",
            "max_channel_delta", "status", "bbox_x", "bbox_y", "bbox_width",
            "bbox_height", "file",
        ])
        for transition in transitions:
            bbox = transition["bbox"] or {}
            w.writerow([
                transition["from_state"], transition["to_state"],
                f"{transition['from_t_s']:.4f}", f"{transition['to_t_s']:.4f}",
                f"{transition['elapsed_s']:.4f}", transition["changed_pixels"],
                transition["total_pixels"], f"{transition['changed_pct']:.6f}",
                f"{transition['mean_abs_rgb']:.6f}",
                transition["max_channel_delta"], transition["status"],
                bbox.get("x", ""), bbox.get("y", ""), bbox.get("width", ""),
                bbox.get("height", ""), transition.get("file", ""),
            ])

    no_change_count = sum(
        transition["status"] == "NO VISIBLE CHANGE"
        for transition in transitions
    )
    tiny_change_count = sum(
        transition["status"] == "TINY CHANGE"
        for transition in transitions
    )
    lines = [
        f"# Contact sheet — {Path(meta['path']).name}",
        "",
        f"{meta['width']}×{meta['height']}, {meta['duration_s']:.2f}s, "
        f"{len(frames)} frames ({meta['r_frame_rate']} nominal). "
        f"Diff threshold {threshold:g} (YDIF, 0–255 scale).",
        "",
        f"**{len(bursts)} change bursts** → **{len(states)} captured visual states**"
        + (f" ({dropped} smaller bursts dropped by --max-frames; see diff.csv)" if dropped else "")
        + ".",
        "",
        "## Read these first",
        "",
        "1. `report.md` — locate state numbers/timestamps and suspicious transitions.",
    ]
    if transitions:
        lines += [
            "2. `diff-contact-sheet.png` — scan every consecutive-state diff in time order.",
            "3. Open the matching `diffs/S...png` triptych for full-size previous, current, "
            "and highlighted-diff panels. Green highlights are dilated one pixel around "
            "pixels that exceeded the RGB threshold; a yellow box calls out tiny changes.",
            "",
            f"Static comparisons use max-channel RGB delta > {pixel_threshold} at the "
            f"{probe_image_size(frame_files[0])[0]}px extracted-frame width. "
            f"**{no_change_count} no-visible-change** and **{tiny_change_count} tiny-change** "
            "transitions are labeled explicitly. A no-visible-change result means the two "
            "captured images match at this threshold; an input/history event may still have "
            "occurred.",
        ]
    else:
        lines += [
            "No consecutive captured states exist, so no static transition images or "
            "`diff-contact-sheet.png` were generated.",
        ]
    lines += [
        "",
        f"Output is bounded by `--max-frames {max_frames}`: at most "
        f"{max(0, max_frames - 1)} consecutive-state diff triptychs. "
        + (
            f"{dropped} lower-signal bursts were omitted before comparison."
            if dropped
            else "No detected bursts were omitted."
        ),
        "",
        "## Change bursts",
        "",
        "| # | start | end | duration | peak YDIF | changed frames |",
        "|---|-------|-----|----------|-----------|----------------|",
    ]
    for i, b in enumerate(bursts, 1):
        lines.append(
            f"| {i} | {b['start']['t']:.3f}s | {b['end']['t']:.3f}s "
            f"| {b['duration_s'] * 1000:.0f}ms | {b['peak']['ydif']:.2f} "
            f"| {b['hot_frames']} |"
        )
    lines += ["", "## Captured states", "",
              "| state | time | held until | held for | file |",
              "|-------|------|------------|----------|------|"]
    for i, s in enumerate(states):
        t = s["frame"]["t"]
        t_next = states[i + 1]["frame"]["t"] if i + 1 < len(states) else meta["duration_s"]
        fname = frame_files[i].name if i < len(frame_files) else "?"
        lines.append(
            f"| {i} | {t:.3f}s | {t_next:.3f}s | {(t_next - t) * 1000:.0f}ms "
            f"| frames/{fname} |"
        )
    lines += [
        "",
        "## Consecutive-state comparisons",
        "",
        "| comparison | times | changed | mean abs RGB | bbox | status | artifact |",
        "|------------|-------|---------|--------------|------|--------|----------|",
    ]
    for transition in transitions:
        bbox = transition["bbox"]
        bbox_text = (
            "—"
            if bbox is None
            else (
                f"{bbox['x']},{bbox['y']} "
                f"{bbox['width']}×{bbox['height']}"
            )
        )
        lines.append(
            f"| S{transition['from_state']:03d} → S{transition['to_state']:03d} "
            f"| {transition['from_t_s']:.3f}s → {transition['to_t_s']:.3f}s "
            f"| {transition['changed_pct']:.4f}% "
            f"| {transition['mean_abs_rgb']:.3f} | {bbox_text} "
            f"| {transition['status']} | `{transition.get('file', '—')}` |"
        )
    lines += ["", "## Files", ""]
    if transitions:
        lines += [
            "- `diff-contact-sheet.png` — chronological overview of highlighted differences",
            "- `diffs/` — one labeled previous/current/highlight triptych per state transition",
        ]
    lines += [
        "- `transitions.csv` — thresholded RGB metrics and bounding boxes "
        "(header only when no transitions were captured)",
        "- `contact-sheet.png` — all states tiled, timestamps burned in",
        "- `frames/` — individual state frames (clean, no label — diffable)",
        "- `timeline.svg` — difference over time with bursts and state markers",
        "- `diff.csv` — raw per-video-frame YDIF data",
        "- `meta.json` — machine-readable summary",
        "- `visualizer.html` — optional interactive scrub/diff UI",
        "",
    ]
    (out_dir / "report.md").write_text("\n".join(lines))

    (out_dir / "meta.json").write_text(json.dumps({
        "video": meta,
        "threshold": threshold,
        "bursts": [
            {
                "start_s": b["start"]["t"], "end_s": b["end"]["t"],
                "duration_s": b["duration_s"], "peak_ydif": b["peak"]["ydif"],
                "sum_ydif": b["sum"], "hot_frames": b["hot_frames"],
            } for b in bursts
        ],
        "states": [
            {"frame": s["frame"]["n"], "t_s": s["frame"]["t"], "why": s["why"]}
            for s in states
        ],
        "pixel_diff": {
            "threshold": pixel_threshold,
            "comparison": "max absolute RGB channel delta > threshold",
            "resolution": {
                "width": probe_image_size(frame_files[0])[0],
                "height": probe_image_size(frame_files[0])[1],
            },
            "tiny_change_below_pct": 0.05,
        },
        "transitions": transitions,
        "dropped_bursts": dropped,
        "limits": {
            "max_states": max_frames,
            "max_transition_diffs": max(0, max_frames - 1),
            "dropped_bursts": dropped,
        },
        "contact_sheet": str(sheet),
        "diff_contact_sheet": str(diff_sheet) if diff_sheet else None,
    }, indent=2))


# -------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog=(
            "Default output includes report.md, clean states, a state contact sheet, "
            "and one static previous/current/highlight triptych per consecutive state. "
            "--max-frames bounds states and therefore bounds triptychs to N-1."
        ),
    )
    ap.add_argument("video", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=None,
                    help="output dir (default: <video-stem>-contact-sheet next to video)")
    ap.add_argument("--threshold", type=float, default=None,
                    help="YDIF change threshold (default: auto from noise floor)")
    ap.add_argument("--gap", type=float, default=0.12,
                    help="seconds of calm that ends a burst (default 0.12)")
    ap.add_argument("--settle", type=int, default=3,
                    help="frames after a burst to sample the settled state (default 3)")
    ap.add_argument("--max-frames", type=int, default=48,
                    help="max captured states (default 48; also caps static "
                         "triptychs at N-1; dropped bursts are reported)")
    ap.add_argument("--thumb-width", type=int, default=800,
                    help="clean-frame and static-diff comparison width px "
                         "(default 800)")
    ap.add_argument("--analysis-width", type=int, default=480,
                    help="downscale width for diff analysis (default 480)")
    ap.add_argument("--diff-pixel-threshold", type=int, default=24,
                    help="max-channel RGB delta for static diff highlights "
                         "(0-255, default 24; display mask dilates 1px)")
    args = ap.parse_args()

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        sys.exit("ffmpeg and ffprobe are required on PATH")
    if not args.video.exists():
        sys.exit(f"no such file: {args.video}")
    if args.max_frames < 1:
        sys.exit("--max-frames must be at least 1")
    if not 0 <= args.diff_pixel_threshold <= 255:
        sys.exit("--diff-pixel-threshold must be between 0 and 255")

    out_dir = args.out or args.video.parent / f"{args.video.stem}-contact-sheet"
    out_dir.mkdir(parents=True, exist_ok=True)

    meta = probe_meta(args.video)
    print(f"probing diffs ({meta['nb_frames']} frames)…", flush=True)
    frames = frame_diffs(args.video, args.analysis_width)
    if len(frames) < 2:
        sys.exit("video has fewer than 2 frames")

    if args.threshold is not None:
        threshold = args.threshold
    else:
        nonzero = [f["ydif"] for f in frames[1:] if f["ydif"] > 0]
        noise = statistics.median(nonzero) if nonzero else 0.0
        threshold = max(0.2, noise * 5)
    print(f"threshold {threshold:.3f} (median nonzero YDIF "
          f"{statistics.median([f['ydif'] for f in frames[1:]]):.4f})")

    bursts = detect_bursts(frames, threshold, args.gap)
    states, dropped = pick_states(frames, bursts, args.settle, args.max_frames)
    print(f"{len(bursts)} bursts → {len(states)} states"
          + (f" ({dropped} bursts dropped)" if dropped else ""))

    frame_files = extract_frames(args.video, states, out_dir, args.thumb_width)
    sheet = build_sheet(args.video, states, out_dir, args.thumb_width)
    print(f"measuring {max(0, len(states) - 1)} state transitions…", flush=True)
    width, height, transitions = measure_transitions(
        states, frame_files, args.diff_pixel_threshold
    )
    diff_files, diff_sheet = build_static_diffs(
        frame_files, states, transitions, out_dir, args.diff_pixel_threshold,
        width, height,
    )
    print(
        f"rendered {len(diff_files)} static diff triptychs"
        + (f" + {diff_sheet.name}" if diff_sheet else "")
    )
    timeline_svg(frames, bursts, states, threshold,
                 out_dir / "timeline.svg",
                 f"Visual change over time — {args.video.name}")
    write_visualizer(out_dir, meta, frames, bursts, states, threshold, frame_files)
    write_outputs(out_dir, meta, frames, bursts, states, dropped, threshold,
                  frame_files, sheet, transitions, args.diff_pixel_threshold,
                  diff_sheet, args.max_frames)
    if diff_sheet:
        print(
            f"done → read {out_dir}/report.md, then "
            f"{out_dir}/diff-contact-sheet.png"
        )
    else:
        print(f"done → read {out_dir}/report.md (no state transitions captured)")


if __name__ == "__main__":
    main()
