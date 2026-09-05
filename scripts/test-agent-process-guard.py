#!/usr/bin/env python3
"""Disposable integration checks for agent-process-guard.py."""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent
GUARD = ROOT / "scripts" / "agent-process-guard.py"


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class AgentProcessGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "state"
        self.env = {**os.environ, "AGENT_PROCESS_STATE_DIR": str(self.state)}
        self.processes: list[subprocess.Popen] = []

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                try:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
        self.temp.cleanup()

    def guard(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(GUARD), *args],
            env=self.env,
            text=True,
            capture_output=True,
            check=check,
        )

    def wait_registry(self, predicate, timeout: float = 5):
        deadline = time.monotonic() + timeout
        registry = self.state / "registry.json"
        while time.monotonic() < deadline:
            if registry.exists():
                data = json.loads(registry.read_text())
                if predicate(data.get("sessions", [])):
                    return data["sessions"]
            time.sleep(0.05)
        self.fail("registry did not reach expected state")

    def test_refuses_protected_leader_child_and_owner_ancestor(self):
        process = subprocess.Popen(
            [sys.executable, str(GUARD), "run", "--name", "hermes", "--", "sleep", "30"],
            env=self.env,
            start_new_session=True,
        )
        self.processes.append(process)
        session = self.wait_registry(lambda rows: rows and rows[0].get("child_pid"))[0]
        for target in (process.pid, int(session["child_pid"]), os.getpid()):
            result = self.guard("kill", str(target), check=False)
            self.assertEqual(result.returncode, 73)
            self.assertIn("REFUSED", result.stderr)
        self.assertIsNone(process.poll())

    def test_allows_unprotected_termination(self):
        process = subprocess.Popen(["sleep", "30"], start_new_session=True)
        self.processes.append(process)
        self.guard("kill", str(process.pid))
        process.wait(timeout=2)

    def test_restarts_unexpected_exit(self):
        counter = Path(self.temp.name) / "counter"
        command = f"echo run >> {counter}; exit 7"
        self.guard("start", "--name", "grok", "--", "sh", "-c", command)
        sessions = self.wait_registry(lambda rows: rows and rows[0].get("restart_count", 0) >= 1)
        self.assertGreaterEqual(len(counter.read_text().splitlines()), 2)
        supervisor = int(sessions[0]["supervisor_pid"])
        self.guard("stop", "--name", "grok")
        deadline = time.monotonic() + 3
        while alive(supervisor) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(alive(supervisor))

    def test_foreground_launcher_retries_unexpected_exit_once(self):
        counter = Path(self.temp.name) / "foreground-counter"
        command = (
            f"n=$(cat {counter} 2>/dev/null || echo 0); n=$((n+1)); "
            f"echo $n > {counter}; test $n -ge 2"
        )
        result = self.guard("run", "--name", "hermes", "--", "sh", "-c", command)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(counter.read_text().strip(), "2")

    def test_stop_cleans_entire_supervised_process_group(self):
        pid_file = Path(self.temp.name) / "descendant.pid"
        child_code = (
            "import os,signal,time;"
            "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
            f"open({str(pid_file)!r},'w').write(str(os.getpid()));"
            "time.sleep(30)"
        )
        leader_code = (
            "import signal,subprocess,time;"
            "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
            f"subprocess.Popen([{sys.executable!r},'-c',{child_code!r}]);"
            "time.sleep(30)"
        )
        self.guard("start", "--name", "claude", "--", sys.executable, "-c", leader_code)
        sessions = self.wait_registry(lambda rows: rows and rows[0].get("child_pid"))
        supervisor = int(sessions[0]["supervisor_pid"])
        deadline = time.monotonic() + 3
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(pid_file.exists())
        descendant = int(pid_file.read_text())
        self.guard("stop", "--name", "claude")
        deadline = time.monotonic() + 7
        while (alive(supervisor) or alive(descendant)) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(alive(supervisor))
        self.assertFalse(alive(descendant))


if __name__ == "__main__":
    unittest.main()