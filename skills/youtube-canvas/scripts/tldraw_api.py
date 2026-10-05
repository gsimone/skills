#!/usr/bin/env python3
"""Small stdlib bridge for tldraw Offline's local Canvas API."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import time
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
    encoded = urllib.parse.quote(doc_id, safe=":")
    result = unwrap(request("POST", f"/api/doc/{encoded}/exec", {"code": code}, timeout=timeout))
    if isinstance(result, dict) and result.get("success") is False:
        raise RuntimeError(f"tldraw document execution failed: {result.get('error')}")
    return result


def document_info(doc_id: str) -> dict[str, Any]:
    docs = list_docs()
    if not isinstance(docs, list):
        raise RuntimeError(f"unexpected document-list response: {docs!r}")
    doc = next((item for item in docs if isinstance(item, dict) and item.get("id") == doc_id), None)
    if doc is None:
        raise RuntimeError(f"document was not found after rendering: {doc_id}")
    return doc


def save_doc_if_local(doc_id: str) -> bool:
    if document_info(doc_id).get("ownership") != "local":
        return False
    exec_doc(doc_id, "await helpers.saveDoc(); return true")
    return True


def script_workspace(doc_id: str) -> dict[str, Any]:
    encoded = urllib.parse.quote(doc_id, safe=":")
    response = unwrap(request("POST", f"/api/doc/{encoded}/script-workspace", {}))
    if not isinstance(response, dict):
        raise RuntimeError(f"unexpected script-workspace response: {response!r}")
    return response


def script_status(doc_id: str) -> dict[str, Any]:
    encoded = urllib.parse.quote(doc_id, safe=":")
    response = unwrap(request("GET", f"/api/doc/{encoded}/script-status"))
    if not isinstance(response, dict):
        raise RuntimeError(f"unexpected script-status response: {response!r}")
    return response


def install_board_script(doc_id: str, source_dir: Path, timeout: float = 10) -> dict[str, Any]:
    if document_info(doc_id).get("ownership") != "local":
        return {"installed": False, "reason": "document is not locally owned"}

    workspace = script_workspace(doc_id)
    main_path = Path(str(workspace.get("mainJsPath") or ""))
    script_dir = Path(str(workspace.get("scriptDir") or ""))
    if not main_path.is_file() or not script_dir.is_dir():
        raise RuntimeError(f"script workspace returned invalid paths: {workspace!r}")

    managed_marker = "youtube-canvas-managed-board-script"
    existing_main = main_path.read_text(encoding="utf-8")
    existing_siblings = [path for path in script_dir.iterdir() if path.name != main_path.name]
    is_managed = managed_marker in existing_main
    is_untouched_default = workspace.get("isDefaultScript") and not existing_siblings
    if not is_managed and not is_untouched_default:
        return {"installed": False, "reason": "document already has an unrelated board script"}

    filenames = ("youtubePlayer.js", "config.js", "main.js")
    sources: dict[str, Path] = {}
    changed = False
    for filename in filenames:
        source = source_dir / filename
        if not source.is_file():
            raise RuntimeError(f"missing board-script source: {source}")
        destination = script_dir / filename
        sources[filename] = source
        changed = changed or (
            not destination.is_file() or destination.read_bytes() != source.read_bytes()
        )

    before_status = script_status(doc_id)
    before_digest = before_status.get("currentDiskDigest")
    for filename in filenames:
        shutil.copyfile(sources[filename], script_dir / filename)

    if not changed and before_status.get("state") == "applied":
        return {"installed": True, "state": "applied"}

    deadline = time.monotonic() + timeout
    status: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status = script_status(doc_id)
        current_digest = status.get("currentDiskDigest")
        applied_digest = status.get("lastAppliedDigest")
        applied_new_digest = current_digest != before_digest and applied_digest == current_digest
        if status.get("state") == "applied" and applied_new_digest:
            return {"installed": True, "state": "applied"}
        if status.get("state") == "error":
            raise RuntimeError(f"board script failed to apply: {status.get('lastApplyError')}")
        time.sleep(0.2)
    raise RuntimeError(f"board script did not apply before timeout: {status!r}")


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

    missing = [name for name in ("yt-dlp",) if not status[name]]
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
