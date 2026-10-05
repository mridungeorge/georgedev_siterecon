"""Keeps the browser and the readers away from private addresses.

The same rules as the Next.js app's lib/url-guard.ts. This is the application layer. The browser
container also sits behind firewall rules that drop private and metadata addresses (see
deploy/vm/egress-rules.sh), because a browser follows redirects and sub-requests that no
check made before the first request can see.
"""

import ipaddress
import socket
from typing import Callable
from urllib.parse import urlsplit

Resolver = Callable[..., list]

BLOCKED_SUFFIXES = (".local", ".localhost", ".internal", ".lan", ".home")


class UnsafeUrlError(ValueError):
    pass


def _blocked(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return True
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    # "global" excludes private, loopback, link-local (including 169.254.169.254, the cloud
    # metadata server), shared address space, documentation and reserved ranges.
    return (not addr.is_global) or addr.is_multicast


def _is_ip_literal(host: str) -> bool:
    # Kept out of the try block in check_public_url: UnsafeUrlError is a ValueError, so raising it
    # inside a "try ... except ValueError" would swallow the rejection.
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


is_ip_literal = _is_ip_literal


def host_is_public(host: str, resolver: Resolver = socket.getaddrinfo) -> bool:
    """True only if the name resolves, and every answer is a public address."""
    try:
        answers = resolver(host, None)
    except OSError:
        return False
    addresses = [entry[4][0] for entry in answers]
    return bool(addresses) and not any(_blocked(a) for a in addresses)


def check_public_url(url: str, resolver: Resolver = socket.getaddrinfo) -> str:
    """Returns the host of a plain public web address, or raises UnsafeUrlError."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port
    except ValueError as exc:
        raise UnsafeUrlError("not a valid address") from exc
    if parts.scheme not in ("http", "https") or not host:
        raise UnsafeUrlError("only http and https addresses can be opened")
    if parts.username or parts.password:
        raise UnsafeUrlError("addresses with a login cannot be opened")
    if port not in (None, 80, 443):
        raise UnsafeUrlError("only standard web ports can be opened")
    if _is_ip_literal(host):
        raise UnsafeUrlError("IP addresses cannot be opened")
    if "." not in host or host == "localhost" or host.endswith(BLOCKED_SUFFIXES):
        raise UnsafeUrlError("only public websites can be opened")
    if not host_is_public(host, resolver):
        raise UnsafeUrlError("that name does not resolve to a public address")
    return host
