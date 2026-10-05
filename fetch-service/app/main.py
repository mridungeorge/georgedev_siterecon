import hmac
import logging
import socket
import threading
from typing import Callable, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from .netguard import Resolver, UnsafeUrlError, check_public_url
from .render import make_subprocess_renderer, read_available_mb
from .routing import url_matches_platform
from .settings import Settings
from .social import YoutubeExtract, read_profile, ytdlp_extract

log = logging.getLogger("siterecon.fetch")

Platform = Literal["facebook", "instagram", "x", "linkedin", "youtube", "tiktok", "pinterest", "github"]


class SocialReadRequest(BaseModel):
    url: str
    platform: Platform


class RenderRequest(BaseModel):
    url: str


def create_app(
    settings: Settings,
    *,
    resolver: Resolver = socket.getaddrinfo,
    http: httpx.Client | None = None,
    youtube_extract: YoutubeExtract = ytdlp_extract,
    renderer: Callable[[str], dict] | None = None,
    meminfo: Callable[[], int | None] = read_available_mb,
) -> FastAPI:
    # Fail closed: a service that anyone could call must never start by accident.
    if not settings.secret:
        raise RuntimeError("FETCH_SERVICE_SECRET is not set")

    app = FastAPI(title="siterecon-fetch", docs_url=None, redoc_url=None, openapi_url=None)
    client = http or httpx.Client(follow_redirects=False)
    # Each render runs in its own process with a hard time limit, so a page that never stops running
    # JavaScript cannot freeze the service or hold the render lock.
    render_page = renderer or make_subprocess_renderer(settings.render_timeout_ms)
    one_render_at_a_time = threading.Lock()

    def require_secret(x_siterecon_secret: str = Header(default="")) -> None:
        if not hmac.compare_digest(x_siterecon_secret.encode(), settings.secret.encode()):
            raise HTTPException(status_code=401, detail="unauthorised")

    @app.get("/health", dependencies=[Depends(require_secret)])
    def health() -> dict:
        return {"ok": True, "memAvailableMb": meminfo()}

    @app.post("/social/read", dependencies=[Depends(require_secret)])
    def social_read(body: SocialReadRequest) -> dict:
        if not url_matches_platform(body.platform, body.url):
            raise HTTPException(status_code=400, detail="that address does not belong to that platform")
        return read_profile(body.platform, body.url, http=client, youtube_extract=youtube_extract, jina_base=settings.jina_base)

    @app.post("/render", dependencies=[Depends(require_secret)])
    def render(body: RenderRequest) -> dict:
        try:
            check_public_url(body.url, resolver)
        except UnsafeUrlError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        free = meminfo()
        if free is not None and free < settings.min_available_mb:
            return {"status": "skipped", "reason": "not enough free memory on the server to start a browser"}
        if not one_render_at_a_time.acquire(blocking=False):
            return {"status": "skipped", "reason": "another render is already running"}
        try:
            measured = render_page(body.url)
            return {"status": "ok", "words": int(measured["words"]), "mobileOverflow": bool(measured["mobileOverflow"])}
        except Exception as exc:
            # The caller gets a generic reason. The cause goes to the server log, with the host only
            # (a URL can carry a query string that should not be written down).
            log.warning("render of %s failed: %s %s", urlsplit(body.url).hostname, type(exc).__name__, getattr(exc, "detail", "") or exc)
            return {"status": "skipped", "reason": "the browser could not render the page"}
        finally:
            one_render_at_a_time.release()

    return app



def build() -> FastAPI:
    """Entry point for uvicorn --factory. Reads FETCH_SERVICE_SECRET from the environment."""
    return create_app(Settings.from_env())
