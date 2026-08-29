from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import render_canvas  # noqa: E402
import tldraw_api  # noqa: E402
import validate_analysis  # noqa: E402
import youtube  # noqa: E402


class TldrawApiTests(unittest.TestCase):
    @patch("tldraw_api.request")
    def test_exec_doc_preserves_colons_in_document_id(self, request: Mock) -> None:
        request.return_value = {"result": True}
        self.assertTrue(tldraw_api.exec_doc("tldr:file:abc", "return true"))
        request.assert_called_once_with(
            "POST",
            "/api/doc/tldr:file:abc/exec",
            {"code": "return true"},
            timeout=60,
        )

    @patch("tldraw_api.exec_doc")
    @patch("tldraw_api.list_docs")
    def test_save_doc_if_local(self, list_docs: Mock, exec_doc: Mock) -> None:
        list_docs.return_value = [{"id": "tldr:file:abc", "ownership": "local"}]
        self.assertTrue(tldraw_api.save_doc_if_local("tldr:file:abc"))
        exec_doc.assert_called_once_with(
            "tldr:file:abc",
            "await helpers.saveDoc(); return true",
        )

    def test_install_board_script(self) -> None:
        source_dir = ROOT / "scripts" / "board_script"
        with tempfile.TemporaryDirectory() as td:
            script_dir = Path(td) / "script"
            script_dir.mkdir()
            main_path = script_dir / "main.js"
            main_path.write_text("// default")
            workspace = {
                "scriptDir": str(script_dir),
                "mainJsPath": str(main_path),
                "isDefaultScript": True,
            }
            with patch(
                "tldraw_api.document_info", return_value={"ownership": "local"}
            ), patch(
                "tldraw_api.script_workspace", return_value=workspace
            ), patch(
                "tldraw_api.script_status", return_value={"state": "applied"}
            ):
                result = tldraw_api.install_board_script("tldr:file:abc", source_dir)

            self.assertEqual(result, {"installed": True, "state": "applied"})
            self.assertIn("youtube-canvas-managed-board-script", main_path.read_text())
            self.assertTrue((script_dir / "config.js").is_file())
            self.assertTrue((script_dir / "youtubePlayer.js").is_file())

    def test_install_board_script_preserves_unrelated_script(self) -> None:
        source_dir = ROOT / "scripts" / "board_script"
        with tempfile.TemporaryDirectory() as td:
            script_dir = Path(td) / "script"
            script_dir.mkdir()
            main_path = script_dir / "main.js"
            main_path.write_text("// user's script")
            workspace = {
                "scriptDir": str(script_dir),
                "mainJsPath": str(main_path),
                "isDefaultScript": False,
            }
            with patch(
                "tldraw_api.document_info", return_value={"ownership": "local"}
            ), patch("tldraw_api.script_workspace", return_value=workspace):
                result = tldraw_api.install_board_script("tldr:file:abc", source_dir)

            self.assertEqual(
                result,
                {"installed": False, "reason": "document already has an unrelated board script"},
            )
            self.assertEqual(main_path.read_text(), "// user's script")
            self.assertFalse((script_dir / "config.js").exists())


class VttTests(unittest.TestCase):
    def test_parse_and_reduce_rolling_captions(self) -> None:
        vtt = """WEBVTT

00:00:01.000 --> 00:00:03.000
we are going to build

00:00:02.000 --> 00:00:05.000
we are going to build a renderer

00:00:05.000 --> 00:00:07.000
a renderer that stays local
"""
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "x.vtt"
            path.write_text(vtt)
            cues = youtube.parse_vtt(path)
        text = " ".join(c.text for c in cues)
        self.assertIn("we are going to build", text)
        self.assertIn("a renderer", text)
        self.assertIn("that stays local", text)
        self.assertLess(text.count("we are going to build"), 2)


class AnalysisTests(unittest.TestCase):
    def test_valid_analysis(self) -> None:
        data = {
            "mode": "research",
            "summary": "x",
            "keyIdeas": ["a"],
            "segments": [
                {
                    "id": "seg-001",
                    "start": 2,
                    "end": 8,
                    "title": "A",
                    "summary": "B",
                    "cluster": "C",
                    "visuals": [{"timestamp": 4, "reason": "diagram"}],
                }
            ],
        }
        self.assertEqual(validate_analysis.validate(data, 10), [])

    def test_rejects_non_chronological(self) -> None:
        base = lambda i, start: {  # noqa: E731
            "id": f"seg-{i:03d}",
            "start": start,
            "end": start + 2,
            "title": "A",
            "summary": "B",
            "cluster": "C",
        }
        data = {
            "mode": "research",
            "summary": "x",
            "keyIdeas": [],
            "segments": [base(1, 10), base(2, 2)],
        }
        self.assertTrue(any("chronologically" in x for x in validate_analysis.validate(data)))


class RendererTests(unittest.TestCase):
    def test_generated_javascript_contains_preservation_marker(self) -> None:
        analysis = {
            "mode": "research",
            "summary": "Summary",
            "keyIdeas": ["Idea"],
            "segments": [
                {
                    "id": "seg-001",
                    "start": 5,
                    "end": 20,
                    "title": "Title",
                    "summary": "Body",
                    "whyItMatters": "Because",
                    "quote": "Quote",
                    "cluster": "Theme",
                    "tags": [],
                    "visuals": [
                        {"timestamp": 6, "reason": "first diagram"},
                        {"timestamp": 12, "reason": "second diagram"},
                    ],
                }
            ],
        }
        manifest = {
            "videoId": "abc123xyz",
            "title": "Video",
            "channel": "Channel",
            "duration": 100,
            "url": "https://www.youtube.com/watch?v=abc123xyz",
        }
        frames = {
            ("seg-001", 6): {
                "timestamp": 6,
                "reason": "first diagram",
                "filename": "first.jpg",
                "dataUri": "data:image/jpeg;base64,Zmlyc3Q=",
            },
            ("seg-001", 12): {
                "timestamp": 12,
                "reason": "second diagram",
                "filename": "second.jpg",
                "dataUri": "data:image/jpeg;base64,c2Vjb25k",
            },
        }
        data = render_canvas.enrich_analysis(analysis, manifest, frames)
        js = render_canvas.generate_js(data)
        self.assertIn("youtubeCanvas", js)
        self.assertIn("oldShapes", js)
        self.assertIn("oldAssets", js)
        self.assertIn("https://youtu.be/abc123xyz?t=5", js)
        self.assertIn("type: 'embed'", js)
        self.assertIn("title: DATA.manifest.title", js)
        self.assertIn("kind: 'source-link'", js)
        self.assertIn("seg.frames.entries()", js)
        self.assertNotIn("seg.frames[0]", js)
        self.assertIn('"imageH": 648', js)
        self.assertEqual(render_canvas.count_frames(data), 2)


if __name__ == "__main__":
    unittest.main()
