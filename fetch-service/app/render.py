from typing import Callable
from urllib.parse import urlsplit

from .netguard import Resolver, host_is_public


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
    pass


def make_scrapling_renderer(timeout_ms: int, resolver: Resolver) -> Callable[[str], dict]:
    """Opens the page in a real headless browser and measures it. Nothing leaves except two numbers.

    Scrapling logs and swallows any error raised inside its page_setup and page_action hooks and
    carries on. So each hook records that it really ran, and a missing record is a failure: without
    the setup hook the request filter is not installed, and without the action hook there is nothing
    to report.
    """

    def render(url: str) -> dict:
        from scrapling.fetchers import DynamicFetcher  # imported late: it is heavy and only needed here

        state: dict = {"filter": False, "measured": False}

        def setup(page):
            def handler(route):
                target = route.request.url
                host = urlsplit(target).hostname or ""
                if target.startswith(("data:", "blob:", "about:")) or (host and host_is_public(host, resolver)):
                    route.continue_()
                else:
                    route.abort()  # a redirect or sub-request pointing at a private address

            page.route("**/*", handler)
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
