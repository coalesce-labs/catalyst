"""mitmproxy addon: log every Linear GraphQL call with operation, rate-limit
headers, AND caller attribution (PID → parent command → CATALYST_* env).

Run:  mitmdump -s <path-to-this-file> --listen-port 8080
Log:  ~/catalyst/linear-proxy.jsonl  (one JSON object per Linear response)
      Override via MITM_LOG env var.

Caller attribution: the immediate client is always a short-lived `node`
(linearis), so we record its PARENT command (the daemon / a phase-agent claude /
orch-monitor / broker / interactive shell) plus any CATALYST_TICKET / phase /
orchestrator env it inherited. lsof runs during the `request` hook while the
node process is still blocked on the response, so the socket is live.
"""
import json
import os
import re
import subprocess
import time
from mitmproxy import http

# CTL-696: portable LOG path so the vendored copy works on any host.
LOG = os.environ.get(
    "MITM_LOG",
    os.path.join(os.path.expanduser("~"), "catalyst", "linear-proxy.jsonl"),
)
_OP_RE = re.compile(r"\b(query|mutation|subscription)\s+(\w+)")
_ENV_KEYS = (("CATALYST_TICKET", "ticket"), ("CATALYST_PHASE", "phase"),
             ("ORCHESTRATOR_ID", "orch"), ("CATALYST_BG_JOB_ID", "bg_job"))


def _run(args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=2).stdout
    except Exception:
        return ""


def _caller(port: int) -> dict:
    info = {"pid": None, "cmd": None, "parent": None, "ticket": None,
            "phase": None, "orch": None, "bg_job": None}
    # lsof -iTCP:<port> matches BOTH ends of the localhost socket (the node
    # client AND mitmdump). -Fpcn streams p<pid>/c<cmd>/n<name> blocks; pick the
    # process whose LOCAL port is the ephemeral one — its name reads
    # "...:<port>->...:8080" (ephemeral before the arrow), vs mitmdump's
    # "...:8080->...:<port>".
    pid = cmd = None
    cur_pid = cur_cmd = None
    for line in _run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:ESTABLISHED", "-Fpcn"]).splitlines():
        tag, val = line[:1], line[1:].strip()
        if tag == "p":
            cur_pid = val
        elif tag == "c":
            cur_cmd = val
        elif tag == "n" and f":{port}->" in val:
            pid, cmd = cur_pid, cur_cmd
            break
    if not pid:
        return info
    info["pid"] = pid
    if cmd:
        info["cmd"] = cmd.rsplit("/", 1)[-1]
    row = _run(["ps", "-o", "ppid=,comm=", "-p", pid]).strip()
    if row:
        parts = row.split(None, 1)
        ppid = parts[0]
        info["cmd"] = (parts[1] if len(parts) > 1 else "").rsplit("/", 1)[-1]
        info["parent"] = _run(["ps", "-o", "command=", "-p", ppid]).strip()[:90]
    # macOS `ps -E` appends the environment to the command column
    env = _run(["ps", "-Eww", "-o", "command=", "-p", pid])
    for key, dst in _ENV_KEYS:
        m = re.search(key + r"=(\S+)", env)
        if m:
            info[dst] = m.group(1)
    return info


def request(flow: http.HTTPFlow) -> None:
    if "api.linear.app" not in flow.request.pretty_host:
        return
    try:
        flow.metadata["caller"] = _caller(flow.client_conn.peername[1])
    except Exception:
        pass


def _op(flow: http.HTTPFlow) -> str:
    try:
        body = json.loads(flow.request.get_text() or "{}")
        items = body if isinstance(body, list) else [body]
        ops = []
        for b in items:
            name = b.get("operationName")
            if not name:
                m = _OP_RE.search((b.get("query") or "").lstrip())
                name = f"{m.group(1)} {m.group(2)}" if m else "?"
            ops.append(name)
        return ",".join(ops) or "?"
    except Exception:
        return "?"


def response(flow: http.HTTPFlow) -> None:
    if "api.linear.app" not in flow.request.pretty_host:
        return
    h = flow.response.headers
    c = flow.metadata.get("caller") or {}
    rec = {
        "ts": time.strftime("%H:%M:%S"),
        "op": _op(flow),
        "status": flow.response.status_code,
        "rl_remaining": h.get("X-RateLimit-Requests-Remaining"),
        "rl_limit": h.get("X-RateLimit-Requests-Limit"),
        "rl_reset": h.get("X-RateLimit-Requests-Reset"),
        "complexity": h.get("X-Complexity"),
        "cplx_remaining": h.get("X-RateLimit-Complexity-Remaining"),
        "cplx_limit": h.get("X-RateLimit-Complexity-Limit"),
        "cplx_reset": h.get("X-RateLimit-Complexity-Reset"),
        "caller": c.get("cmd"),
        "parent": c.get("parent"),
        "pid": c.get("pid"),
        "ticket": c.get("ticket"),
        "phase": c.get("phase"),
        "orch": c.get("orch"),
        "bg_job": c.get("bg_job"),
    }
    with open(LOG, "a") as fh:
        fh.write(json.dumps(rec) + "\n")
    print(
        f"[linear] {rec['ts']} {rec['op']:<26} -> {rec['status']} "
        f"rem={rec['rl_remaining']} | {rec['caller']} <- {(rec['parent'] or '')[:50]} "
        f"ticket={rec['ticket']} phase={rec['phase']}"
    )
