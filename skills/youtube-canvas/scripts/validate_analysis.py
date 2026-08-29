#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def fail(errors: list[str]) -> None:
    for err in errors:
        print(f"- {err}", file=sys.stderr)
    raise SystemExit(1)


def validate(data: dict[str, Any], duration: float | None = None) -> list[str]:
    errors: list[str] = []
    if data.get("mode") not in {"research", "watch"}:
        errors.append("mode must be 'research' or 'watch'")
    if not isinstance(data.get("summary"), str) or not data["summary"].strip():
        errors.append("summary must be a non-empty string")
    if not isinstance(data.get("keyIdeas"), list):
        errors.append("keyIdeas must be an array")

    segments = data.get("segments")
    if not isinstance(segments, list) or not segments:
        errors.append("segments must be a non-empty array")
        return errors

    ids: set[str] = set()
    starts: list[float] = []
    clusters: set[str] = set()
    for i, seg in enumerate(segments):
        prefix = f"segments[{i}]"
        if not isinstance(seg, dict):
            errors.append(f"{prefix} must be an object")
            continue
        sid = seg.get("id")
        if not isinstance(sid, str) or not sid.startswith("seg-"):
            errors.append(f"{prefix}.id must look like seg-001")
        elif sid in ids:
            errors.append(f"duplicate segment id: {sid}")
        else:
            ids.add(sid)
        for key in ("title", "summary", "cluster"):
            if not isinstance(seg.get(key), str) or not seg[key].strip():
                errors.append(f"{prefix}.{key} must be a non-empty string")
        if isinstance(seg.get("cluster"), str) and seg["cluster"].strip():
            clusters.add(seg["cluster"].strip())
        try:
            start = float(seg.get("start"))
            end = float(seg.get("end"))
            starts.append(start)
            if start < 0:
                errors.append(f"{prefix}.start must be >= 0")
            if end <= start:
                errors.append(f"{prefix}.end must be > start")
            if duration and start > duration + 2:
                errors.append(f"{prefix}.start ({start}) exceeds video duration ({duration})")
            if duration and end > duration + 30:
                errors.append(f"{prefix}.end ({end}) exceeds video duration ({duration})")
        except (TypeError, ValueError):
            errors.append(f"{prefix}.start/end must be numbers")

    if starts != sorted(starts):
        errors.append("segments must be ordered chronologically by start")
    if len(clusters) > 8:
        errors.append(f"too many clusters ({len(clusters)}); spatial boards become noisy above ~6")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("analysis")
    parser.add_argument("--manifest")
    args = parser.parse_args()

    path = Path(args.analysis).expanduser().resolve()
    data = json.loads(path.read_text(encoding="utf-8"))
    duration = None
    if args.manifest:
        manifest = json.loads(Path(args.manifest).expanduser().resolve().read_text(encoding="utf-8"))
        try:
            duration = float(manifest.get("duration")) if manifest.get("duration") is not None else None
        except (TypeError, ValueError):
            duration = None
    errors = validate(data, duration)
    if errors:
        fail(errors)
    clusters = sorted({seg.get("cluster") for seg in data["segments"] if seg.get("cluster")})
    print(json.dumps({
        "ok": True,
        "mode": data.get("mode"),
        "segments": len(data["segments"]),
        "clusters": len(clusters),
    }, indent=2))


if __name__ == "__main__":
    main()
