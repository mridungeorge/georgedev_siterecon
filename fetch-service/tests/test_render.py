import threading

from conftest import AUTH, make_client


def render(client, url="https://acme.example/"):
    return client.post("/render", json={"url": url}, headers=AUTH)


def test_a_timeout_is_reported_as_one_and_not_as_a_generic_failure():
    from app.render import RenderError

    def too_slow(url):
        raise RenderError("the browser took too long and was stopped", detail="timed out after 60 s")

    r = render(make_client(renderer=too_slow))
    assert r.json() == {"status": "skipped", "reason": "the page took too long to load in the browser, so it was stopped"}


def test_an_unexpected_error_still_gets_the_generic_reason_and_no_internals():
    def broken(url):
        raise RuntimeError("C:\\secret\\path exploded")

    r = render(make_client(renderer=broken))
    assert r.json() == {"status": "skipped", "reason": "the browser could not render the page"}


def test_vitals_are_returned_when_the_renderer_measured_them():
    measured = {"words": 9, "mobileOverflow": False, "lcpMs": 1800, "clsMilli": 40, "inpMs": 90, "hydrationErrors": 0, "lcpTag": "h1"}
    r = render(make_client(renderer=lambda url: measured))
    assert r.json() == {"status": "ok", **measured}


def test_an_unknown_lcp_tag_is_dropped_by_the_service():
    r = render(make_client(renderer=lambda url: {"words": 9, "mobileOverflow": False, "lcpTag": "<b>x</b>"}))
    assert r.json() == {"status": "ok", "words": 9, "mobileOverflow": False}


def test_structure_counts_are_returned_when_the_renderer_measured_them():
    r = render(make_client(renderer=lambda url: {"words": 9, "mobileOverflow": False, "h1": 1, "links": 4, "jsonLd": 0, "titleChars": 12}))
    assert r.json() == {"status": "ok", "words": 9, "mobileOverflow": False, "h1": 1, "links": 4, "jsonLd": 0, "titleChars": 12}


def test_returns_what_the_browser_measured():
    r = render(make_client(renderer=lambda url: {"words": 412, "mobileOverflow": True}))
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "words": 412, "mobileOverflow": True}


def test_skips_when_there_is_not_enough_free_memory_and_does_not_start_a_browser():
    started = []
    c = make_client(meminfo=lambda: 150, renderer=lambda url: started.append(url) or {"words": 1, "mobileOverflow": False})
    body = render(c).json()
    assert body["status"] == "skipped" and "memory" in body["reason"]
    assert started == []


def test_renders_when_free_memory_cannot_be_read():
    # Windows and macOS have no /proc/meminfo; the guard only applies where it can be measured.
    assert render(make_client(meminfo=lambda: None)).json()["status"] == "ok"


def test_only_one_render_at_a_time():
    gate = threading.Event()
    release = threading.Event()

    def slow(url):
        gate.set()
        release.wait(5)
        return {"words": 1, "mobileOverflow": False}

    c = make_client(renderer=slow)
    first = {}
    t = threading.Thread(target=lambda: first.update(r=render(c).json()))
    t.start()
    assert gate.wait(5)
    second = render(c).json()
    release.set()
    t.join(5)
    assert second["status"] == "skipped" and "already" in second["reason"]
    assert first["r"]["status"] == "ok"


def test_a_failing_browser_is_a_skip_not_a_server_error():
    def boom(url):
        raise RuntimeError("chromium crashed")
    body = render(make_client(renderer=boom)).json()
    assert body["status"] == "skipped"
    assert "chromium" not in body["reason"].lower() or len(body["reason"]) < 200


def test_the_slot_is_freed_after_a_failure():
    calls = {"n": 0}

    def flaky(url):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("first run fails")
        return {"words": 5, "mobileOverflow": False}

    c = make_client(renderer=flaky)
    assert render(c).json()["status"] == "skipped"
    assert render(c).json()["status"] == "ok"
