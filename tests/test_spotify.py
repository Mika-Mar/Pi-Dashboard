"""Spotify routes, isolated from credentials, token caches, and real devices."""
import unittest
from unittest.mock import Mock, patch

import requests
import spotipy
from spotipy.exceptions import SpotifyOauthError

import app as dashboard


class SpotifyRoutesTest(unittest.TestCase):
    def setUp(self):
        self.client = dashboard.app.test_client()
        self.sp = Mock()
        self.sp.current_playback.return_value = None
        self.sp.devices.return_value = {"devices": [
            {"id": "desktop", "name": "Desktop", "type": "Computer",
             "is_active": True, "volume_percent": 72, "is_restricted": False,
             "is_private_session": False, "supports_volume": True},
            {"id": "macbook", "name": "MacBook", "is_active": False,
             "is_restricted": False},
            {"id": "speaker", "name": "Speaker", "is_restricted": True},
        ]}
        patcher = patch.object(dashboard, "spotify_client", return_value=self.sp)
        patcher.start()
        self.addCleanup(patcher.stop)
        sleeper = patch.object(dashboard.time, "sleep")
        sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_dashboard_renders_picker_and_existing_controls(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        for element in ("spotifyDevice", "btnPlay", "btnPrev", "btnNext", "progress",
                        "spotifyLibraryView", "btnSpotifyLibrary", "spotifyLibraryItems"):
            self.assertIn(('id="' + element + '"').encode(), response.data)

    def test_oauth_scopes_include_library_and_recent_history(self):
        scopes = set(dashboard.SPOTIFY_SCOPE.split())
        self.assertTrue({"user-library-read", "user-read-recently-played"} <= scopes)

    def test_oauth_callback_requires_matching_state(self):
        oauth = Mock()
        oauth.get_authorize_url.return_value = "https://accounts.spotify.test/authorize"
        with patch.object(dashboard, "spotify_oauth", return_value=oauth):
            login = self.client.get("/spotify/login")
            self.assertEqual(login.status_code, 302)
            with self.client.session_transaction() as flask_session:
                state = flask_session["spotify_oauth_state"]
            oauth.get_authorize_url.assert_called_once_with(state=state)

            rejected = self.client.get(
                "/spotify/callback", query_string={"code": "code", "state": "wrong"})
            self.assertEqual(rejected.status_code, 400)
            oauth.get_access_token.assert_not_called()

            self.client.get("/spotify/login")
            with self.client.session_transaction() as flask_session:
                state = flask_session["spotify_oauth_state"]
            accepted = self.client.get(
                "/spotify/callback", query_string={"code": "code", "state": state})
            self.assertEqual(accepted.status_code, 302)
            oauth.get_access_token.assert_called_once_with("code", check_cache=False)

    def test_oauth_errors_are_plain_text(self):
        with self.client.session_transaction() as flask_session:
            flask_session["spotify_oauth_state"] = "expected"
        response = self.client.get(
            "/spotify/callback",
            query_string={
                "state": "expected",
                "error": "<script>alert('unsafe')</script>",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.mimetype, "text/plain")

    def test_cover_proxy_rejects_unsafe_urls_and_limits_upstream_behavior(self):
        with patch.object(dashboard.requests, "get") as get:
            for url in (
                "http://i.scdn.co/image.jpg",
                "https://example.com/image.jpg",
                "https://i.scdn.co:444/image.jpg",
            ):
                with self.subTest(url=url):
                    self.assertEqual(
                        self.client.get("/proxy/cover", query_string={"url": url}).status_code,
                        400,
                    )
            get.assert_not_called()

        upstream = Mock(
            status_code=200,
            headers={"Content-Type": "image/jpeg", "Content-Length": "5"},
        )
        upstream.iter_content.return_value = [b"image"]
        with patch.object(dashboard.requests, "get", return_value=upstream) as get:
            response = self.client.get(
                "/proxy/cover", query_string={"url": "https://i.scdn.co/image.jpg"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"image")
        self.assertEqual(response.headers["Cache-Control"], "public, max-age=86400")
        get.assert_called_once_with(
            "https://i.scdn.co/image.jpg",
            timeout=5,
            allow_redirects=False,
            stream=True,
        )
        upstream.close.assert_called_once_with()

    def test_pihole_route_is_registered_once(self):
        rules = [rule for rule in dashboard.app.url_map.iter_rules()
                 if rule.rule == "/api/pihole"]
        self.assertEqual(len(rules), 1)

    def test_unconfigured_pihole_does_not_attempt_login(self):
        with (
            patch.object(dashboard, "PIHOLE_APP_PASSWORD", None),
            patch.object(dashboard.requests, "post") as post,
        ):
            status = self.client.get("/api/pihole")
            toggle = self.client.post("/api/pihole/blocking", json={"enabled": True})
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json, {"configured": False, "enabled": False})
        self.assertEqual(toggle.status_code, 503)
        post.assert_not_called()

    def test_library_returns_favorites_and_five_distinct_recent_albums(self):
        self.sp.current_user_saved_tracks.return_value = {"total": 42, "items": []}
        albums = []
        for index in (1, 1, 2, 3, 4, 5, 6):
            albums.append({"track": {"album": {
                "id": f"album{index}", "name": f"Album {index}",
                "artists": [{"name": f"Artist {index}"}],
                "images": [{"url": f"https://i.scdn.co/{index}.jpg"}],
            }}})
        self.sp.current_user_recently_played.return_value = {"items": albums}

        response = self.client.get("/api/spotify/library")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["favorites"]["track_count"], 42)
        self.assertEqual(
            [album["id"] for album in response.json["albums"]],
            ["album1", "album2", "album3", "album4", "album5"],
        )
        self.assertTrue(response.json["albums"][0]["cover_url"].startswith("/proxy/cover?url="))
        self.sp.current_user_saved_tracks.assert_called_once_with(limit=1, offset=0)
        self.sp.current_user_recently_played.assert_called_once_with(limit=50)

    def test_library_play_shuffles_liked_songs_on_active_device(self):
        tracks = [{"track": {"uri": f"spotify:track:{index}"}} for index in range(4)]
        self.sp.current_user_saved_tracks.return_value = {
            "items": tracks, "total": 4, "next": None,
        }
        with patch.object(dashboard.random.SystemRandom, "shuffle",
                          lambda _self, values: values.reverse()):
            response = self.client.post("/api/spotify/library/play", json={"type": "liked"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["track_count"], 4)
        self.sp.start_playback.assert_called_once_with(
            device_id="desktop",
            uris=[f"spotify:track:{index}" for index in reversed(range(4))],
        )

    def test_library_play_shuffles_album_tracks_on_active_device(self):
        tracks = [{"uri": f"spotify:track:album{index}"} for index in range(3)]
        self.sp.album_tracks.return_value = {"items": tracks, "total": 3, "next": None}
        with patch.object(dashboard.random.SystemRandom, "shuffle",
                          lambda _self, values: values.reverse()):
            response = self.client.post(
                "/api/spotify/library/play", json={"type": "album", "id": "abc123"})
        self.assertEqual(response.status_code, 200)
        self.sp.album_tracks.assert_called_once_with("abc123", limit=50, offset=0)
        self.sp.start_playback.assert_called_once_with(
            device_id="desktop",
            uris=[f"spotify:track:album{index}" for index in reversed(range(3))],
        )

    def test_library_play_uses_at_most_100_liked_songs(self):
        pages = []
        for offset in (0, 50):
            pages.append({
                "items": [{"track": {"uri": f"spotify:track:{index}"}}
                          for index in range(offset, offset + 50)],
                "total": 150,
                "next": "next",
            })
        self.sp.current_user_saved_tracks.side_effect = pages
        response = self.client.post("/api/spotify/library/play", json={"type": "liked"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["track_count"], 100)
        self.assertEqual(len(self.sp.start_playback.call_args.kwargs["uris"]), 100)

    def test_library_play_handles_invalid_empty_and_no_device_states(self):
        for body, error in (
            ({}, "invalid_selection"),
            ({"type": "album", "id": "bad/id"}, "invalid_album_id"),
        ):
            with self.subTest(body=body):
                response = self.client.post("/api/spotify/library/play", json=body)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json["error"], error)

        self.sp.devices.return_value = {"devices": []}
        response = self.client.post("/api/spotify/library/play", json={"type": "liked"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json["error"], "no_active_device")

        self.sp.devices.return_value = {"devices": [
            {"id": "desktop", "is_active": True, "is_restricted": False}
        ]}
        self.sp.current_user_saved_tracks.return_value = {
            "items": [], "total": 0, "next": None,
        }
        response = self.client.post("/api/spotify/library/play", json={"type": "liked"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json["error"], "empty_selection")

    def test_devices_only_exposes_ui_fields(self):
        response = self.client.get("/api/spotify/devices")
        self.assertEqual(response.status_code, 200)
        device = response.json["devices"][0]
        self.assertEqual(device, {
            "id": "desktop", "name": "Desktop", "type": "Computer",
            "is_active": True, "volume_percent": 72, "is_restricted": False,
        })

    def test_empty_devices(self):
        for payload in (None, {}, {"devices": []}):
            with self.subTest(payload=payload):
                self.sp.devices.return_value = payload
                self.assertEqual(self.client.get("/api/spotify/devices").json, {"devices": []})

    def test_transfer_both_directions_preserves_playing_or_paused_state(self):
        for playback in ({"is_playing": True}, {"is_playing": False}, None, {}):
            for target in ("macbook", "desktop"):
                with self.subTest(target=target, playback=playback):
                    playing = bool(playback and playback.get("is_playing"))
                    self.sp.current_playback.side_effect = [playback, {
                        "is_playing": playing,
                        "device": {"id": target, "name": target, "is_active": True},
                    }]
                    response = self.client.post("/api/spotify/device/" + target)
                    self.assertEqual(response.status_code, 200)
                    self.assertTrue(response.json["ok"])
                    self.assertEqual(response.json["device"]["id"], target)
                    self.assertEqual(response.json["is_playing"], playing)
                    self.sp.transfer_playback.assert_called_with(
                        target, force_play=bool(playback and playback.get("is_playing")))
        self.sp.start_playback.assert_not_called()
        self.sp.pause_playback.assert_not_called()

    def test_delayed_transfer_resumes_only_after_target_becomes_active(self):
        for target in ("macbook", "desktop"):
            with self.subTest(target=target):
                origin = {"is_playing": True, "device": {"id": "old", "is_active": True}}
                paused = {"is_playing": False, "device": {"id": target, "is_active": True}}
                playing = {**paused, "is_playing": True}
                self.sp.current_playback.side_effect = [origin, origin, origin, paused, paused, playing]
                self.sp.start_playback.reset_mock()
                def check_target(**kwargs):
                    self.assertEqual(kwargs, {"device_id": target})
                    self.assertEqual(self.sp.current_playback.call_count, 4)
                self.sp.current_playback.reset_mock()
                self.sp.start_playback.side_effect = check_target
                response = self.client.post("/api/spotify/device/" + target)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json["device"]["id"], target)
                self.assertTrue(response.json["is_playing"])
                self.sp.start_playback.assert_called_once_with(device_id=target)

    def test_unconfirmed_transfer_is_not_success_and_never_resumes_old_device(self):
        self.sp.current_playback.return_value = {
            "is_playing": True, "device": {"id": "desktop", "is_active": True},
        }
        response = self.client.post("/api/spotify/device/macbook")
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json["error"], "device_transfer_timeout")
        self.sp.start_playback.assert_not_called()

    def test_resume_failure_and_timeout_return_confirmed_device(self):
        for failure in (None, requests.Timeout("Timed out")):
            with self.subTest(failure=failure):
                origin = {"is_playing": True}
                paused = {"is_playing": False, "device": {"id": "macbook", "is_active": True}}
                self.sp.current_playback.side_effect = [origin] + [paused] * 8
                self.sp.start_playback.side_effect = failure
                self.sp.start_playback.reset_mock()
                response = self.client.post("/api/spotify/device/macbook")
                self.assertEqual(response.status_code, 502 if failure else 504)
                self.assertFalse(response.json["ok"])
                self.assertEqual(response.json["device"]["id"], "macbook")
                self.sp.start_playback.assert_called_once_with(device_id="macbook")

    def test_idle_transfer_confirms_device_without_starting_audio(self):
        available = self.sp.devices.return_value
        active = {"id": "macbook", "name": "MacBook", "is_active": True}
        self.sp.devices.side_effect = [available, {"devices": [active]}]
        response = self.client.post("/api/spotify/device/macbook")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["device"]["id"], "macbook")
        self.sp.start_playback.assert_not_called()

    def test_current_includes_device_even_without_track(self):
        device = {"id": "macbook", "name": "MacBook", "is_active": True}
        self.sp.current_playback.return_value = {"device": device, "item": None}
        with patch.object(dashboard, "spotify_oauth", return_value=Mock()):
            response = self.client.get("/api/spotify/current")
        self.assertEqual(response.json["device"]["id"], "macbook")

    def test_current_returns_json_when_spotify_is_unavailable(self):
        self.sp.current_playback.side_effect = requests.Timeout("Timed out")
        with patch.object(dashboard, "spotify_oauth", return_value=Mock()):
            response = self.client.get("/api/spotify/current")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json, {"ok": False, "error": "spotify_unavailable"})

    def test_spotipy_sends_transfer_play_flag(self):
        client = spotipy.Spotify(auth="test")
        for playing in (True, False):
            with self.subTest(playing=playing), patch.object(client, "_put") as put:
                client.transfer_playback("macbook", force_play=playing)
                put.assert_called_once_with(
                    "me/player", payload={"device_ids": ["macbook"], "play": playing})

    def test_transfer_does_not_guess_when_playback_lookup_fails(self):
        self.sp.current_playback.side_effect = requests.Timeout("Timed out")
        response = self.client.post("/api/spotify/device/macbook")
        self.assertEqual(response.status_code, 502)
        self.assertFalse(response.json["ok"])
        self.sp.transfer_playback.assert_not_called()

    def test_missing_disappeared_and_restricted_devices(self):
        for path, status, error in (
            ("/api/spotify/device", 400, "device_id_required"),
            ("/api/spotify/device/", 400, "device_id_required"),
            ("/api/spotify/device/%20", 400, "device_id_required"),
            ("/api/spotify/device/gone", 404, "device_unavailable"),
            ("/api/spotify/device/speaker", 400, "device_restricted"),
        ):
            with self.subTest(path=path):
                response = self.client.post(path)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json["error"], error)
        self.sp.transfer_playback.assert_not_called()

    def test_auth_and_api_failures_return_json(self):
        for method, path in (("get", "/api/spotify/devices"),
                             ("post", "/api/spotify/device/macbook")):
            with self.subTest(path=path):
                with patch.object(dashboard, "spotify_client", return_value=None):
                    self.assertEqual(getattr(self.client, method)(path).status_code, 401)
                with patch.object(dashboard, "spotify_client", side_effect=SpotifyOauthError("expired")):
                    response = getattr(self.client, method)(path)
                    self.assertEqual(response.status_code, 401)
                    self.assertEqual(response.json["error"], "not_authed")
                for failure, status in (
                    (spotipy.SpotifyException(403, -1, "Forbidden"), 400),
                    (requests.Timeout("Timed out"), 502),
                ):
                    self.sp.devices.side_effect = failure
                    response = getattr(self.client, method)(path)
                    self.assertEqual(response.status_code, status)
                    self.assertFalse(response.json["ok"])
                self.sp.devices.side_effect = None

    def test_transfer_failure(self):
        self.sp.transfer_playback.side_effect = spotipy.SpotifyException(404, -1, "Gone")
        response = self.client.post("/api/spotify/device/macbook")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json["ok"])

    def test_explicit_play_pause_does_not_read_stale_playback(self):
        for playing, method in ((False, "pause_playback"), (True, "start_playback")):
            with self.subTest(playing=playing):
                response = self.client.post("/api/spotify/toggle", json={"is_playing": playing})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json, {"ok": True, "is_playing": playing})
                getattr(self.sp, method).assert_called_once_with()
        self.sp.current_playback.assert_not_called()

    def test_invalid_play_pause_target(self):
        for value in (None, "false", 0, []):
            with self.subTest(value=value):
                response = self.client.post("/api/spotify/toggle", json={"is_playing": value})
                self.assertEqual(response.status_code, 400)
        self.sp.start_playback.assert_not_called()
        self.sp.pause_playback.assert_not_called()

    def test_seek_rejects_malformed_positions(self):
        for body in (
            {"position_ms": "bad"},
            {"position_ms": True},
            {"position_ms": None},
            ["not", "an", "object"],
        ):
            with self.subTest(body=body):
                response = self.client.post("/api/spotify/seek", json=body)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.content_type, "application/json")
        self.sp.seek_track.assert_not_called()

    def test_existing_now_playing_and_active_device_controls(self):
        self.sp.current_playback.return_value = {
            "is_playing": True, "progress_ms": 1000,
            "item": {"id": "track", "name": "Song", "duration_ms": 180000,
                     "artists": [{"name": "Artist"}], "album": {"name": "Album", "images": []}},
        }
        with patch.object(dashboard, "spotify_oauth", return_value=Mock()):
            current = self.client.get("/api/spotify/current")
        self.assertEqual(current.json["track"]["name"], "Song")
        self.assertTrue(current.json["is_playing"])
        for path, method in (("toggle", "pause_playback"), ("next", "next_track"),
                             ("prev", "previous_track")):
            self.assertEqual(self.client.post("/api/spotify/" + path).status_code, 200)
            getattr(self.sp, method).assert_called_once_with()
        self.sp.current_playback.return_value = {"is_playing": False}
        self.client.post("/api/spotify/toggle")
        self.sp.start_playback.assert_called_once_with()
        self.client.post("/api/spotify/seek", json={"position_ms": 42000})
        self.sp.seek_track.assert_called_once_with(42000)


if __name__ == "__main__":
    unittest.main()
