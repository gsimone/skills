from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import render_canvas  # noqa: E402
import validate_analysis  # noqa: E402
import youtube  # noqa: E402


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
                    "visuals": [],
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
        data = render_canvas.enrich_analysis(analysis, manifest, {})
        js = render_canvas.generate_js(data)
        self.assertIn("youtubeCanvas", js)
        self.assertIn("oldShapes", js)
        self.assertIn("oldAssets", js)
        self.assertIn("https://youtu.be/abc123xyz?t=5", js)
        self.assertIn("type: 'embed'", js)


if __name__ == "__main__":
    unittest.main()
