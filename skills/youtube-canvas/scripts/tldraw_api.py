#!/usr/bin/env python3
"""Small stdlib bridge for tldraw Offline's local Canvas API."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ServerInfo:
    path: Path
    port: int
    token: str
    pid: int | None = None

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def server_candidates() -> list[Path]:
    home = Path.home()
    system = platform.system().lower()
    candidates: list[Path] = []
    override = os.environ.get("TLDRAW_SERVER_JSON")
    if override:
        candidates.append(Path(override).expanduser())

    if system == "darwin":
        candidates += [
            home / "Library/Application Support/tldraw/server.json",
            home / "Library/Application Support/tldraw (Nightly)/server.json",
        ]
    elif system == "windows":
        appdata = os.environ.get("APPDATA")
        if appdata:
            candidates += [
                Path(appdata) / "tldraw/server.json",
                Path(appdata) / "tldraw (Nightly)/server.json",
            ]
    else:
        config = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
        candidates += [
            config / "tldraw/server.json",
            config / "tldraw (Nightly)/server.json",
        ]
    return candidates


def load_server() -> ServerInfo:
    errors: list[str] = []
    for path in server_candidates():
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return ServerInfo(
                path=path,
                port=int(data["port"]),
                token=str(data["token"]),
                pid=int(data["pid"]) if data.get("pid") is not None else None,
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{path}: {exc}")
    suffix = "\n" + "\n".join(errors) if errors else ""
    raise RuntimeError(
        "tldraw Offline server.json was not found. Open tldraw Offline first, "
        "or set TLDRAW_SERVER_JSON to its server.json path." + suffix
    )


def request(
    method: str,
    path: str,
    data: Any | None = None,
    *,
    auth: bool = True,
    timeout: int = 30,
) -> Any:
    server = load_server()
    headers: dict[str, str] = {}
    body = None
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if auth:
        headers["Authorization"] = f"Bearer {server.token}"
    req = urllib.request.Request(server.base + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            content_type = response.headers.get("content-type", "")
            text = raw.decode("utf-8", errors="replace")
            if "json" in content_type:
                return json.loads(text) if text else None
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return text
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"tldraw API {method} {path} -> HTTP {exc.code}: {body_text}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"tldraw API is unreachable at {server.base}: {exc.reason}") from exc


def unwrap(response: Any) -> Any:
    if isinstance(response, dict) and "result" in response:
        return response["result"]
    return response


def api_search(code: str) -> Any:
    return unwrap(request("POST", "/api/search", {"code": code}))


def focused_doc_id() -> str:
    result = api_search("const d = await api.getFocusedDoc(); return d ? d.id : null")
    if not result:
        raise RuntimeError("no focused tldraw document; open/focus a document first")
    return str(result)


def list_docs() -> Any:
    # GET /api/docs exists in recent tldraw Offline versions; fall back to search for older ones.
    try:
        return unwrap(request("GET", "/api/docs"))
    except RuntimeError:
        return api_search("return await api.getDocs()")


def create_doc(name: str) -> dict[str, Any]:
    # v1.12+ endpoint. The running app's /readme is authoritative if this contract changes.
    response = unwrap(request("POST", "/api/docs/create", {"name": name}))
    if not isinstance(response, dict):
        raise RuntimeError(f"unexpected create-document response: {response!r}")
    doc_id = response.get("id") or response.get("documentId")
    if not doc_id:
        raise RuntimeError(f"created document but response had no id: {response!r}")
    return response


def exec_doc(doc_id: str, code: str, timeout: int = 60) -> Any:
    encoded = urllib.parse.quote(doc_id, safe="")
    return unwrap(request("POST", f"/api/doc/{encoded}/exec", {"code": code}, timeout=timeout))


def screenshot(doc_id: str) -> Any:
    quoted = json.dumps(doc_id)
    return api_search(f"return await api.getScreenshot({quoted})")


def shapes(doc_id: str) -> Any:
    quoted = json.dumps(doc_id)
    return api_search(f"return await api.getShapes({quoted})")


def readme() -> str:
    result = request("GET", "/readme", auth=False)
    return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)


def command_doctor(_: argparse.Namespace) -> None:
    status: dict[str, Any] = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "yt-dlp": shutil.which("yt-dlp"),
        "ffmpeg": shutil.which("ffmpeg"),
        "ffprobe": shutil.which("ffprobe"),
    }
    try:
        server = load_server()
        status["tldraw"] = {
            "serverJson": str(server.path),
            "port": server.port,
            "pid": server.pid,
            "reachable": True,
        }
        # A small unauthenticated ping/readme catches stale server.json files.
        _ = readme()
    except Exception as exc:  # noqa: BLE001
        status["tldraw"] = {"reachable": False, "error": str(exc)}

    missing = [name for name in ("yt-dlp", "ffmpeg", "ffprobe") if not status[name]]
    ok = not missing and bool(status["tldraw"].get("reachable"))
    status["ok"] = ok
    if missing:
        status["missing"] = missing
    print(json.dumps(status, indent=2))
    raise SystemExit(0 if ok else 1)


def command_readme(_: argparse.Namespace) -> None:
    print(readme())


def command_docs(_: argparse.Namespace) -> None:
    print(json.dumps(list_docs(), ensure_ascii=False, indent=2))


def command_focused(_: argparse.Namespace) -> None:
    print(focused_doc_id())


def command_create(args: argparse.Namespace) -> None:
    print(json.dumps(create_doc(args.name), ensure_ascii=False, indent=2))


def command_exec_file(args: argparse.Namespace) -> None:
    doc_id = args.doc_id or focused_doc_id()
    code = Path(args.file).read_text(encoding="utf-8")
    result = exec_doc(doc_id, code, timeout=args.timeout)
    print(json.dumps(result, ensure_ascii=False, indent=2) if not isinstance(result, str) else result)


def command_screenshot(args: argparse.Namespace) -> None:
    doc_id = args.doc_id or focused_doc_id()
    print(json.dumps(screenshot(doc_id), ensure_ascii=False, indent=2))


def command_shapes(args: argparse.Namespace) -> None:
    doc_id = args.doc_id or focused_doc_id()
    print(json.dumps(shapes(doc_id), ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="tldraw Offline Canvas API bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("doctor")
    p.set_defaults(func=command_doctor)
    p = sub.add_parser("readme")
    p.set_defaults(func=command_readme)
    p = sub.add_parser("docs")
    p.set_defaults(func=command_docs)
    p = sub.add_parser("focused")
    p.set_defaults(func=command_focused)

    p = sub.add_parser("create")
    p.add_argument("name")
    p.set_defaults(func=command_create)

    p = sub.add_parser("exec-file")
    p.add_argument("file")
    p.add_argument("--doc-id")
    p.add_argument("--timeout", type=int, default=90)
    p.set_defaults(func=command_exec_file)

    p = sub.add_parser("screenshot")
    p.add_argument("--doc-id")
    p.set_defaults(func=command_screenshot)

    p = sub.add_parser("shapes")
    p.add_argument("--doc-id")
    p.set_defaults(func=command_shapes)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        args.func(args)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
