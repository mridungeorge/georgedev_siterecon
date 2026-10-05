"""A render that fails must leave a cause in the server log, and must not hand that cause to the caller."""

import logging
import sys

import pytest

from app.render import RenderError, run_hard
from conftest import AUTH, make_client


def py(code: str) -> list[str]:
    return [sys.executable, "-c", code]


def test_a_failed_worker_keeps_its_error_text_for_the_log():
    with pytest.raises(RenderError) as info:
        run_hard(py("import sys; sys.stderr.write('TargetClosedError: chromium exploded'); sys.exit(1)"), 10)
    assert "chromium exploded" in info.value.detail
    assert "chromium" not in str(info.value)   # the message a caller can see stays generic


def test_a_timeout_says_so_in_the_detail():
    with pytest.raises(RenderError) as info:
        run_hard(py("import time; time.sleep(30)"), 1)
    assert "timed out" in info.value.detail


def test_the_cause_is_logged_by_the_service_but_not_returned():
    def failing(url):
        raise RenderError("the browser could not render the page", detail="TargetClosedError: page crashed")

    log = logging.getLogger("siterecon.fetch")
    records: list[logging.LogRecord] = []
    handler = logging.Handler()
    handler.emit = records.append  # type: ignore[method-assign]
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    try:
        body = make_client(renderer=failing).post("/render", json={"url": "https://acme.example/page?secret=1"}, headers=AUTH).json()
    finally:
        log.removeHandler(handler)

    assert body == {"status": "skipped", "reason": "the browser could not render the page"}
    text = " ".join(r.getMessage() for r in records)
    assert "page crashed" in text
    assert "acme.example" in text
    assert "secret=1" not in text      # only the host is logged, never the query string
