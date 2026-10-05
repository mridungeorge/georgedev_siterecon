"""Decides whether a URL really belongs to the social platform it is claimed to.

Two independent checks must agree: our own host allowlist, and Agent-Reach's channel routing
where it has a channel for the platform. Either one refusing is enough to reject the URL.
"""

import importlib
from urllib.parse import urlsplit

PLATFORM_HOSTS = {
    "facebook": ("facebook.com", "fb.com", "fb.me"),
    "instagram": ("instagram.com",),
    "x": ("x.com", "twitter.com"),
    "linkedin": ("linkedin.com",),
    "youtube": ("youtube.com",),
    "tiktok": ("tiktok.com",),
    "pinterest": ("pinterest.com", "pinterest.com.au"),
    "github": ("github.com",),
}

# Platform -> the Agent-Reach channel module that routes it. TikTok and Pinterest have none.
AGENT_REACH_CHANNELS = {
    "facebook": "facebook", "instagram": "instagram", "x": "twitter",
    "linkedin": "linkedin", "youtube": "youtube", "github": "github",
}

MAX_URL_LENGTH = 300


def _agent_reach_channel(platform: str):
    module_name = AGENT_REACH_CHANNELS.get(platform)
    if module_name is None:
        return None
    try:
        module = importlib.import_module(f"agent_reach.channels.{module_name}")
    except Exception:  # the package is optional at runtime; our own allowlist still applies
        return None
    for obj in vars(module).values():
        if isinstance(obj, type) and getattr(obj, "name", "") == module_name:
            try:
                return obj()
            except Exception:
                return None
    return None


def url_matches_platform(platform: str, url: str) -> bool:
    hosts = PLATFORM_HOSTS.get(platform)
    if hosts is None or len(url) > MAX_URL_LENGTH:
        return False
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "https" or parts.username or parts.password or port not in (None, 443):
        return False
    if not any(host == h or host.endswith("." + h) for h in hosts):
        return False
    channel = _agent_reach_channel(platform)
    if channel is not None:
        try:
            return bool(channel.can_handle(url))
        except Exception:
            return True
    return True
