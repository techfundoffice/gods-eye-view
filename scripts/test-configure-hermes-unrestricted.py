#!/usr/bin/env python3
"""Focused tests for the durable Hermes provider-profile restorer."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

try:
    import yaml
except ModuleNotFoundError:
    pinned_python = (
        Path(__file__).resolve().parent.parent
        / ".hermes"
        / "hermes-agent"
        / "venv"
        / "bin"
        / "python"
    )
    if pinned_python.is_file() and Path(sys.executable).resolve() != pinned_python.resolve():
        os.execv(str(pinned_python), [str(pinned_python), *sys.argv])
    raise


SCRIPT = Path(__file__).with_name("configure-hermes-unrestricted.py")
SPEC = importlib.util.spec_from_file_location("configure_hermes_unrestricted", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class HermesConfigRestorationTests(unittest.TestCase):
    def test_reduced_config_recovers_complete_nous_profile(self) -> None:
        restored = MODULE.restored_config({"approvals": {"mode": True}})
        self.assertEqual(restored["model"]["provider"], "nous")
        self.assertEqual(restored["model"]["default"], "google/gemini-3.8-flash")
        self.assertEqual(restored["web"]["backend"], "nous")
        self.assertEqual(restored["browser"]["cloud_provider"], "nous")
        self.assertEqual(restored["tts"]["provider"], "nous")
        self.assertEqual(restored["stt"]["provider"], "nous")
        self.assertEqual(restored["image_gen"]["provider"], "nous")
        self.assertEqual(restored["video_gen"]["provider"], "nous")
        self.assertFalse(restored["approvals"]["mode"])
        self.assertEqual(restored["_config_version"], 39)

    def test_unrelated_settings_and_mcp_survive_but_gev_mcp_does_not(self) -> None:
        restored = MODULE.restored_config({
            "display": {"interface": "tui"},
            "mcp_servers": {
                "calendar": {"url": "https://example.test/mcp"},
                "gods-eye-view": {"url": "http://127.0.0.1:5000/api/admin/mcp"},
            },
        })
        self.assertEqual(restored["display"], {"interface": "tui"})
        self.assertEqual(list(restored["mcp_servers"]), ["calendar"])

    def test_atomic_write_round_trips_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.yaml"
            path.write_text("approvals:\n  mode: true\n", encoding="utf-8")
            restored = MODULE.restored_config(MODULE.load_config(path))
            MODULE.write_atomic(path, restored)
            loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
            self.assertEqual(loaded, restored)
            self.assertEqual(MODULE.restored_config(loaded), loaded)


if __name__ == "__main__":
    unittest.main()