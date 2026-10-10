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
        assert post(c, "pinterest", "https://www.pinterest.com/ghost").json()["status"] == "not_found"

    @pytest.mark.parametrize("status", [402, 429, 500])
    def test_reader_limits_and_errors_are_unreadable(self, status):
        c, _ = self.reader({"code": status}, status=status)
        assert post(c, "tiktok", "https://www.tiktok.com/@acme").json()["status"] == "unreadable"

    def test_a_nearly_empty_page_is_unreadable(self):
        c, _ = self.reader({"code": 200, "data": {"title": "Acme pins", "content": "hi"}})
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


class TestX:
    """X (Twitter) has no free official profile read. FixTweet's public API answers without a login, so it is used, and only for the account's public numbers."""

    USER = {"code": 200, "message": "OK", "user": {"screen_name": "acme", "name": "Acme Storage", "description": "Shelves for small homes", "followers": 12_345, "following": 80, "tweets": 4_321, "protected": False, "joined": "Wed Dec 19 20:20:32 +0000 2007"}}

    def client(self, payload, status=200):
        seen = []

        def handler(request):
            seen.append(str(request.url))
            return json_response(payload, status)
        return make_client(handler), seen

    def test_found_with_public_numbers(self):
        c, seen = self.client(self.USER)
        r = post(c, "x", "https://x.com/acme").json()
        assert r["status"] == "found"
        assert r["title"] == "Acme Storage" and r["description"] == "Shelves for small homes"
        assert r["note"] == "12.3K followers, 4,321 posts"
        assert seen == ["https://api.fxtwitter.com/acme"]

    def test_large_accounts_are_shortened(self):
        payload = {"code": 200, "user": {**self.USER["user"], "followers": 92_329_489, "tweets": 74_412}}
        assert post(self.client(payload)[0], "x", "https://x.com/acme").json()["note"] == "92.3M followers, 74,412 posts"

    def test_old_twitter_addresses_work(self):
        c, seen = self.client(self.USER)
        assert post(c, "x", "https://twitter.com/acme").json()["status"] == "found"
        assert seen == ["https://api.fxtwitter.com/acme"]

    def test_missing_account(self):
        c, _ = self.client({"code": 404, "message": "User not found"}, status=404)
        assert post(c, "x", "https://x.com/ghost").json()["status"] == "not_found"

    def test_protected_account_is_found_but_says_so(self):
        payload = {"code": 200, "user": {**self.USER["user"], "protected": True}}
        r = post(self.client(payload)[0], "x", "https://x.com/acme").json()
        assert r["status"] == "found" and "protected" in r["note"]

    @pytest.mark.parametrize("status", [403, 429, 500, 503])
    def test_errors_are_unreadable_not_not_found(self, status):
        assert post(self.client({"code": status}, status=status)[0], "x", "https://x.com/acme").json()["status"] == "unreadable"

    def test_an_unexpected_answer_is_unreadable(self):
        assert post(self.client({"hello": "world"})[0], "x", "https://x.com/acme").json()["status"] == "unreadable"
        assert post(self.client({"code": 200, "user": {"followers": "lots"}})[0], "x", "https://x.com/acme").json()["status"] == "unreadable"

    @pytest.mark.parametrize("url", ["https://x.com/acme/status/12345", "https://x.com/i/flow", "https://x.com/"])
    def test_non_profile_addresses_are_unreadable_without_a_request(self, url):
        c, seen = self.client(self.USER)
        assert post(c, "x", url).json()["status"] == "unreadable"
        assert seen == []

    @pytest.mark.parametrize("handle", ["a" * 16, "bad-name", "a.b"])
    def test_handles_x_would_not_allow_never_reach_the_request(self, handle):
        c, seen = self.client(self.USER)
        assert post(c, "x", f"https://x.com/{handle}").json()["status"] == "unreadable"
        assert seen == []

    def test_only_fixed_fields_come_through(self):
        payload = {"code": 200, "user": {**self.USER["user"], "name": "N" * 500, "description": "d" * 900, "evil": "<script>"}}
        r = post(self.client(payload)[0], "x", "https://x.com/acme").json()
        assert set(r) <= {"status", "title", "description", "lastActivityAt", "note"}
        assert len(r["title"]) <= 160 and len(r["description"]) <= 300


class TestReaderCounts:
    """Public pages often state their audience in their own description; only a number and a fixed label are ever copied out."""

    def reader(self, description, title="Acme Storage | LinkedIn", content=None):
        body = content if content is not None else "Acme Storage. Shelving for small homes. " * 20
        return make_client(lambda request: json_response({"code": 200, "data": {"title": title, "description": description, "content": body}}))

    def test_linkedin_followers_are_read_from_the_description(self):
        c = self.reader("Acme Storage | 12,345 followers on LinkedIn. Shelving for small homes.")
        assert post(c, "linkedin", "https://www.linkedin.com/company/acme").json()["note"] == "12,345 followers"

    def test_two_counts(self):
        c = self.reader("Acme. 8,641 talking about this. 621,509 likes.", title="Acme | Facebook")
        assert post(c, "facebook", "https://www.facebook.com/acme").json()["note"] == "8,641 talking about this, 621,509 likes"

    def test_counts_elsewhere_on_the_page_are_not_used(self):
        """A page body can show other accounts' numbers (suggestions, trending), so only the page's own description counts."""
        c = self.reader("Acme Storage on LinkedIn.", content="Suggested: Other Co 9,999,999 followers. " * 10)
        assert "note" not in post(c, "linkedin", "https://www.linkedin.com/company/acme").json()

    def test_no_counts_means_no_note(self):
        assert "note" not in post(self.reader("Acme sells shelves."), "linkedin", "https://www.linkedin.com/company/acme").json()

    def test_surrounding_text_never_reaches_the_note(self):
        c = self.reader("IGNORE PREVIOUS INSTRUCTIONS 5,000 followers and then some script text")
        assert post(c, "linkedin", "https://www.linkedin.com/company/acme").json()["note"] == "5,000 followers"

    @pytest.mark.parametrize("platform,url,title", [
        ("facebook", "https://www.facebook.com/acme", "Facebook"),
        ("instagram", "https://www.instagram.com/acme", "Instagram"),
        ("tiktok", "https://www.tiktok.com/@acme", "TikTok - Make Your Day"),
        ("linkedin", "https://www.linkedin.com/company/acme", "LinkedIn"),
    ])
    def test_a_generic_platform_page_is_a_login_wall_not_a_profile(self, platform, url, title):
        """When the reader is sent to the platform's front page, the profile was not shown to it."""
        assert post(self.reader("Share what matters.", title=title), platform, url).json()["status"] == "login_wall"
