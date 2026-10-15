import json
import os
import re
import signal
import subprocess
import sys
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from .netguard import Resolver, host_is_public, is_ip_literal

SERVICE_ROOT = Path(__file__).resolve().parent.parent

# How many of each the browser saw after JavaScript ran, to compare with the HTML a bot is served.
IDLE_WAIT_MS = 3_000


def WEBSOCKET_HANDLER(ws) -> None:  # noqa: N802 - a constant-like hook, named for how it is used
    """Mocks a WebSocket without connecting it to the real server. See setup() in make_scrapling_renderer."""
    return None
STRUCTURE_KEYS = ("h1", "links", "jsonLd", "titleChars", "lcpMs", "clsMilli", "inpMs", "hydrationErrors")
# The kind of element the largest paint was. A fixed list, because the tag comes from the page.
LCP_TAGS = frozenset({"img", "image", "video", "svg", "picture", "canvas", "h1", "h2", "h3", "p", "span", "div", "a", "section", "article", "main", "li", "text"})

# Installed before the page runs, so it sees the first paint and every shift. It stores numbers only.
OBSERVER_SCRIPT = """
(() => {
  const s = (window.__sr = { lcp: 0, lcpTag: '', cls: 0, inp: 0 });
  const watch = (type, extra, fn) => {
    try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe(Object.assign({ type, buffered: true }, extra)); } catch (e) {}
  };
  watch('largest-contentful-paint', {}, (e) => { s.lcp = e.startTime; s.lcpTag = e.element ? String(e.element.tagName || '').toLowerCase() : ''; });
  watch('layout-shift', {}, (e) => { if (!e.hadRecentInput) s.cls += e.value; });
  watch('event', { durationThreshold: 16 }, (e) => { if (e.interactionId) s.inp = Math.max(s.inp, e.duration); });
})();
"""

# Messages frameworks print when server HTML and the client's own render disagree. Only errors and
# warnings count, and only these phrases: a theme that logs "hydrating 345 sections" at debug level is
# doing ordinary work, and counting it would put a false problem in the report.
_HYDRATION_PHRASES = re.compile(
    r"hydration (failed|mismatch|error|node mismatch|completed but contains mismatches)"
    r"|error while hydrating"
    r"|text content does not match"
    r"|(text content|prop `[^`]*`|attribute `[^`]*`|extra attributes[^.]*|expected server html)[^.]{0,40}did not match"
    r"|minified react error #(418|423|425)",
    re.IGNORECASE,
)


def is_hydration_error(kind: str, text: str) -> bool:
    """True for a console error or warning that reports a hydration mismatch."""
    return kind in ("error", "warning", "warn") and bool(_HYDRATION_PHRASES.search(text))


def keep_known(data: dict, result: dict) -> None:
    """Copies the measured numbers and the element tag from a worker answer, dropping anything unexpected."""
    for key in STRUCTURE_KEYS:
        value = data.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10_000_000:
            result[key] = value
    tag = data.get("lcpTag")
    if isinstance(tag, str) and tag in LCP_TAGS:
        result["lcpTag"] = tag


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


def cached_resolver(resolver: Resolver) -> Resolver:
    """Wraps a resolver so each name is looked up once per render, failures included.

    A real page makes hundreds of requests to a few dozen names, and the browser's request filter runs
    for every one of them on the browser's own thread. Looking each one up again made a busy page take
    minutes and lose the measurement. One render lives for under a minute, so remembering an answer for
    that long adds no exposure the firewall rules do not already cover.
    """
    cache: dict = {}

    def resolve(host, *args, **kwargs):
        if host in cache:
            answer = cache[host]
            if isinstance(answer, OSError):
                raise answer
            return answer
        try:
            answer = resolver(host, *args, **kwargs)
        except OSError as exc:
            cache[host] = exc
            raise
        cache[host] = answer
        return answer

    return resolve


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
        result = {"words": words, "mobileOverflow": overflow}
        # Numbers and one tag from a fixed list. Nothing the page wrote leaves the worker.
        keep_known(data, result)
        return result

    return render


def make_scrapling_renderer(timeout_ms: int, resolver: Resolver) -> Callable[[str], dict]:
    """Opens the page in a real headless browser and measures it. Nothing leaves except numbers: no text from the page.

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

        lookup = cached_resolver(resolver)

        state: dict = {"filter": False, "measured": False}

        def setup(page):
            def handler(route):
                if request_allowed(route.request.url, lookup):
                    route.continue_()
                else:
                    route.abort()

            page.route("**/*", handler)
            # A WebSocket handler that never calls connect_to_server mocks the socket: the page sees it open,
            # and nothing reaches the network. Closing every socket at once looked safer, but sites with a
            # chat widget then reconnect in a tight loop that starves the browser and loses the whole render.
            page.route_web_socket("**/*", WEBSOCKET_HANDLER)
            page.add_init_script(OBSERVER_SCRIPT)
            state["hydration"] = 0

            def on_console(message):
                # Counted, never kept: the text is the page's own.
                if is_hydration_error(message.type, message.text):
                    state["hydration"] += 1

            page.on("console", on_console)
            state["filter"] = True

        def measure(page):
            # Wait briefly for the page to go quiet, and carry on if it never does. Many real sites keep
            # firing analytics and ad requests for ever, so a wait for "network idle" with no limit would
            # outlast the time allowed and lose the whole measurement.
            try:
                page.wait_for_load_state("networkidle", timeout=IDLE_WAIT_MS)
            except Exception:
                pass
            state["words"] = int(page.evaluate("document.body ? document.body.innerText.split(/\\s+/).filter(Boolean).length : 0"))
            page.set_viewport_size({"width": 390, "height": 844})  # a typical phone
            page.wait_for_timeout(400)
            state["overflow"] = bool(page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
            state["h1"] = int(page.evaluate("document.querySelectorAll('h1').length"))
            state["links"] = int(page.evaluate("Array.from(document.querySelectorAll('a[href]')).filter(a => a.origin === location.origin).length"))
            state["jsonLd"] = int(page.evaluate("document.querySelectorAll('script[type=\"application/ld+json\"]').length"))
            state["titleChars"] = int(page.evaluate("document.title.length"))
            # A harmless key press and a click in the corner, so the browser records how fast the page responds.
            try:
                page.keyboard.press("Shift")
                page.mouse.click(1, 1)
            except Exception:
                pass
            page.wait_for_timeout(400)
            vitals = page.evaluate("window.__sr || {lcp: 0, lcpTag: '', cls: 0, inp: 0}")
            # Headless Chrome sometimes has not reported the largest paint yet. Wait a little for it: 0 means not measured.
            for _ in range(6):
                if float(vitals.get("lcp") or 0) > 0:
                    break
                page.wait_for_timeout(300)
                vitals = page.evaluate("window.__sr || {lcp: 0, lcpTag: '', cls: 0, inp: 0}")
            state["lcpMs"] = max(0, int(round(float(vitals.get("lcp") or 0))))
            state["clsMilli"] = max(0, int(round(float(vitals.get("cls") or 0) * 1000)))
            state["inpMs"] = max(0, int(round(float(vitals.get("inp") or 0))))
            state["lcpTag"] = str(vitals.get("lcpTag") or "")
            state["hydrationErrors"] = int(state.get("hydration", 0))
            state["measured"] = True

        DynamicFetcher.fetch(
            url,
            headless=True,
            network_idle=False,  # measure() waits a bounded time for quiet instead of up to the full timeout
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
        result = {"words": state["words"], "mobileOverflow": state["overflow"]}
        keep_known(state, result)
        return result

    return render
