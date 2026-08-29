#!/usr/bin/env python3
"""YouTube ingestion helpers for the youtube-canvas Agent Skill.

External requirements: yt-dlp, ffmpeg, ffprobe.
Python dependencies: stdlib only.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

TIME_RE = re.compile(r"(?P<h>\d{2,}):(?P<m>\d{2}):(?P<s>\d{2}[\.,]\d{3})")
TAG_RE = re.compile(r"<[^>]+>")
YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,}$")


@dataclass
class Cue:
    start: float
    end: float
    text: str


def die(msg: str, code: int = 2) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


def run(cmd: list[str], *, capture: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            cmd,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except FileNotFoundError:
        die(f"missing executable: {cmd[0]}")
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or f"exit {exc.returncode}"
        die(f"command failed: {' '.join(cmd)}\n{detail}")


def require_bin(name: str) -> str:
    path = shutil.which(name)
    if not path:
        hint = ""
        if sys.platform == "darwin":
            hint = f" (try: brew install {name})"
        die(f"{name} is required{hint}")
    return path


def json_dump(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def seconds_to_clock(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def timestamp_url(manifest: dict[str, Any], seconds: float) -> str:
    video_id = manifest.get("videoId")
    if video_id and YT_ID_RE.match(str(video_id)):
        return f"https://youtu.be/{video_id}?t={max(0, int(seconds))}"
    url = str(manifest.get("url") or "")
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}t={max(0, int(seconds))}s"


def fetch_metadata(url: str) -> dict[str, Any]:
    require_bin("yt-dlp")
    proc = run(["yt-dlp", "--dump-single-json", "--skip-download", "--no-warnings", url])
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        die(f"yt-dlp returned invalid JSON: {exc}")


def choose_caption_track(meta: dict[str, Any], language: str) -> tuple[str, dict[str, Any]] | None:
    pools: list[dict[str, Any]] = []
    for key in ("subtitles", "automatic_captions"):
        value = meta.get(key)
        if isinstance(value, dict):
            pools.append(value)

    if not pools:
        return None

    requested = language.strip().lower()
    candidates: list[tuple[int, str, list[dict[str, Any]]]] = []

    for pool_index, pool in enumerate(pools):
        for lang, formats in pool.items():
            if not isinstance(formats, list):
                continue
            l = str(lang).lower()
            if l == requested:
                score = 100
            elif l.startswith(requested + "-") or l.startswith(requested + "."):
                score = 90
            elif requested.startswith(l + "-"):
                score = 85
            elif requested == "en" and l.startswith("en"):
                score = 80
            else:
                score = 0
            if score:
                # Prefer human subtitles over automatic captions when scores tie.
                score += 10 if pool_index == 0 else 0
                candidates.append((score, str(lang), formats))

    if not candidates:
        return None

    candidates.sort(key=lambda x: x[0], reverse=True)
    _, lang, formats = candidates[0]

    # VTT is simplest and preserves timestamps. Prefer a non-live_chat track.
    for fmt in formats:
        if fmt.get("ext") == "vtt" and fmt.get("url"):
            return lang, fmt
    for fmt in formats:
        if fmt.get("url"):
            return lang, fmt
    return None


def download_url(url: str, dest: Path) -> None:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 youtube-canvas-skill/0.1",
            "Accept": "text/vtt,text/plain,*/*",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            dest.write_bytes(response.read())
    except Exception as exc:  # noqa: BLE001
        die(f"failed to download captions: {exc}")


def parse_ts(value: str) -> float:
    value = value.strip().replace(",", ".")
    parts = value.split(":")
    if len(parts) == 3:
        h, m, s = parts
    elif len(parts) == 2:
        h, m, s = "0", parts[0], parts[1]
    else:
        raise ValueError(value)
    return int(h) * 3600 + int(m) * 60 + float(s)


def clean_caption_text(text: str) -> str:
    text = re.sub(r"<\d{2}:\d{2}:\d{2}[\.,]\d{3}>", " ", text)
    text = TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    # YouTube auto captions sometimes include positioning artifacts.
    text = re.sub(r"^(align|position|line):\S+\s*", "", text, flags=re.I)
    return text


def parse_vtt(path: Path) -> list[Cue]:
    raw = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    lines = raw.split("\n")
    cues: list[Cue] = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if "-->" not in line:
            i += 1
            continue
        timing = line.split("-->", 1)
        start_s = timing[0].strip().split()[0]
        end_s = timing[1].strip().split()[0]
        try:
            start = parse_ts(start_s)
            end = parse_ts(end_s)
        except ValueError:
            i += 1
            continue
        i += 1
        text_lines: list[str] = []
        while i < len(lines) and lines[i].strip():
            text_lines.append(lines[i])
            i += 1
        text = clean_caption_text(" ".join(text_lines))
        if text:
            cues.append(Cue(start=start, end=end, text=text))
        i += 1
    return normalize_cues(cues)


def overlap_suffix_prefix(previous: list[str], current: list[str], max_words: int = 30) -> int:
    lim = min(len(previous), len(current), max_words)
    prev_lower = [x.lower() for x in previous]
    curr_lower = [x.lower() for x in current]
    for k in range(lim, 0, -1):
        if prev_lower[-k:] == curr_lower[:k]:
            return k
    return 0


def normalize_cues(cues: Iterable[Cue]) -> list[Cue]:
    """Remove the worst rolling-caption duplication without destroying timing."""
    out: list[Cue] = []
    previous_full_words: list[str] = []
    previous_text = ""
    for cue in cues:
        text = re.sub(r"\s+", " ", cue.text).strip()
        if not text:
            continue
        if text == previous_text:
            continue
        words = text.split()
        overlap = overlap_suffix_prefix(previous_full_words, words)
        new_words = words[overlap:] if overlap else words

        # Another common auto-caption pattern repeats the whole previous cue and adds a suffix.
        if previous_text and text.lower().startswith(previous_text.lower() + " "):
            suffix = text[len(previous_text) :].strip()
            new_words = suffix.split()

        new_text = " ".join(new_words).strip()
        if not new_text:
            previous_full_words = words
            previous_text = text
            continue

        # Tiny fragments are usually rolling-caption churn; merge with the previous cue.
        if out and len(new_text.split()) <= 2 and cue.start - out[-1].end <= 1.2:
            merged = re.sub(r"\s+", " ", f"{out[-1].text} {new_text}").strip()
            out[-1] = Cue(out[-1].start, max(out[-1].end, cue.end), merged)
        else:
            out.append(Cue(cue.start, cue.end, new_text))

        previous_full_words = words
        previous_text = text
    return out


def write_chunks(outdir: Path, cues: list[Cue], manifest: dict[str, Any], chunk_minutes: int) -> None:
    chunk_dir = outdir / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    for old in chunk_dir.glob("*.md"):
        old.unlink()

    duration = float(manifest.get("duration") or (cues[-1].end if cues else 0))
    chunk_seconds = max(300, chunk_minutes * 60)
    chunk_count = max(1, int(duration // chunk_seconds) + 1)

    for index in range(chunk_count):
        start = index * chunk_seconds
        end = min(duration, (index + 1) * chunk_seconds) if duration else (index + 1) * chunk_seconds
        selected = [c for c in cues if c.start < end and c.end >= start]
        if not selected:
            continue
        name = f"{index:03d}_{seconds_to_clock(start).replace(':','-')}_{seconds_to_clock(end).replace(':','-')}.md"
        lines = [
            f"# {manifest.get('title', 'YouTube video')}",
            "",
            f"Chunk {seconds_to_clock(start)}–{seconds_to_clock(end)}",
            "",
        ]
        for cue in selected:
            clock = seconds_to_clock(cue.start)
            lines.append(f"[{clock}]({timestamp_url(manifest, cue.start)}) {cue.text}")
        (chunk_dir / name).write_text("\n".join(lines) + "\n", encoding="utf-8")


def command_prepare(args: argparse.Namespace) -> None:
    outdir = Path(args.out).expanduser().resolve()
    outdir.mkdir(parents=True, exist_ok=True)

    meta = fetch_metadata(args.url)
    manifest = {
        "videoId": meta.get("id"),
        "title": meta.get("title") or "Untitled YouTube video",
        "channel": meta.get("channel") or meta.get("uploader"),
        "channelId": meta.get("channel_id") or meta.get("uploader_id"),
        "duration": meta.get("duration"),
        "uploadDate": meta.get("upload_date"),
        "description": meta.get("description"),
        "url": meta.get("webpage_url") or args.url,
        "thumbnail": meta.get("thumbnail"),
        "chapters": meta.get("chapters") or [],
        "languageRequested": args.language,
    }

    track = choose_caption_track(meta, args.language)
    if not track:
        available = sorted(
            set((meta.get("subtitles") or {}).keys()) | set((meta.get("automatic_captions") or {}).keys())
        )
        suffix = f" Available caption languages include: {', '.join(available[:20])}" if available else ""
        die(f"no caption track matching '{args.language}'.{suffix}")

    caption_lang, fmt = track
    manifest["captionLanguage"] = caption_lang
    manifest["captionExt"] = fmt.get("ext")
    json_dump(outdir / "manifest.json", manifest)

    caption_path = outdir / f"captions.{fmt.get('ext') or 'vtt'}"
    download_url(str(fmt["url"]), caption_path)

    if fmt.get("ext") != "vtt":
        # Let ffmpeg/yt-dlp handle unusual tracks only if necessary. The common path is VTT.
        die(
            f"selected captions are {fmt.get('ext')!r}, not VTT. "
            "Re-run with a language that has VTT captions or extend youtube.py for this caption format."
        )

    cues = parse_vtt(caption_path)
    if not cues:
        die("caption file was downloaded but no usable cues were parsed")

    transcript = {
        "videoId": manifest.get("videoId"),
        "title": manifest.get("title"),
        "language": caption_lang,
        "cues": [c.__dict__ for c in cues],
    }
    json_dump(outdir / "transcript.json", transcript)

    md_lines = [f"# {manifest['title']}", "", f"Source: {manifest['url']}", ""]
    for cue in cues:
        md_lines.append(f"[{seconds_to_clock(cue.start)}]({timestamp_url(manifest, cue.start)}) {cue.text}")
    (outdir / "transcript.md").write_text("\n".join(md_lines) + "\n", encoding="utf-8")
    write_chunks(outdir, cues, manifest, args.chunk_minutes)

    print(json.dumps({
        "ok": True,
        "workdir": str(outdir),
        "title": manifest["title"],
        "videoId": manifest.get("videoId"),
        "duration": manifest.get("duration"),
        "captionLanguage": caption_lang,
        "cues": len(cues),
        "chunks": len(list((outdir / "chunks").glob("*.md"))),
    }, indent=2))


def safe_slug(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")[:60] or "frame"


def choose_video_file(outdir: Path) -> Path | None:
    candidates = []
    for p in outdir.glob("source-video.*"):
        if p.suffix.lower() in {".part", ".ytdl", ".json"}:
            continue
        candidates.append(p)
    return max(candidates, key=lambda p: p.stat().st_size) if candidates else None


def download_lowres_video(url: str, outdir: Path) -> Path:
    require_bin("yt-dlp")
    existing = choose_video_file(outdir)
    if existing:
        return existing

    template = str(outdir / "source-video.%(ext)s")
    # Video-only is enough for screenshots. Prefer <=480p, then best available fallback.
    run([
        "yt-dlp",
        "--no-warnings",
        "--no-playlist",
        "-f",
        "bestvideo[height<=480]/best[height<=480]/worst",
        "-o",
        template,
        url,
    ], capture=False)
    found = choose_video_file(outdir)
    if not found:
        die("yt-dlp completed but no downloaded video file was found")
    return found


def ffprobe_dimensions(video: Path) -> tuple[int, int] | None:
    require_bin("ffprobe")
    proc = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", str(video)
    ])
    try:
        streams = json.loads(proc.stdout).get("streams") or []
        if streams:
            return int(streams[0]["width"]), int(streams[0]["height"])
    except Exception:  # noqa: BLE001
        return None
    return None


def collect_visual_candidates(analysis: dict[str, Any], max_frames: int) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[int] = set()
    for segment in analysis.get("segments") or []:
        for visual in segment.get("visuals") or []:
            ts = float(visual.get("timestamp", segment.get("start", 0)))
            rounded = int(round(ts))
            if rounded in seen:
                continue
            seen.add(rounded)
            candidates.append({
                "segmentId": segment.get("id"),
                "timestamp": ts,
                "reason": visual.get("reason") or "representative visual",
            })
            if len(candidates) >= max_frames:
                return candidates
    return candidates


def command_frames(args: argparse.Namespace) -> None:
    analysis_path = Path(args.analysis).expanduser().resolve()
    manifest_path = Path(args.manifest).expanduser().resolve()
    outdir = Path(args.out).expanduser().resolve()
    if not analysis_path.exists():
        die(f"analysis not found: {analysis_path}")
    if not manifest_path.exists():
        die(f"manifest not found: {manifest_path}")
    analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    candidates = collect_visual_candidates(analysis, args.max_frames)

    frames_dir = outdir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    if not candidates:
        json_dump(outdir / "frames.json", {"video": None, "frames": []})
        print(json.dumps({"ok": True, "frames": 0, "message": "analysis requested no visual frames"}, indent=2))
        return

    require_bin("ffmpeg")
    video = download_lowres_video(str(manifest.get("url")), outdir)
    dims = ffprobe_dimensions(video)
    extracted: list[dict[str, Any]] = []

    for index, item in enumerate(candidates):
        ts = max(0.0, float(item["timestamp"]))
        filename = f"{index:03d}_{safe_slug(str(item.get('segmentId') or 'segment'))}_{int(round(ts)):06d}.jpg"
        dest = frames_dir / filename
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{ts:.3f}", "-i", str(video),
            "-frames:v", "1",
            "-vf", "scale='min(720,iw)':-2",
            "-q:v", "4",
            str(dest),
        ]
        # shell quoting is not needed with subprocess; ffmpeg accepts this scale expression as-is.
        run(cmd, capture=True)
        extracted.append({**item, "path": str(dest), "filename": filename})

    result = {
        "video": str(video),
        "sourceDimensions": {"w": dims[0], "h": dims[1]} if dims else None,
        "frames": extracted,
    }
    json_dump(outdir / "frames.json", result)
    print(json.dumps({"ok": True, "frames": len(extracted), "video": str(video)}, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="YouTube preparation and visual frame extraction")
    sub = parser.add_subparsers(dest="command", required=True)

    prepare = sub.add_parser("prepare", help="fetch metadata/captions and create timestamped transcript chunks")
    prepare.add_argument("url")
    prepare.add_argument("--out", required=True)
    prepare.add_argument("--language", default="en")
    prepare.add_argument("--chunk-minutes", type=int, default=12)
    prepare.set_defaults(func=command_prepare)

    frames = sub.add_parser("frames", help="extract frames requested by analysis.json")
    frames.add_argument("analysis")
    frames.add_argument("--manifest", required=True)
    frames.add_argument("--out", required=True)
    frames.add_argument("--max-frames", type=int, default=18)
    frames.set_defaults(func=command_frames)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
