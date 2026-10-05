import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import create_app  # noqa: E402
from app.settings import Settings  # noqa: E402

SECRET = "test-secret"
AUTH = {"X-SiteRecon-Secret": SECRET}


def public_resolver(host, port, *args, **kwargs):
    """Every name resolves to a public address, unless the test says otherwise."""
    return [(2, 1, 6, "", ("93.184.216.34", 0))]


def make_client(handler=None, **overrides):
    http = httpx.Client(transport=httpx.MockTransport(handler or (lambda request: httpx.Response(404))))
    deps = dict(resolver=public_resolver, http=http, youtube_extract=lambda url: {"title": "Acme"},
                renderer=lambda url: {"words": 10, "mobileOverflow": False}, meminfo=lambda: 2000)
    deps.update(overrides)
    app = create_app(Settings(secret=SECRET, min_available_mb=400), **deps)
    return TestClient(app)


@pytest.fixture
def client():
    return make_client()
