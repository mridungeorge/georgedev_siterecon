import pytest

from app.main import create_app
from app.netguard import UnsafeUrlError, check_public_url, host_is_public
from app.settings import Settings
from conftest import AUTH, make_client, public_resolver


def test_refuses_to_start_without_a_secret():
    with pytest.raises(RuntimeError):
        create_app(Settings(secret=""))


@pytest.mark.parametrize("headers", [{}, {"X-SiteRecon-Secret": "wrong"}, {"X-SiteRecon-Secret": ""}])
def test_every_endpoint_rejects_a_missing_or_wrong_secret(client, headers):
    assert client.get("/health", headers=headers).status_code == 401
    assert client.post("/social/read", json={"url": "https://github.com/acme", "platform": "github"}, headers=headers).status_code == 401
    assert client.post("/render", json={"url": "https://acme.example/"}, headers=headers).status_code == 401


def test_health_reports_ok_with_the_right_secret(client):
    body = client.get("/health", headers=AUTH).json()
    assert body["ok"] is True
    assert body["memAvailableMb"] == 2000


def private(host, port, *a, **k):
    return [(2, 1, 6, "", ("10.0.0.5", 0))]


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"])
def test_blocks_private_and_reserved_addresses(ip):
    assert host_is_public("evil.example", lambda h, p, *a, **k: [(2, 1, 6, "", (ip, 0))]) is False


def test_blocks_a_name_with_any_private_answer_and_accepts_a_public_one():
    mixed = lambda h, p, *a, **k: [(2, 1, 6, "", ("93.184.216.34", 0)), (2, 1, 6, "", ("10.0.0.5", 0))]  # noqa: E731
    assert host_is_public("evil.example", mixed) is False
    assert host_is_public("acme.example", public_resolver) is True


def test_a_name_that_does_not_resolve_is_not_public():
    def boom(*a, **k):
        raise OSError("no such host")
    assert host_is_public("nope.example", boom) is False


@pytest.mark.parametrize("url", [
    "ftp://acme.example/", "https://user:pw@acme.example/", "https://acme.example:8443/", "https://127.0.0.1/",
    "https://[::1]/", "https://localhost/", "https://intranet/", "https://printer.local/", "https://metadata.google.internal/",
    "javascript:alert(1)", "", "not a url",
])
def test_check_public_url_rejects_unsafe_addresses(url):
    with pytest.raises(UnsafeUrlError):
        check_public_url(url, public_resolver)


def test_check_public_url_rejects_a_public_looking_name_that_resolves_privately():
    with pytest.raises(UnsafeUrlError):
        check_public_url("https://rebind.example/", private)


def test_render_refuses_private_targets_over_http(client):
    c = make_client(resolver=private)
    assert c.post("/render", json={"url": "https://rebind.example/"}, headers=AUTH).status_code == 400
