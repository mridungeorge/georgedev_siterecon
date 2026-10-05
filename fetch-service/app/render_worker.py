"""Runs one render in its own process: `python -m app.render_worker <url>`.

The parent (render.make_subprocess_renderer) starts this with a hard time limit and kills the whole
process tree if it overruns. The last line printed to stdout is the result as JSON.
"""

import json
import os
import socket
import sys

from .render import make_scrapling_renderer


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(json.dumps({"error": "usage: render_worker <url>"}))
        return 2
    timeout_ms = int(os.environ.get("RENDER_TIMEOUT_MS", "45000"))
    try:
        result = make_scrapling_renderer(timeout_ms, socket.getaddrinfo)(argv[1])
    except Exception as exc:  # the parent only needs to know it failed
        print(json.dumps({"error": type(exc).__name__}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
