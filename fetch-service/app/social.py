"""Reads public social profile pages, with no login and nothing logged-in.

GitHub through its public API, YouTube through yt-dlp, and everything else through Jina Reader.
These are the zero-login tools Agent-Reach itself lists for those platforms. A page that needs a
login is reported as such, never worked around.
"""

import re
from datetime import datetime, timezone
from typing import Callable
from urllib.parse import urlsplit

import httpx

YoutubeExtract = Callable[[str], dict]

NOT_FOUND = re.compile(
    r"(this (page|content|account|profile) (isn'?t|is not|is no longer) available|page not found|doesn'?t exist"
    r"|does not exist|couldn'?t find this (page|account)|sorry, this page isn'?t available|user not found)",
    re.I,
)
LOGIN_TITLE = re.compile(r"log ?in|sign ?(in|up)", re.I)
LOGIN_TEXT = re.compile(r"(log ?in|sign ?in|sign ?up|create (a |new )?account|join now)", re.I)

MIN_CONTENT_CHARS = 150
GITHUB_HEADERS = {"Accept": "application/vnd.github+json", "User-Agent": "SiteReconBot/0.1"}


def _clip(value: object, limit: int) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return " ".join(value.split())[:limit]


def _result(status: str, *, title=None, description=None, last=None, note=None) -> dict:
    out: dict = {"status": status}
    for key, value in (("title", _clip(title, 160)), ("description", _clip(description, 300)), ("lastActivityAt", last), ("note", _clip(note, 160))):
        if value:
            out[key] = value
    return out


def read_github(url: str, http: httpx.Client) -> dict:
    handle = [s for s in urlsplit(url).path.split("/") if s][:1]
    if not handle or not re.fullmatch(r"[A-Za-z0-9-]{1,39}", handle[0]):
        return _result("unreadable", note="not a valid GitHub name")
    name = handle[0]
    user = http.get(f"https://api.github.com/users/{name}", headers=GITHUB_HEADERS, timeout=15)
    if user.status_code == 404:
        return _result("not_found")
    if user.status_code != 200:
        return _result("unreadable", note=f"GitHub returned HTTP {user.status_code}")
    data = user.json()
    last = None
    events = http.get(f"https://api.github.com/users/{name}/events/public", params={"per_page": 1}, headers=GITHUB_HEADERS, timeout=15)
    if events.status_code == 200 and isinstance(events.json(), list) and events.json():
        last = events.json()[0].get("created_at")
    return _result("found", title=data.get("name") or data.get("login"), description=data.get("bio"), last=last)


def ytdlp_extract(url: str) -> dict:
    import yt_dlp  # imported late: only needed for YouTube

    options = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": True, "playlistend": 1, "socket_timeout": 15}
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            return ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        if re.search(r"does not exist|HTTP Error 404|not found|has been terminated", str(exc), re.I):
            raise LookupError(str(exc)) from exc
        raise


def read_youtube(url: str, extract: YoutubeExtract) -> dict:
    try:
        info = extract(url)
    except LookupError:
        return _result("not_found")
    except Exception:
        return _result("unreadable", note="YouTube could not be read")
    last = None
    entries = info.get("entries") or []
    stamp = entries[0].get("upload_date") if entries and isinstance(entries[0], dict) else None
    if isinstance(stamp, str) and re.fullmatch(r"\d{8}", stamp):
        last = datetime.strptime(stamp, "%Y%m%d").replace(tzinfo=timezone.utc).isoformat()
    return _result("found", title=info.get("channel") or info.get("title"), description=info.get("description"), last=last)


def read_with_reader(url: str, http: httpx.Client, jina_base: str) -> dict:
    response = http.get(f"{jina_base}/{url}", headers={"Accept": "application/json"}, timeout=25)
    if response.status_code in (404, 410):
        return _result("not_found")
    if response.status_code != 200:
        return _result("unreadable", note=f"the reader returned HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError:
        return _result("unreadable", note="the reader gave an unreadable answer")
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return _result("unreadable", note="the reader found no page")
    title = data.get("title") if isinstance(data.get("title"), str) else ""
    content = data.get("content") if isinstance(data.get("content"), str) else ""
    head = f"{title} {content[:400]}"
    if len(content) < 1500 and NOT_FOUND.search(head):
        return _result("not_found")
    if LOGIN_TITLE.search(title) or (len(content) < 1500 and LOGIN_TEXT.search(content[:600])):
        return _result("login_wall")
    if len(content) < MIN_CONTENT_CHARS:
        return _result("unreadable", note="the page had too little public content to read")
    return _result("found", title=title, description=data.get("description"))


def read_profile(platform: str, url: str, *, http: httpx.Client, youtube_extract: YoutubeExtract, jina_base: str) -> dict:
    try:
        if platform == "github":
            return read_github(url, http)
        if platform == "youtube":
            return read_youtube(url, youtube_extract)
        return read_with_reader(url, http, jina_base)
    except httpx.HTTPError:
        return _result("unreadable", note="the page could not be reached")
