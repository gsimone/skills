#!/usr/bin/env python3
"""Render youtube-canvas analysis.json into a live tldraw Offline document."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

# Import sibling bridge without requiring installation as a Python package.
SCRIPT_DIR = Path(__file__).resolve().parent
BOARD_SCRIPT_DIR = SCRIPT_DIR / "board_script"
sys.path.insert(0, str(SCRIPT_DIR))
from tldraw_api import (  # noqa: E402
    create_doc,
    exec_doc,
    focused_doc_id,
    install_board_script,
    save_doc_if_local,
    screenshot,
)


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(2)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"missing file: {path}")
    except json.JSONDecodeError as exc:
        die(f"invalid JSON in {path}: {exc}")


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def safe_doc_name(value: str) -> str:
    value = re.sub(r'[\\/:*?"<>|]+', ' — ', clean_text(value))
    value = re.sub(r'\s+', ' ', value).strip(' .—')
    return (value[:100] or 'YouTube research canvas')


def clock(seconds: float) -> str:
    total = max(0, int(round(float(seconds))))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def timestamp_url(manifest: dict[str, Any], seconds: float) -> str:
    vid = clean_text(manifest.get("videoId"))
    if vid:
        return f"https://youtu.be/{vid}?t={max(0, int(float(seconds)))}"
    url = clean_text(manifest.get("url"))
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}t={max(0, int(float(seconds)))}s"


def text_height(text: str, width: int, *, base: int = 52, line_px: int = 26, min_h: int = 70, max_h: int = 290) -> int:
    # Crude but deterministic estimate that errs toward whitespace rather than clipping.
    chars_per_line = max(18, int(width / 9.2))
    lines = max(1, math.ceil(len(text) / chars_per_line))
    return max(min_h, min(max_h, base + lines * line_px))


def enrich_analysis(analysis: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    data = {
        "manifest": {
            "videoId": clean_text(manifest.get("videoId")),
            "title": clean_text(manifest.get("title")) or "YouTube research canvas",
            "channel": clean_text(manifest.get("channel")),
            "duration": manifest.get("duration"),
            "url": clean_text(manifest.get("url")),
        },
        "mode": analysis.get("mode", "research"),
        "summary": clean_text(analysis.get("summary")),
        "keyIdeas": [clean_text(x) for x in analysis.get("keyIdeas") or [] if clean_text(x)],
        "segments": [],
    }
    for seg in analysis.get("segments") or []:
        start = float(seg.get("start", 0))
        end = float(seg.get("end", start))
        segment = {
            "id": clean_text(seg.get("id")),
            "start": start,
            "end": end,
            "clock": clock(start),
            "interval": f"{clock(start)}–{clock(end)}",
            "url": timestamp_url(manifest, start),
            "title": clean_text(seg.get("title")),
            "summary": clean_text(seg.get("summary")),
            "whyItMatters": clean_text(seg.get("whyItMatters")),
            "quote": clean_text(seg.get("quote")),
            "cluster": clean_text(seg.get("cluster")) or "Other",
            "tags": [clean_text(x) for x in seg.get("tags") or [] if clean_text(x)],
        }
        data["segments"].append(segment)
    return data


def generate_js(data: dict[str, Any]) -> str:
    # Python computes most layout dimensions so JS stays a simple deterministic renderer.
    clusters: list[str] = []
    for seg in data["segments"]:
        if seg["cluster"] not in clusters:
            clusters.append(seg["cluster"])

    col_w = 590
    col_gap = 70
    card_w = 550
    left = 0
    header_y = 0
    player_w = 360
    player_h = 220
    summary_x = 390
    summary_w = max(620, min(900, len(data["summary"]) * 2))
    key_y = 280
    key_w = 330
    key_gap = 22
    keys_per_row = 4
    key_rows = max(1, math.ceil(max(1, len(data["keyIdeas"])) / keys_per_row))
    clusters_y = key_y + key_rows * 128 + 110

    layouts: dict[str, dict[str, Any]] = {}
    max_cluster_height = 0
    for ci, cluster in enumerate(clusters):
        x = left + ci * (col_w + col_gap)
        y = clusters_y + 62
        seg_layouts = []
        for seg in [s for s in data["segments"] if s["cluster"] == cluster]:
            body_parts = [seg["summary"]]
            if seg["whyItMatters"]:
                body_parts.append("Why it matters: " + seg["whyItMatters"])
            if seg["quote"]:
                body_parts.append("“" + seg["quote"] + "”")
            body = "\n\n".join(body_parts)
            body_h = text_height(body, card_w - 34, min_h=120, max_h=320)
            tag_h = 44 if seg["tags"] else 0
            card_h = 86 + body_h + tag_h + 30
            seg_layouts.append({"id": seg["id"], "x": x, "y": y, "h": card_h, "body": body, "bodyH": body_h, "tagH": tag_h})
            y += card_h + 34
        height = max(120, y - clusters_y)
        layouts[cluster] = {"x": x, "segments": seg_layouts, "height": height}
        max_cluster_height = max(max_cluster_height, height)

    data_with_layout = {**data, "layout": {
        "player": {"x": 0, "y": header_y, "w": player_w, "h": player_h},
        "summary": {"x": summary_x, "y": header_y, "w": summary_w, "h": player_h},
        "keyY": key_y,
        "keyW": key_w,
        "keyGap": key_gap,
        "keysPerRow": keys_per_row,
        "clustersY": clusters_y,
        "colW": col_w,
        "clusterGap": col_gap,
        "clusters": layouts,
        "maxClusterHeight": max_cluster_height,
    }}

    payload = json.dumps(data_with_layout, ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")

    return f"""
const DATA = {payload};
const {{ createShapeId, toRichText }} = await import('tldraw');

const videoId = DATA.manifest.videoId || 'youtube';
const marker = (kind, extra={{}}) => ({{ youtubeCanvas: {{ generated: true, videoId, kind, ...extra }} }});
const sid = (kind, key='') => createShapeId(`ytc-${{videoId}}-${{kind}}-${{key}}`);

const oldShapes = editor.getCurrentPageShapes().filter(s => s.meta?.youtubeCanvas?.generated && s.meta.youtubeCanvas.videoId === videoId);
if (oldShapes.length) editor.deleteShapes(oldShapes.map(s => s.id));
const oldAssets = editor.getAssets().filter(a => a.meta?.youtubeCanvas?.generated && a.meta.youtubeCanvas.videoId === videoId);
if (oldAssets.length) editor.deleteAssets(oldAssets.map(a => a.id));

const shapes = [];
const addGeo = (id, x, y, w, h, text, opts={{}}) => {{
  shapes.push({{
    id, type: 'geo', x, y,
    props: {{
      geo: opts.geo || 'rectangle', w, h,
      color: opts.color || 'grey', labelColor: opts.labelColor || 'black',
      fill: opts.fill || 'none', dash: opts.dash || 'solid', size: opts.size || 's',
      font: opts.font || 'sans', align: opts.align || 'start', verticalAlign: opts.verticalAlign || 'start',
      richText: toRichText(text || ''), url: opts.url || '', growY: 0, scale: 1,
    }},
    meta: marker(opts.kind || 'geo', opts.meta || {{}}),
  }});
}};
const addText = (id, x, y, w, text, opts={{}}) => {{
  shapes.push({{
    id, type: 'text', x, y,
    props: {{
      richText: toRichText(text || ''), color: opts.color || 'black', size: opts.size || 'm',
      font: opts.font || 'sans', textAlign: opts.align || 'start', w, scale: 1, autoSize: false,
    }},
    meta: marker(opts.kind || 'text', opts.meta || {{}}),
  }});
}};

// Compact source area. Video playback stays in the fixed viewport player.
addText(sid('title'), 0, -76, 1450, DATA.manifest.title, {{ size: 'xl', kind: 'title' }});
const byline = [DATA.manifest.channel, DATA.manifest.duration ? `${{Math.floor(DATA.manifest.duration/60)}} min` : '', DATA.mode].filter(Boolean).join('  ·  ');
addText(sid('byline'), 0, -34, 1200, byline, {{ size: 's', color: 'grey', kind: 'byline' }});
const sourceLabel = ['VIDEO SOURCE', DATA.manifest.channel, 'Open on YouTube ↗'].filter(Boolean).join('\\n\\n');
addGeo(sid('source-card'), DATA.layout.player.x, DATA.layout.player.y, DATA.layout.player.w, DATA.layout.player.h, sourceLabel, {{
  url: DATA.manifest.url, fill: 'semi', color: 'blue', size: 's', kind: 'player',
  meta: {{ title: DATA.manifest.title, url: DATA.manifest.url }}
}});
addGeo(sid('summary'), DATA.layout.summary.x, DATA.layout.summary.y, DATA.layout.summary.w, DATA.layout.summary.h, `SUMMARY\n\n${{DATA.summary}}`, {{ fill: 'semi', color: 'grey', size: 's', kind: 'summary' }});

// Key ideas
addText(sid('key-heading'), 0, DATA.layout.keyY - 38, 500, 'KEY IDEAS', {{ size: 's', color: 'grey', kind: 'heading' }});
DATA.keyIdeas.forEach((idea, i) => {{
  const row = Math.floor(i / DATA.layout.keysPerRow);
  const col = i % DATA.layout.keysPerRow;
  const x = col * (DATA.layout.keyW + DATA.layout.keyGap);
  const y = DATA.layout.keyY + row * 128;
  addGeo(sid('key', String(i)), x, y, DATA.layout.keyW, 104, idea, {{ fill: 'semi', color: 'grey', kind: 'key-idea', meta: {{ index: i }} }});
}});

for (const [clusterIndex, cluster] of Object.keys(DATA.layout.clusters).entries()) {{
  const cl = DATA.layout.clusters[cluster];
  addText(sid('cluster-title', String(clusterIndex)), cl.x, DATA.layout.clustersY, DATA.layout.colW, cluster.toUpperCase(), {{ size: 'l', kind: 'cluster-title', meta: {{ cluster }} }});
  const clusterSegments = DATA.segments.filter(s => s.cluster === cluster);
  for (const seg of clusterSegments) {{
    const L = cl.segments.find(x => x.id === seg.id);
    const baseId = sid('segment-bg', seg.id);
    addGeo(baseId, L.x, L.y, {card_w}, L.h, '', {{ fill: 'semi', color: 'grey', kind: 'segment', meta: {{ segmentId: seg.id, start: seg.start, end: seg.end, cluster }} }});

    addText(sid('segment-title', seg.id), L.x + 20, L.y + 18, {card_w - 220}, seg.title, {{ size: 'm', kind: 'segment-title', meta: {{ segmentId: seg.id }} }});
    addGeo(sid('timestamp', seg.id), L.x + {card_w - 174}, L.y + 14, 132, 42, `▶ ${{seg.interval}}`, {{
      color: 'blue', labelColor: 'blue', fill: 'none', size: 's', align: 'middle', verticalAlign: 'middle',
      kind: 'timestamp', meta: {{ segmentId: seg.id, start: seg.start, title: seg.title }}
    }});
    addGeo(sid('source-link', seg.id), L.x + {card_w - 34}, L.y + 14, 22, 42, '↗', {{
      color: 'blue', labelColor: 'blue', fill: 'none', size: 's', align: 'middle', verticalAlign: 'middle',
      url: seg.url, kind: 'source-link', meta: {{ segmentId: seg.id, start: seg.start }}
    }});

    let cursorY = L.y + 76;
    addGeo(sid('segment-body', seg.id), L.x + 20, cursorY, {card_w - 40}, L.bodyH, L.body, {{ fill: 'none', color: 'grey', dash: 'none', size: 's', kind: 'segment-body', meta: {{ segmentId: seg.id }} }});
    cursorY += L.bodyH + 8;
    if (seg.tags.length) {{
      addText(sid('tags', seg.id), L.x + 22, cursorY, {card_w - 40}, seg.tags.map(t => `#${{t}}`).join('   '), {{ size: 's', color: 'grey', kind: 'tags', meta: {{ segmentId: seg.id }} }});
    }}
  }}
}}

editor.createShapes(shapes);
editor.deselect();
editor.zoomToFit();
return {{
  videoId,
  generatedShapes: shapes.length,
  clusters: Object.keys(DATA.layout.clusters).length,
  segments: DATA.segments.length,
}};
"""


def choose_doc(args: argparse.Namespace, name: str) -> tuple[str, dict[str, Any] | None]:
    if args.doc_id:
        return args.doc_id, None
    if args.focused:
        return focused_doc_id(), None
    if args.new:
        created = create_doc(name)
        doc_id = str(created.get("id") or created.get("documentId"))
        return doc_id, created
    die("choose exactly one target: --new, --focused, or --doc-id")


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a YouTube analysis into tldraw Offline")
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--analysis", required=True)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--new", action="store_true")
    target.add_argument("--focused", action="store_true")
    target.add_argument("--doc-id")
    parser.add_argument("--name")
    parser.add_argument("--write-js", action="store_true", help="write generated JS to workdir/render.generated.js")
    parser.add_argument("--verify-screenshot", action="store_true")
    args = parser.parse_args()

    workdir = Path(args.workdir).expanduser().resolve()
    analysis_path = Path(args.analysis).expanduser().resolve()
    manifest_path = workdir / "manifest.json"
    if not manifest_path.exists():
        die(f"manifest.json not found in workdir: {workdir}")

    analysis = read_json(analysis_path)
    manifest = read_json(manifest_path)
    if not isinstance(analysis, dict) or not isinstance(manifest, dict):
        die("analysis and manifest must be JSON objects")

    data = enrich_analysis(analysis, manifest)
    if not data["segments"]:
        die("analysis contains no segments")

    default_name = safe_doc_name(clean_text(args.name) or f"{data['manifest']['title'][:70]} — research")
    doc_id, created = choose_doc(args, default_name)
    js = generate_js(data)
    if args.write_js:
        (workdir / "render.generated.js").write_text(js, encoding="utf-8")

    try:
        result = exec_doc(doc_id, js, timeout=120)
    except RuntimeError as exc:
        if created:
            die(
                f"created tldraw document but rendering failed: {exc}\n"
                "Run scripts/tldraw_api.py readme to inspect the running Canvas API contract."
            )
        raise

    try:
        interactive_player = install_board_script(doc_id, BOARD_SCRIPT_DIR)
    except RuntimeError as exc:
        interactive_player = {"installed": False, "reason": str(exc)}
    saved = save_doc_if_local(doc_id)
    output: dict[str, Any] = {
        "ok": True,
        "docId": doc_id,
        "created": created,
        "render": result,
        "saved": saved,
        "interactivePlayer": interactive_player,
        "segments": len(data["segments"]),
        "clusters": len({s["cluster"] for s in data["segments"]}),
    }
    if args.verify_screenshot:
        try:
            output["verificationScreenshot"] = screenshot(doc_id)
        except RuntimeError as exc:
            output["verificationScreenshotError"] = str(exc)
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
