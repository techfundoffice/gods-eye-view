#!/usr/bin/env python3
"""Restore the workspace Hermes Nous profile without touching credentials."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import tempfile
from typing import Any

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


CONFIG_VERSION = 39
REQUIRED_PROFILE: dict[str, Any] = {
    "model": {
        "default": "google/gemini-3.8-flash",
        "provider": "nous",
        "base_url": "https://inference-api.nousresearch.com/v1",
    },
    "web": {"backend": "nous"},
    "browser": {"cloud_provider": "nous"},
    "tts": {"provider": "nous"},
    "stt": {"provider": "nous"},
    "approvals": {"mode": False},
    "_config_version": CONFIG_VERSION,
    "image_gen": {"provider": "nous"},
    "video_gen": {"provider": "nous"},
    "onboarding": {
        "seen": {
            "busy_input_prompt": True,
            "tool_progress_prompt": True,
        },
    },
}


def _merge_required(current: dict[str, Any], required: dict[str, Any]) -> None:
    for key, required_value in required.items():
        if isinstance(required_value, dict):
            current_value = current.get(key)
            if not isinstance(current_value, dict):
                current_value = {}
                current[key] = current_value
            _merge_required(current_value, required_value)
        else:
            current[key] = required_value


def _is_gev_mcp(name: object) -> bool:
    normalized = str(name or "").strip().lower().replace("_", "-")
    return normalized == "gev" or "gods-eye-view" in normalized or "cloud-computer-ai" in normalized


def restored_config(raw: object) -> dict[str, Any]:
    """Return a restored config while preserving unrelated user settings."""
    config = dict(raw) if isinstance(raw, dict) else {}
    _merge_required(config, REQUIRED_PROFILE)

    servers = config.get("mcp_servers")
    if isinstance(servers, dict):
        kept = {name: value for name, value in servers.items() if not _is_gev_mcp(name)}
        if kept:
            config["mcp_servers"] = kept
        else:
            config.pop("mcp_servers", None)
    return config


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    parsed = yaml.safe_load(path.read_text(encoding="utf-8"))
    return parsed if isinstance(parsed, dict) else {}


def write_atomic(path: Path, config: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = yaml.safe_dump(config, sort_keys=False, allow_unicode=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def default_config_path() -> Path:
    root = Path(__file__).resolve().parent.parent
    hermes_home = Path(os.environ.get("HERMES_HOME", root / ".hermes"))
    return hermes_home / "config.yaml"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=default_config_path())
    parser.add_argument("--check", action="store_true", help="Exit nonzero if restoration would change the file.")
    args = parser.parse_args()

    current = load_config(args.config)
    restored = restored_config(current)
    if current == restored:
        print("[hermes-config] Nous provider profile is current.")
        return 0
    if args.check:
        print("[hermes-config] Nous provider profile requires restoration.")
        return 1
    write_atomic(args.config, restored)
    print("[hermes-config] Restored Nous provider profile.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())