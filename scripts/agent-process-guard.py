#!/usr/bin/env python3
"""Protect workspace agent processes from accidental local termination."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = Path(os.environ.get("AGENT_PROCESS_STATE_DIR", ROOT / ".local" / "agent-processes"))
REGISTRY = STATE_DIR / "registry.json"
LOCK = STATE_DIR / "registry.lock"
ALLOWED_NAMES = {"hermes", "claude", "grok"}


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rfind(")") + 2:].split()[0] != "Z"
    except (ProcessLookupError, PermissionError):
        return False
    except OSError:
        return True


def parent_pid(pid: int) -> int:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().split()
        return int(fields[3])
    except (OSError, ValueError, IndexError):
        return 0


def ancestors(pid: int) -> set[int]:
    result: set[int] = set()
    while pid > 1 and pid not in result:
        result.add(pid)
        pid = parent_pid(pid)
    return result


def descendants(pid: int) -> set[int]:
    parents: dict[int, list[int]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        child = int(entry.name)
        parents.setdefault(parent_pid(child), []).append(child)
    result, pending = {pid}, [pid]
    while pending:
        for child in parents.get(pending.pop(), []):
            if child not in result:
                result.add(child)
                pending.append(child)
    return result


def process_group_members(pgid: int) -> set[int]:
    members: set[int] = set()
    if pgid <= 1:
        return members
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            if os.getpgid(pid) == pgid and pid_alive(pid):
                members.add(pid)
        except (ProcessLookupError, PermissionError):
            continue
    return members


def terminate_process_group(pgid: int, timeout: float = 5.0) -> None:
    if pgid <= 1 or pgid == os.getpgrp():
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not process_group_members(pgid):
            return
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def terminate_group_members_except(pgid: int, excluded: set[int], timeout: float = 2.0) -> None:
    targets = process_group_members(pgid) - excluded
    for pid in targets:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        targets = process_group_members(pgid) - excluded
        if not targets:
            return
        time.sleep(0.1)
    for pid in process_group_members(pgid) - excluded:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def with_registry(mutator):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            data = json.loads(REGISTRY.read_text()) if REGISTRY.exists() else {"sessions": []}
        except (OSError, json.JSONDecodeError):
            data = {"sessions": []}
        data["sessions"] = [
            item for item in data.get("sessions", [])
            if any(pid_alive(int(item.get(key, 0))) for key in ("supervisor_pid", "launcher_pid", "child_pid"))
        ]
        result = mutator(data)
        temp = REGISTRY.with_suffix(".tmp")
        temp.write_text(json.dumps(data, indent=2) + "\n")
        temp.replace(REGISTRY)
        return result


def validate_name(name: str) -> str:
    if name not in ALLOWED_NAMES:
        raise SystemExit(f"agent-process: name must be one of {', '.join(sorted(ALLOWED_NAMES))}")
    return name


def add_session(item: dict) -> None:
    with_registry(lambda data: data["sessions"].append(item))


def update_session(session_id: str, **updates) -> None:
    def mutate(data):
        for item in data["sessions"]:
            if item.get("id") == session_id:
                item.update(updates)
    with_registry(mutate)


def remove_session(session_id: str) -> None:
    with_registry(lambda data: data.update(
        sessions=[item for item in data["sessions"] if item.get("id") != session_id]
    ))


def cmd_run(args) -> int:
    validate_name(args.name)
    if not args.command:
        raise SystemExit("agent-process run requires a command after --")
    session_id = uuid.uuid4().hex
    if os.getpgrp() != os.getpid():
        os.setpgid(0, 0)
    pgid = os.getpgrp()
    stopping = False
    child: subprocess.Popen | None = None
    add_session({
        "id": session_id,
        "name": args.name,
        "mode": "foreground",
        "launcher_pid": os.getpid(),
        "owner_shell_pid": os.getppid(),
        "child_pid": 0,
        "process_group_id": pgid,
        "started_at": now(),
        "status": "starting",
        "restart_count": 0,
    })

    def forward(signum, _frame):
        nonlocal stopping
        stopping = True
        if child is not None and child.poll() is None:
            child.send_signal(signum)

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, forward)
    try:
        for attempt in range(2):
            child = subprocess.Popen(args.command)
            update_session(session_id, child_pid=child.pid, status="running",
                           restart_count=attempt, last_started_at=now())
            code = child.wait()
            terminate_group_members_except(pgid, {os.getpid()})
            reason = "requested stop" if stopping else f"exit {code}"
            update_session(session_id, child_pid=0, status=reason,
                           last_exit_code=code, last_exit_at=now())
            if stopping or code == 0 or attempt == 1:
                return code
            time.sleep(1)
        return 1
    finally:
        remove_session(session_id)


def cmd_start(args) -> int:
    validate_name(args.name)
    if not args.command:
        raise SystemExit("agent-process start requires a command after --")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(Path(__file__).resolve()), "_supervise",
               "--name", args.name, "--"] + args.command
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    print(f"Started protected {args.name} supervisor PID {process.pid}")
    return 0


def cmd_supervise(args) -> int:
    validate_name(args.name)
    session_id = uuid.uuid4().hex
    stop_file = STATE_DIR / f"{session_id}.stop"
    log_path = STATE_DIR / f"{args.name}-{session_id[:8]}.log"
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    item = {
        "id": session_id,
        "name": args.name,
        "mode": "supervised",
        "supervisor_pid": os.getpid(),
        "owner_shell_pid": 0,
        "child_pid": 0,
        "process_group_id": 0,
        "log_path": str(log_path.relative_to(ROOT)) if log_path.is_relative_to(ROOT) else str(log_path),
        "started_at": now(),
        "status": "starting",
        "restart_count": 0,
    }
    add_session(item)
    restarts = 0
    try:
        with log_path.open("a", buffering=1) as log:
            while not stopping and not stop_file.exists():
                log.write(f"{now()} starting {args.name}\n")
                child = subprocess.Popen(
                    args.command,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                child_pgid = child.pid
                update_session(session_id, child_pid=child.pid, process_group_id=child_pgid, status="running",
                               restart_count=restarts, last_started_at=now())
                while child.poll() is None and not stopping and not stop_file.exists():
                    time.sleep(0.25)
                if child.poll() is None:
                    terminate_process_group(child_pgid)
                    try:
                        child.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        terminate_process_group(child_pgid, timeout=0)
                        child.wait()
                elif process_group_members(child_pgid):
                    terminate_process_group(child_pgid)
                code = child.returncode
                reason = "requested stop" if stopping or stop_file.exists() else f"unexpected exit {code}"
                log.write(f"{now()} {reason}\n")
                update_session(session_id, child_pid=0, process_group_id=0,
                               status=reason, last_exit_code=code,
                               last_exit_at=now())
                if stopping or stop_file.exists():
                    break
                restarts += 1
                time.sleep(min(10, max(1, restarts)))
    finally:
        stop_file.unlink(missing_ok=True)
        remove_session(session_id)
    return 0


def cmd_status(_args) -> int:
    sessions = with_registry(lambda data: list(data["sessions"]))
    if not sessions:
        print("No protected agent sessions.")
        return 0
    for item in sessions:
        pids = {key: item.get(key, 0) for key in ("owner_shell_pid", "supervisor_pid", "launcher_pid", "child_pid")
                if item.get(key)}
        live = {key: pid for key, pid in pids.items() if pid_alive(int(pid))}
        print(f"{item['name']} {item['mode']} {item.get('status', 'unknown')} "
              f"pids={live} pgid={item.get('process_group_id', 0)} "
              f"restarts={item.get('restart_count', 0)}")
        if item.get("log_path"):
            print(f"  log={item['log_path']}")
    return 0


def protected_intersections(targets: set[int]) -> list[str]:
    sessions = with_registry(lambda data: list(data["sessions"]))
    conflicts = []
    target_tree = set().union(*(descendants(pid) for pid in targets))
    for item in sessions:
        protected = {
            int(item.get(key, 0))
            for key in ("owner_shell_pid", "supervisor_pid", "launcher_pid", "child_pid")
            if int(item.get(key, 0)) > 1 and pid_alive(int(item.get(key, 0)))
        }
        protected.update(process_group_members(int(item.get("process_group_id", 0))))
        protected_with_ancestors = set().union(*(ancestors(pid) for pid in protected)) if protected else set()
        if targets & protected_with_ancestors or target_tree & protected:
            conflicts.append(f"{item['name']}:{item['mode']} pids={sorted(protected)}")
    return conflicts


def cmd_kill(args) -> int:
    targets = {int(pid) for pid in args.pids}
    conflicts = protected_intersections(targets)
    if conflicts:
        print("REFUSED: target intersects a protected agent process tree:", file=sys.stderr)
        for conflict in conflicts:
            print(f"  {conflict}", file=sys.stderr)
        return 73
    signum = getattr(signal, args.signal)
    for pid in targets:
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass
    return 0


def cmd_stop(args) -> int:
    validate_name(args.name)
    sessions = with_registry(lambda data: list(data["sessions"]))
    matched = [item for item in sessions if item["name"] == args.name and item["mode"] == "supervised"]
    if not matched:
        print(f"No supervised {args.name} session is running.")
        return 1
    for item in matched:
        (STATE_DIR / f"{item['id']}.stop").touch()
        os.kill(int(item["supervisor_pid"]), signal.SIGTERM)
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="agent-process")
    sub = result.add_subparsers(dest="action", required=True)
    for action, handler in (("run", cmd_run), ("start", cmd_start), ("_supervise", cmd_supervise)):
        command = sub.add_parser(action, help=argparse.SUPPRESS if action.startswith("_") else None)
        command.add_argument("--name", required=True)
        command.add_argument("command", nargs=argparse.REMAINDER)
        command.set_defaults(handler=handler)
    status = sub.add_parser("status")
    status.set_defaults(handler=cmd_status)
    kill = sub.add_parser("kill")
    kill.add_argument("--signal", choices=("SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"), default="SIGTERM")
    kill.add_argument("pids", nargs="+")
    kill.set_defaults(handler=cmd_kill)
    stop = sub.add_parser("stop")
    stop.add_argument("--name", required=True)
    stop.set_defaults(handler=cmd_stop)
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    if arguments.action in {"run", "start", "_supervise"} and arguments.command[:1] == ["--"]:
        arguments.command = arguments.command[1:]
    raise SystemExit(arguments.handler(arguments))