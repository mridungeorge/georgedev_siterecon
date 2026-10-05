import httpx
import pytest

from conftest import AUTH, make_client


def post(client, platform, url):
    return client.post("/social/read", json={"platform": platform, "url": url}, headers=AUTH)


def json_response(payload, status=200):
    return httpx.Response(status, json=payload)


class TestGitHub:
    def test_found_with_latest_activity(self):
        def handler(request):
            if request.url.path == "/users/acme":
                return json_response({"login": "acme", "name": "Acme Inc", "bio": "We make shelves"})
            if request.url.path == "/users/acme/events/public":
                return json_response([{"created_at": "2026-09-20T10:00:00Z"}])
            return httpx.Response(404)
        r = post(make_client(handler), "github", "https://github.com/acme")
        assert r.status_code == 200
        assert r.json() == {"status": "found", "title": "Acme Inc", "description": "We make shelves", "lastActivityAt": "2026-09-20T10:00:00Z"}

    def test_missing_account_is_not_found(self):
        assert post(make_client(lambda req: httpx.Response(404)), "github", "https://github.com/ghost").json()["status"] == "not_found"

    @pytest.mark.parametrize("status", [403, 429, 500])
    def test_rate_limit_or_error_is_unreadable_not_not_found(self, status):
        r = post(make_client(lambda req: httpx.Response(status)), "github", "https://github.com/acme").json()
        assert r["status"] == "unreadable"


class TestYouTube:
    def test_found(self):
        c = make_client(youtube_extract=lambda url: {"channel": "Acme TV", "description": "Shelf videos", "entries": [{"upload_date": "20260915"}]})
        r = post(c, "youtube", "https://www.youtube.com/@acme").json()
        assert r["status"] == "found" and r["title"] == "Acme TV"
        assert r["lastActivityAt"].startswith("2026-09-15")

    def test_missing_channel(self):
        def missing(url):
            raise LookupError("This channel does not exist.")
        assert post(make_client(youtube_extract=missing), "youtube", "https://www.youtube.com/@ghost").json()["status"] == "not_found"

    def test_other_errors_are_unreadable(self):
        def broken(url):
            raise RuntimeError("network down")
        assert post(make_client(youtube_extract=broken), "youtube", "https://www.youtube.com/@acme").json()["status"] == "unreadable"


class TestReaderPlatforms:
    """Facebook, Instagram, LinkedIn and the rest are read through Jina Reader, public pages only."""

    def reader(self, payload, status=200):
        seen = []

        def handler(request):
            seen.append(str(request.url))
            return json_response(payload, status)
        return make_client(handler), seen

    def test_found_when_the_page_has_real_content(self):
        c, seen = self.reader({"code": 200, "data": {"title": "Acme Storage | LinkedIn", "description": "Shelving", "content": "Acme Storage. " * 40}})
        r = post(c, "linkedin", "https://www.linkedin.com/company/acme").json()
        assert r["status"] == "found" and r["title"] == "Acme Storage | LinkedIn"
        assert seen[0].startswith("https://r.jina.ai/https://www.linkedin.com/company/acme")

    def test_login_wall_is_reported_not_worked_around(self):
        c, _ = self.reader({"code": 200, "data": {"title": "Facebook - log in or sign up", "content": "Log in to continue to Facebook. Create new account."}})
        assert post(c, "facebook", "https://www.facebook.com/acme").json()["status"] == "login_wall"

    @pytest.mark.parametrize("content", ["Sorry, this page isn't available.", "This content isn't available right now", "Page not found", "This account doesn't exist"])
    def test_missing_pages(self, content):
        c, _ = self.reader({"code": 200, "data": {"title": "Instagram", "content": content}})
        assert post(c, "instagram", "https://www.instagram.com/ghost").json()["status"] == "not_found"

    def test_upstream_404_is_not_found(self):
        c, _ = self.reader({"code": 404, "data": None}, status=404)
        assert post(c, "x", "https://x.com/ghost").json()["status"] == "not_found"

    @pytest.mark.parametrize("status", [402, 429, 500])
    def test_reader_limits_and_errors_are_unreadable(self, status):
        c, _ = self.reader({"code": status}, status=status)
        assert post(c, "tiktok", "https://www.tiktok.com/@acme").json()["status"] == "unreadable"

    def test_a_nearly_empty_page_is_unreadable(self):
        c, _ = self.reader({"code": 200, "data": {"title": "x", "content": "hi"}})
        assert post(c, "pinterest", "https://www.pinterest.com/acme").json()["status"] == "unreadable"

    def test_site_text_cannot_inject_extra_fields(self):
        c, _ = self.reader({"code": 200, "data": {"title": "Acme" + "x" * 500, "description": "d" * 900, "content": "Real page. " * 60, "evil": "<script>"}})
        r = post(c, "linkedin", "https://www.linkedin.com/company/acme").json()
        assert set(r) <= {"status", "title", "description", "lastActivityAt", "note"}
        assert len(r["title"]) <= 160 and len(r["description"]) <= 300


class TestInputChecks:
    @pytest.mark.parametrize("platform,url", [
        ("github", "https://gitlab.com/acme"),
        ("github", "https://github.com.evil.example/acme"),
        ("facebook", "https://example.com/facebook.com/acme"),
        ("github", "http://github.com/acme"),
        ("github", "https://user:pw@github.com/acme"),
        ("github", "https://github.com:8443/acme"),
        ("youtube", "https://127.0.0.1/@acme"),
        ("linkedin", "https://www.linkedin.com/company/acme/" + "a" * 400),
    ])
    def test_rejects_urls_that_do_not_belong_to_the_platform(self, client, platform, url):
        assert post(client, platform, url).status_code == 400

    def test_rejects_an_unknown_platform(self, client):
        assert post(client, "myspace", "https://myspace.com/acme").status_code == 422

    def test_never_calls_out_for_a_rejected_url(self):
        calls = []
        c = make_client(lambda req: calls.append(req) or httpx.Response(200, json={}))
        post(c, "github", "https://github.com.evil.example/acme")
        assert calls == []
