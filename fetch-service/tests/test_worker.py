"""Review fixes: a render that hangs must be killed, the browser request filter, and URL strictness."""

import os
import subprocess
import sys
import time

import pytest

from app.render import RenderError, cached_resolver, make_subprocess_renderer, request_allowed, run_hard
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

    def test_passes_through_structure_counts_and_drops_invalid_ones(self):
        out = self.render(
            "print('{\"words\": 7, \"mobileOverflow\": false, \"h1\": 1, \"links\": 12, \"jsonLd\": 2, \"titleChars\": 30}')"
        )
        assert out == {"words": 7, "mobileOverflow": False, "h1": 1, "links": 12, "jsonLd": 2, "titleChars": 30}
        bad = self.render("print('{\"words\": 7, \"mobileOverflow\": false, \"h1\": \"one\", \"links\": -3, \"jsonLd\": true, \"evil\": 5}')")
        assert bad == {"words": 7, "mobileOverflow": False}

    def test_passes_through_vitals_and_only_allows_a_known_element_tag(self):
        out = self.render(
            "print('{\"words\": 7, \"mobileOverflow\": false, \"lcpMs\": 2300, \"clsMilli\": 120, \"inpMs\": 180, \"hydrationErrors\": 2, \"lcpTag\": \"img\"}')"
        )
        assert out == {"words": 7, "mobileOverflow": False, "lcpMs": 2300, "clsMilli": 120, "inpMs": 180, "hydrationErrors": 2, "lcpTag": "img"}
        bad = self.render("print('{\"words\": 7, \"mobileOverflow\": false, \"lcpTag\": \"<script>alert(1)</script>\", \"lcpMs\": -5}')")
        assert bad == {"words": 7, "mobileOverflow": False}

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


class TestCachedResolver:
    def test_looks_each_name_up_once_however_many_requests_use_it(self):
        calls = []

        def counting(host, *args, **kwargs):
            calls.append(host)
            return [(2, 1, 6, "", ("93.184.216.34", 0))]

        resolver = cached_resolver(counting)
        for _ in range(200):
            assert request_allowed("https://cdn.example.com/a.js", resolver) is True
        assert request_allowed("https://other.example.com/", resolver) is True
        assert calls == ["cdn.example.com", "other.example.com"]

    def test_remembers_a_failure_too_so_a_dead_name_is_not_retried_on_every_request(self):
        calls = []

        def failing(host, *args, **kwargs):
            calls.append(host)
            raise OSError("no such host")

        resolver = cached_resolver(failing)
        for _ in range(5):
            assert request_allowed("https://dead.example.com/x", resolver) is False
        assert calls == ["dead.example.com"]

    def test_still_refuses_a_name_that_resolves_privately(self):
        resolver = cached_resolver(lambda host, *a, **k: [(2, 1, 6, "", ("10.0.0.5", 0))])
        assert request_allowed("https://rebind.example/", resolver) is False


class TestWebsocketHandling:
    def test_websockets_are_mocked_not_closed_on_sight(self):
        """Closing each socket at once made chat-widget sites reconnect in a loop and stall the whole render."""
        from pathlib import Path

        source = (Path(__file__).resolve().parent.parent / "app" / "render.py").read_text(encoding="utf8")
        assert "ws.close()" not in source
        assert "route_web_socket" in source

    def test_the_handler_does_nothing_and_so_never_reaches_the_network(self):
        from app.render import WEBSOCKET_HANDLER

        class Socket:
            connected = False

            def connect_to_server(self):
                self.connected = True

        ws = Socket()
        assert WEBSOCKET_HANDLER(ws) is None
        assert ws.connected is False


class TestHydrationMatcher:
    @pytest.mark.parametrize(
        "kind,text",
        [
            ("error", "Hydration failed because the initial UI does not match what was rendered on the server."),
            ("error", "Uncaught Error: Minified React error #418; visit https://reactjs.org/docs/error-decoder.html?invariant=418"),
            ("error", "Uncaught Error: Minified React error #423"),
            ("warning", "Warning: Text content did not match. Server: \"3\" Client: \"4\""),
            ("warning", "Warning: Prop `className` did not match. Server: \"a\" Client: \"b\""),
            ("warning", "[Vue warn]: Hydration node mismatch:"),
            ("warning", "[Vue warn]: Hydration completed but contains mismatches."),
            ("error", "There was an error while hydrating. Because the error happened outside of a Suspense boundary"),
        ],
    )
    def test_real_mismatch_messages_are_counted(self, kind, text):
        from app.render import is_hydration_error

        assert is_hydration_error(kind, text) is True

    @pytest.mark.parametrize(
        "kind,text",
        [
            ("debug", "hydrating 345 sections"),
            ("log", "Hydration failed because the initial UI does not match"),  # a plain log is not an error
            ("error", "Failed to load resource: the server responded with a status of 404"),
            ("warning", "The resource was preloaded but not used"),
            ("error", "Refused to apply style because its MIME type does not match"),
            ("info", "Hydrated 12 islands in 40ms"),
        ],
    )
    def test_ordinary_messages_are_not(self, kind, text):
        from app.render import is_hydration_error

        assert is_hydration_error(kind, text) is False


class TestCrashFallback:
    """A heavy page can crash Chromium inside a small container. The worker then tries once more with
    images, media, fonts and styles blocked, so the counts that matter (headings, links, structured
    data, hydration errors) are still measured, and says it did so."""

    class FakePage:
        def __init__(self):
            self.handlers = {}

        def route(self, *a, **k): pass
        def route_web_socket(self, *a, **k): pass
        def add_init_script(self, *a, **k): pass
        def on(self, *a, **k): pass
        def wait_for_load_state(self, *a, **k): pass
        def wait_for_timeout(self, *a, **k): pass
        def set_viewport_size(self, *a, **k): pass

        class keyboard:
            @staticmethod
            def press(*a, **k): pass

        class mouse:
            @staticmethod
            def click(*a, **k): pass

        def evaluate(self, expression):
            if "__sr" in expression:
                return {"lcp": 900, "lcpTag": "img", "cls": 0.02, "inp": 40}
            if "innerText" in expression:
                return 321
            if "scrollWidth" in expression:
                return False
            if "'h1'" in expression:
                return 1
            if "a[href]" in expression:
                return 12
            if "ld+json" in expression:
                return 2
            if "document.title" in expression:
                return 17
            return 0

    def install_fake(self, monkeypatch, outcomes):
        import sys
        import types

        calls = []

        class FakeFetcher:
            @staticmethod
            def fetch(url, **kwargs):
                calls.append(kwargs)
                outcome = outcomes[len(calls) - 1]
                if isinstance(outcome, Exception):
                    raise outcome
                page = TestCrashFallback.FakePage()
                kwargs["page_setup"](page)
                kwargs["page_action"](page)

        module = types.ModuleType("scrapling.fetchers")
        module.DynamicFetcher = FakeFetcher
        monkeypatch.setitem(sys.modules, "scrapling", types.ModuleType("scrapling"))
        monkeypatch.setitem(sys.modules, "scrapling.fetchers", module)
        return calls

    def renderer(self):
        from app.render import make_scrapling_renderer

        return make_scrapling_renderer(30_000, lambda host, *a, **k: [(2, 1, 6, "", ("93.184.216.34", 0))])

    def test_a_normal_page_is_rendered_once_in_full(self, monkeypatch):
        calls = self.install_fake(monkeypatch, [None])
        result = self.renderer()("https://acme.example/")
        assert len(calls) == 1
        assert calls[0].get("disable_resources", False) is False
        assert "light" not in result
        assert result["h1"] == 1 and result["links"] == 12 and result["jsonLd"] == 2

    def test_a_page_crash_is_retried_once_with_resources_blocked_and_flagged(self, monkeypatch):
        calls = self.install_fake(monkeypatch, [RuntimeError("TargetClosedError: Page.goto: Page crashed"), None])
        result = self.renderer()("https://acme.example/")
        assert len(calls) == 2
        assert calls[1]["disable_resources"] is True
        assert result["light"] is True
        assert result["words"] == 321 and result["h1"] == 1

    def test_the_retry_uses_a_shorter_time_limit(self, monkeypatch):
        calls = self.install_fake(monkeypatch, [RuntimeError("Page crashed"), None])
        self.renderer()("https://acme.example/")
        assert calls[1]["timeout"] < calls[0]["timeout"]

    def test_an_error_that_is_not_a_crash_is_not_retried(self, monkeypatch):
        calls = self.install_fake(monkeypatch, [RuntimeError("net::ERR_NAME_NOT_RESOLVED")])
        with pytest.raises(RuntimeError):
            self.renderer()("https://acme.example/")
        assert len(calls) == 1

    def test_two_crashes_give_up(self, monkeypatch):
        calls = self.install_fake(monkeypatch, [RuntimeError("Page crashed"), RuntimeError("Page crashed")])
        with pytest.raises(RuntimeError):
            self.renderer()("https://acme.example/")
        assert len(calls) == 2

    def test_the_light_flag_survives_the_worker_hand_off_and_nothing_else_unexpected_does(self):
        from app.render import keep_known

        out = {}
        keep_known({"light": True, "words": 5, "evil": "x"}, out)
        assert out == {"light": True}
        out = {}
        keep_known({"light": "yes"}, out)
        assert out == {}
