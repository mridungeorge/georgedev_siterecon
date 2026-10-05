"""Review fixes: a render that hangs must be killed, the browser request filter, and URL strictness."""

import os
import subprocess
import sys
import time

import pytest

from app.render import RenderError, make_subprocess_renderer, request_allowed, run_hard
from app.routing import url_matches_platform
from conftest import AUTH, make_client, public_resolver


def pid_alive(pid: int) -> bool:
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def py(code: str) -> list[str]:
    return [sys.executable, "-c", code]


class TestRunHard:
    def test_returns_what_the_command_printed(self):
        assert run_hard(py("print('hello')"), 10).strip() == "hello"

    def test_kills_a_command_that_never_ends_within_the_time_limit(self):
        started = time.monotonic()
        with pytest.raises(RenderError, match="too long"):
            run_hard(py("import time; time.sleep(60)"), 1)
        assert time.monotonic() - started < 6

    def test_also_kills_the_processes_the_command_started(self, tmp_path):
        # Chromium is a child of the worker. Killing only the worker would leave the browser running.
        pidfile = tmp_path / "grandchild.pid"
        code = (
            "import subprocess, sys, time\n"
            f"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            f"open(r'{pidfile}', 'w').write(str(p.pid))\n"
            "time.sleep(60)\n"
        )
        with pytest.raises(RenderError):
            run_hard(py(code), 2)
        pid = int(pidfile.read_text())
        deadline = time.monotonic() + 5
        while pid_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.2)
        assert not pid_alive(pid), "the browser process was left running"

    def test_a_failing_command_is_a_render_error(self):
        with pytest.raises(RenderError):
            run_hard(py("import sys; sys.exit(3)"), 10)


class TestSubprocessRenderer:
    def render(self, code: str, timeout_ms: int = 1000):
        return make_subprocess_renderer(timeout_ms, command=lambda url: py(code), grace_s=1)("https://acme.example/")

    def test_parses_the_last_line_the_worker_printed_and_ignores_log_noise(self):
        out = self.render("print('INFO: Fetched (200)'); print('{\"words\": 7, \"mobileOverflow\": true}')")
        assert out == {"words": 7, "mobileOverflow": True}

    @pytest.mark.parametrize("code", ["print('not json')", "print('{\"words\": \"many\"}')", "print('[1,2]')", "pass"])
    def test_garbage_output_is_a_render_error(self, code):
        with pytest.raises(RenderError):
            self.render(code)

    def test_a_hung_page_is_cut_off(self):
        started = time.monotonic()
        with pytest.raises(RenderError):
            self.render("while True: pass", timeout_ms=500)
        assert time.monotonic() - started < 8


def test_a_hung_render_skips_that_scan_and_does_not_block_the_next_one():
    hang = make_subprocess_renderer(300, command=lambda url: py("while True: pass"), grace_s=1)
    c = make_client(renderer=hang)
    started = time.monotonic()
    first = c.post("/render", json={"url": "https://acme.example/"}, headers=AUTH).json()
    assert first["status"] == "skipped"
    assert time.monotonic() - started < 10
    # The lock was released, so the very next render is attempted, not refused as "already running".
    second = c.post("/render", json={"url": "https://acme.example/"}, headers=AUTH).json()
    assert "already" not in second.get("reason", "")


@pytest.mark.parametrize("url,expected", [
    ("https://acme.example/app.js", True),
    ("http://cdn.acme.example/x.png", True),
    ("https://acme.example:443/", True),
    ("data:text/plain,hi", True),
    ("about:blank", True),
    ("https://acme.example:8443/", False),      # only the standard web ports
    ("http://acme.example:22/", False),
    ("ws://acme.example/socket", False),
    ("wss://acme.example/socket", False),
    ("ftp://acme.example/", False),
    ("file:///etc/passwd", False),
    ("https://127.0.0.1/", False),
    ("https://user:pw@acme.example/", False),
    ("", False),
    ("not a url", False),
])
def test_request_allowed(url, expected):
    assert request_allowed(url, public_resolver) is expected


def test_request_allowed_refuses_a_name_that_resolves_privately():
    private = lambda h, p, *a, **k: [(2, 1, 6, "", ("10.0.0.5", 0))]  # noqa: E731
    assert request_allowed("https://rebind.example/", private) is False


@pytest.mark.parametrize("platform,url", [
    ("facebook", "https://evil.example\\.facebook.com/x"),
    ("linkedin", "https://evil.example\\.linkedin.com/company/x"),
    ("x", "https://evil.example\\@x.com/x"),
    ("github", "https://github.com/ac%6De"),
    ("facebook", "https://www.facebook.com/a\\b"),
    ("facebook", "https://wwW.facebook.com/x"),   # a mixed-case host is fine, but...
])
def test_platform_check_rejects_backslashes_and_percent_tricks(platform, url):
    if "wwW" in url:
        assert url_matches_platform(platform, url) is True
    else:
        assert url_matches_platform(platform, url) is False


def test_the_memory_skip_reason_does_not_expose_the_hosts_numbers():
    body = make_client(meminfo=lambda: 312).post("/render", json={"url": "https://acme.example/"}, headers=AUTH).json()
    assert body["status"] == "skipped"
    assert "312" not in body["reason"] and "400" not in body["reason"]
    assert "memory" in body["reason"]
