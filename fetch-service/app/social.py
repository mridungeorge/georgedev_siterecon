"""Reads public social profile pages, with no login and nothing logged-in.

GitHub through its public API, YouTube through yt-dlp, X through FixTweet's public API, and everything
else through Jina Reader. These are the zero-login routes Agent-Reach lists for those platforms. Agent-Reach's
routes for X, Instagram and Facebook that use a logged-in cookie or browser session are deliberately not
used: they break those platforms' terms, risk the account, and would put a login on a public server. A page
that needs a login is reported as such, never worked around.
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

GENERIC_TITLE = re.compile(r"(facebook|instagram|linkedin|x|twitter|tiktok|pinterest)( - [\w ,'!]{3,30})?|tiktok - make your day|(log in|sign up|login)[\w ,|-]{0,40}", re.I)
MIN_CONTENT_CHARS = 150
FIXTWEET_BASE = "https://api.fxtwitter.com"
X_HANDLE = re.compile(r"[A-Za-z0-9_]{1,15}")
# A public number and one of a fixed set of labels. Nothing else from a page is ever copied into a note.
COUNT = re.compile(
    r"(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d{1,12})(?:\.(\d{1,2}))?\s?([KMB])?\s+(followers?|likes?|following|posts?|subscribers?|talking about this)(?![a-z])",
    re.I,
)
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


def public_counts(text: str, limit: int = 3) -> str | None:
    """For example "12,345 followers, 621,509 likes", or None when the text states no audience."""
    seen: set[str] = set()
    found: list[str] = []
    for m in COUNT.finditer(text):
        label = m.group(4).lower()
        key = label[:-1] if label.endswith("s") else label
        if key in seen:
            continue
        seen.add(key)
        found.append(f"{m.group(1)}{'.' + m.group(2) if m.group(2) else ''}{m.group(3).upper() if m.group(3) else ''} {label}")
        if len(found) == limit:
            break
    return ", ".join(found) or None


def _compact(n: int) -> str:
    if n >= 999_950:
        return f"{n / 1_000_000:.1f}".rstrip("0").rstrip(".") + "M"
    if n >= 1000:
        return f"{n / 1000:.1f}".rstrip("0").rstrip(".") + "K"
    return str(n)


def read_x(url: str, http: httpx.Client, base: str = FIXTWEET_BASE) -> dict:
    segments = [s for s in urlsplit(url).path.split("/") if s]
    if len(segments) != 1 or not X_HANDLE.fullmatch(segments[0]) or segments[0].lower() in {"i", "home", "explore", "search", "intent", "share"}:
        return _result("unreadable", note="the link is not an X profile")
    response = http.get(f"{base}/{segments[0]}", headers={"User-Agent": "SiteReconBot/0.1", "Accept": "application/json"}, timeout=15)
    if response.status_code == 404:
        return _result("not_found")
    if response.status_code != 200:
        return _result("unreadable", note=f"X could not be read (HTTP {response.status_code})")
    try:
        user = response.json().get("user")
    except (ValueError, AttributeError):
        return _result("unreadable", note="X gave an unreadable answer")
    followers, posts = (user or {}).get("followers"), (user or {}).get("tweets")
    if not isinstance(user, dict) or not isinstance(followers, int) or isinstance(followers, bool):
        return _result("unreadable", note="X gave an unexpected answer")
    parts = [f"{_compact(followers)} followers"]
    if isinstance(posts, int) and not isinstance(posts, bool):
        parts.append(f"{posts:,} posts")
    if user.get("protected") is True:
        parts.append("protected account")
    return _result("found", title=user.get("name") or user.get("screen_name"), description=user.get("description"), note=", ".join(parts))


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
    # Sent to the platform's front page instead of the profile: nothing about this account was shown.
    if GENERIC_TITLE.fullmatch(" ".join(title.split())):
        return _result("login_wall")
    if len(content) < MIN_CONTENT_CHARS:
        return _result("unreadable", note="the page had too little public content to read")
    # The page often states its audience in its own words ("12,345 followers"); only the number and label are kept.
    # Only the page's own description is read for numbers. The body can show other accounts' counts.
    description = data.get("description") if isinstance(data.get("description"), str) else ""
    return _result("found", title=title, description=description, note=public_counts(description))


def read_profile(platform: str, url: str, *, http: httpx.Client, youtube_extract: YoutubeExtract, jina_base: str) -> dict:
    try:
        if platform == "github":
            return read_github(url, http)
        if platform == "youtube":
            return read_youtube(url, youtube_extract)
        if platform == "x":
            return read_x(url, http)
        return read_with_reader(url, http, jina_base)
    except httpx.HTTPError:
        return _result("unreadable", note="the page could not be reached")
