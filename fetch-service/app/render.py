import json
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from .netguard import Resolver, host_is_public, is_ip_literal

SERVICE_ROOT = Path(__file__).resolve().parent.parent


def read_available_mb() -> int | None:
    """Free memory in MB on Linux, or None where it cannot be measured (Windows, macOS)."""
    try:
        with open("/proc/meminfo") as meminfo:
            for line in meminfo:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError):
        return None
    return None


class RenderError(RuntimeError):
    def __init__(self, message: str, detail: str = ""):
        super().__init__(message)
        # What actually went wrong, for the server's own log. It is never sent back to the caller,
        # because it can contain paths and page-controlled text.
        self.detail = detail


def request_allowed(url: str, resolver: Resolver) -> bool:
    """May the browser make this request? Only plain public web addresses on the standard ports."""
    if url.startswith(("data:", "blob:", "about:")):
        return True  # generated inside the page itself, so nothing leaves the browser
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not host or parts.username or parts.password:
        return False
    if port not in (None, 80, 443) or is_ip_literal(host):
        return False
    return host_is_public(host, resolver)


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kills the worker and everything it started, including the browser."""
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        proc.kill()


def run_hard(command: list[str], timeout_s: float, *, env: dict | None = None, cwd: str | None = None) -> str:
    """Runs a command with a hard wall-clock limit that no page can get past.

    A page that never stops running JavaScript freezes a browser from the inside, and a timeout
    inside the browser's own API cannot interrupt it. Killing the whole process tree from outside can.
    """
    options: dict = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "text": True, "env": env, "cwd": cwd}
    if os.name == "posix":
        options["start_new_session"] = True
    else:
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    proc = subprocess.Popen(command, **options)
    try:
        out, err = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        try:
            proc.communicate(timeout=5)
        except Exception:
            pass
        raise RenderError("the browser took too long and was stopped", detail=f"timed out after {timeout_s:.0f} s") from None
    if proc.returncode != 0:
        tail = f"{err or ''}\n{out or ''}".strip()[-600:]
        raise RenderError("the browser could not render the page", detail=f"exit code {proc.returncode}: {tail}")
    return out


def make_subprocess_renderer(
    timeout_ms: int,
    *,
    command: Callable[[str], list[str]] | None = None,
    grace_s: float = 15,
) -> Callable[[str], dict]:
    """Renders in a separate process so a stuck page can be killed and the next render still works."""

    def render(url: str) -> dict:
        argv = command(url) if command else [sys.executable, "-m", "app.render_worker", url]
        env = {**os.environ, "RENDER_TIMEOUT_MS": str(timeout_ms)}
        out = run_hard(argv, timeout_ms / 1000 + grace_s, env=env, cwd=str(SERVICE_ROOT))
        lines = [line for line in out.splitlines() if line.strip()]
        if not lines:
            raise RenderError("the browser returned nothing")
        try:
            data = json.loads(lines[-1])
        except ValueError:
            raise RenderError("the browser gave an unreadable answer") from None
        words, overflow = (data.get("words"), data.get("mobileOverflow")) if isinstance(data, dict) else (None, None)
        if not isinstance(words, int) or isinstance(words, bool) or not isinstance(overflow, bool):
            raise RenderError("the browser gave an unexpected answer")
        return {"words": words, "mobileOverflow": overflow}

    return render


def make_scrapling_renderer(timeout_ms: int, resolver: Resolver) -> Callable[[str], dict]:
    """Opens the page in a real headless browser and measures it. Nothing leaves except two numbers.

    This runs inside the worker process (render_worker.py), never in the web server.

    The request filter below is best effort: it refuses requests to private or non-standard-port
    addresses and blocks WebSockets, but it cannot see DNS rebinding (the browser resolves a name a
    second time) or service-worker traffic. The real boundary is the container's firewall rules
    (deploy/vm/egress-rules.sh). Scrapling logs and swallows any error raised inside its page_setup
    and page_action hooks and carries on, so each hook records that it ran, and a missing record
    discards the result.
    """

    def render(url: str) -> dict:
        from scrapling.fetchers import DynamicFetcher  # imported late: it is heavy and only needed here

        state: dict = {"filter": False, "measured": False}

        def setup(page):
            def handler(route):
                if request_allowed(route.request.url, resolver):
                    route.continue_()
                else:
                    route.abort()

            page.route("**/*", handler)
            page.route_web_socket("**/*", lambda ws: ws.close())
            state["filter"] = True

        def measure(page):
            state["words"] = int(page.evaluate("document.body ? document.body.innerText.split(/\\s+/).filter(Boolean).length : 0"))
            page.set_viewport_size({"width": 390, "height": 844})  # a typical phone
            page.wait_for_timeout(400)
            state["overflow"] = bool(page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
            state["measured"] = True

        DynamicFetcher.fetch(
            url,
            headless=True,
            network_idle=True,
            timeout=timeout_ms,
            retries=1,
            google_search=False,
            page_setup=setup,
            page_action=measure,
        )
        if not state["filter"]:
            raise RenderError("the request filter was not installed")
        if not state["measured"]:
            raise RenderError("the page could not be measured")
        return {"words": state["words"], "mobileOverflow": state["overflow"]}

    return render
