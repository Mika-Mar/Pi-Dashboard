from __future__ import annotations

import math
import os
import random
import re
import secrets
import socket
import subprocess
import time
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus, urlparse

import click
import psutil
import requests
import spotipy
from dotenv import load_dotenv, set_key
from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from spotipy.exceptions import SpotifyOauthError
from spotipy.oauth2 import SpotifyOAuth

app = Flask(__name__)

ENV_PATH = Path(
    os.getenv("PI_DASHBOARD_ENV_FILE", Path(__file__).with_name(".env"))
).expanduser()

load_dotenv(ENV_PATH)
app.secret_key = os.getenv("FLASK_SECRET_KEY") or secrets.token_hex(32)


# ---------- Helpers ----------
def cpu_temp():
    # 1) vcgencmd (Pi)
    try:
        out = subprocess.check_output(["vcgencmd", "measure_temp"]).decode()
        return float(out.split("=")[1].split("'")[0])
    except Exception:
        pass
    # 2) sysfs fallback (manche Distros)
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
            return int(f.read().strip()) / 1000.0
    except Exception:
        return None


# ---------- Pages ----------
@app.get("/")
def index():
    return render_template("index.html")


# ---------- System API ----------
@app.get("/api/system")
def api_system():
    disk = psutil.disk_usage("/")
    uptime_seconds = int(time.time() - psutil.boot_time())

    # Prüft nur, ob grundsätzlich eine Verbindung nach außen möglich ist.
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "1", "1.1.1.1"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        internet_online = result.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        internet_online = False

    return jsonify({
        "cpu_pct": psutil.cpu_percent(interval=0.15),
        "ram_pct": psutil.virtual_memory().percent,
        "temp_c": cpu_temp(),
        "disk_pct": disk.percent,
        "uptime_seconds": uptime_seconds,
        "internet_online": internet_online,
    })


PIHOLE_URL = os.getenv("PIHOLE_URL", "http://127.0.0.1")
PIHOLE_APP_PASSWORD = os.getenv("PIHOLE_APP_PASSWORD")

_pihole_sid = None


def get_pihole_sid():
    global _pihole_sid

    if _pihole_sid:
        return _pihole_sid

    r = requests.post(
        f"{PIHOLE_URL}/api/auth",
        json={"password": PIHOLE_APP_PASSWORD},
        timeout=3,
    )
    r.raise_for_status()

    data = r.json()
    _pihole_sid = data["session"]["sid"]

    return _pihole_sid


@app.get("/api/pihole")
def api_pihole():
    global _pihole_sid

    if not PIHOLE_APP_PASSWORD:
        return jsonify({"configured": False, "enabled": False})

    try:
        sid = get_pihole_sid()
        headers = {"X-FTL-SID": sid}

        stats_r = requests.get(
            f"{PIHOLE_URL}/api/stats/summary",
            headers=headers,
            timeout=3,
        )

        blocking_r = requests.get(
            f"{PIHOLE_URL}/api/dns/blocking",
            headers=headers,
            timeout=3,
        )

        # Session abgelaufen -> einmal neu anmelden
        if stats_r.status_code == 401 or blocking_r.status_code == 401:
            _pihole_sid = None
            sid = get_pihole_sid()
            headers = {"X-FTL-SID": sid}

            stats_r = requests.get(
                f"{PIHOLE_URL}/api/stats/summary",
                headers=headers,
                timeout=3,
            )

            blocking_r = requests.get(
                f"{PIHOLE_URL}/api/dns/blocking",
                headers=headers,
                timeout=3,
            )

        stats_r.raise_for_status()
        blocking_r.raise_for_status()

        stats = stats_r.json()
        blocking = blocking_r.json()

        queries = stats["queries"]

        return jsonify({
            "configured": True,
            "enabled": blocking.get("blocking") == "enabled",
            "queries": queries.get("total", 0),
            "blocked": queries.get("blocked", 0),
            "blocked_percent": queries.get("percent_blocked", 0),
        })

    except Exception as e:
        return jsonify({
            "configured": bool(PIHOLE_APP_PASSWORD),
            "enabled": False,
            "error": str(e),
        }), 502


# ---------- Optional APIs (erstmal ausgeschaltet) ----------

@app.get("/api/weather")
def api_weather():
    # Später echt anbinden; fürs Testen "disabled"
    return jsonify({"enabled": False})


# --- Echte Spotify-Anbindung mit Spotipy ---
SPOTIFY_SCOPE = (
    "user-read-playback-state user-modify-playback-state "
    "user-read-currently-playing user-library-read user-read-recently-played"
)

# Cache-Datei => nach erstem Login bleibt der Refresh-Token erhalten
CACHE_PATH = os.getenv("SPOTIPY_CACHE_PATH", ".cache-pi-dashboard")

DEFAULT_SPOTIFY_REDIRECT_URI = "http://127.0.0.1:8888/spotify/callback"
_sp_oauth: Optional[SpotifyOAuth] = None
_sp_oauth_config: Optional[tuple[str, str, str]] = None


def spotify_configuration():
    """Load Spotify settings from the environment (including the local .env)."""
    client_id = os.getenv("SPOTIPY_CLIENT_ID") or os.getenv("SPOTIFY_CLIENT_ID")
    client_secret = (
            os.getenv("SPOTIPY_CLIENT_SECRET") or os.getenv("SPOTIFY_CLIENT_SECRET")
    )
    redirect_uri = (
            os.getenv("SPOTIPY_REDIRECT_URI")
            or os.getenv("SPOTIFY_REDIRECT_URI")
            or DEFAULT_SPOTIFY_REDIRECT_URI
    )
    return client_id, client_secret, redirect_uri


def spotify_oauth() -> Optional[SpotifyOAuth]:
    """Create the OAuth manager only after credentials have been configured."""
    global _sp_oauth, _sp_oauth_config
    config = spotify_configuration()
    client_id, client_secret, redirect_uri = config
    if not client_id or not client_secret:
        return None
    if _sp_oauth is None or config != _sp_oauth_config:
        _sp_oauth = SpotifyOAuth(
            scope=SPOTIFY_SCOPE,
            cache_path=CACHE_PATH,
            client_id=client_id,
            client_secret=client_secret,
            redirect_uri=redirect_uri,
            show_dialog=False,
        )
        _sp_oauth_config = config
    return _sp_oauth


@app.cli.command("spotify-setup")
def spotify_setup_command():
    """Save Spotify app credentials so later starts load them automatically."""
    click.echo("Create an app first: https://developer.spotify.com/dashboard")
    click.echo(
        "Add this exact Redirect URI in its settings: "
        f"{DEFAULT_SPOTIFY_REDIRECT_URI}"
    )
    client_id = click.prompt("Spotify client ID").strip()
    client_secret = click.prompt("Spotify client secret", hide_input=True).strip()
    redirect_uri = click.prompt(
        "Redirect URI", default=DEFAULT_SPOTIFY_REDIRECT_URI
    ).strip()

    ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    ENV_PATH.touch(mode=0o600, exist_ok=True)
    try:
        ENV_PATH.chmod(0o600)
    except OSError:
        pass
    set_key(str(ENV_PATH), "SPOTIPY_CLIENT_ID", client_id)
    set_key(str(ENV_PATH), "SPOTIPY_CLIENT_SECRET", client_secret)
    set_key(str(ENV_PATH), "SPOTIPY_REDIRECT_URI", redirect_uri)
    click.echo(f"Spotify credentials saved in {ENV_PATH}.")
    click.echo("Start the dashboard, then open /spotify/login once to authorize it.")


def spotify_client() -> Optional[spotipy.Spotify]:
    """Gibt einen Spotipy-Client zurück oder None, wenn (noch) nicht eingeloggt."""
    oauth = spotify_oauth()
    if oauth is None:
        return None
    # Token im Cache vorhanden?
    try:
        token_info = oauth.get_cached_token()
    except SpotifyOauthError as error:
        if error.error != "invalid_grant":
            raise
        # Ein widerrufener Refresh-Token kann nie wieder verwendet werden.
        # Cache entfernen, damit ein neuer Login ihn sauber ersetzen kann.
        cache_path = Path(oauth.cache_handler.cache_path).expanduser()
        try:
            cache_path.unlink()
        except FileNotFoundError:
            pass
        session.pop("spotify_authed", None)
        return None
    if not token_info:
        return None
    # Spotipy kümmert sich via auth_manager um Refresh
    return spotipy.Spotify(auth_manager=oauth)


@app.get("/spotify/setup")
def spotify_setup():
    _, _, redirect_uri = spotify_configuration()
    return (
        "<h1>Spotify setup</h1>"
        "<p>Spotify does not provide an API that can create or retrieve app "
        "credentials. Create an app in the "
        '<a href="https://developer.spotify.com/dashboard">Spotify Developer Dashboard</a>, '
        f"add <code>{redirect_uri}</code> as its Redirect URI, then run:</p>"
        "<pre>flask --app app spotify-setup</pre>"
        "<p>The dashboard will load the saved credentials automatically afterwards.</p>"
    ), 503


@app.get("/spotify/login")
def spotify_login():
    oauth = spotify_oauth()
    if oauth is None:
        return redirect(url_for("spotify_setup"))
    state = secrets.token_urlsafe(32)
    session["spotify_oauth_state"] = state
    auth_url = oauth.get_authorize_url(state=state)
    return redirect(auth_url)


@app.get("/spotify/callback")
def spotify_callback():
    expected_state = session.pop("spotify_oauth_state", None)
    received_state = request.args.get("state")
    if (
        not expected_state
        or not received_state
        or not secrets.compare_digest(expected_state, received_state)
    ):
        return Response("Invalid Spotify login state.", status=400, mimetype="text/plain")

    err = request.args.get("error")
    if err:
        return Response(f"Spotify error: {err}", status=400, mimetype="text/plain")

    code = request.args.get("code")
    if not code:
        # nicht direkt aufrufen – erst /spotify/login!
        return ('Callback ohne ?code. '
                'Starte den Login neu: <a href="/spotify/login">/spotify/login</a>'), 400

    # Tausche Code gegen Tokens (wird im Cache gespeichert)
    oauth = spotify_oauth()
    if oauth is None:
        return redirect(url_for("spotify_setup"))
    # Einen eventuell ungültigen alten Cache beim Code-Austausch nicht prüfen.
    oauth.get_access_token(code, check_cache=False)
    session["spotify_authed"] = True
    return redirect(url_for("index"))


# --- Cover-Proxy: damit Canvas-Farbanalyse same-origin ist ---
ALLOW_COVER_HOSTS = {"i.scdn.co", "seeded.scdn.co"}
MAX_COVER_BYTES = 5 * 1024 * 1024


@app.get("/proxy/cover")
def proxy_cover():
    url = request.args.get("url", "")
    if not url:
        abort(400)
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        abort(400)
    if parsed.scheme != "https" or host not in ALLOW_COVER_HOSTS or port not in (None, 443):
        abort(400)

    upstream = None
    try:
        upstream = requests.get(
            url,
            timeout=5,
            allow_redirects=False,
            stream=True,
        )
        if 300 <= upstream.status_code < 400:
            abort(502)
        upstream.raise_for_status()

        content_type = upstream.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if not content_type.startswith("image/"):
            abort(502)

        content_length = upstream.headers.get("Content-Length")
        if content_length:
            try:
                if int(content_length) > MAX_COVER_BYTES:
                    abort(502)
            except ValueError:
                abort(502)

        chunks = []
        size = 0
        for chunk in upstream.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            size += len(chunk)
            if size > MAX_COVER_BYTES:
                abort(502)
            chunks.append(chunk)

        response = Response(b"".join(chunks), content_type=content_type)
        response.headers["Cache-Control"] = "public, max-age=86400"
        return response
    except requests.RequestException:
        abort(502)
    finally:
        if upstream is not None:
            upstream.close()


# --- API, die exakt zu deinem Frontend passt ---

def spotify_device_payload(device):
    if not device:
        return None
    fields = ("id", "name", "type", "is_active", "volume_percent", "is_restricted")
    return {field: device.get(field) for field in fields}


def spotify_cover_url(images):
    cover_src = images[0].get("url") if images else None
    return f"/proxy/cover?url={quote_plus(cover_src)}" if cover_src else None


def spotify_album_payload(album):
    return {
        "id": album.get("id"),
        "name": album.get("name") or "Unbekanntes Album",
        "artists": [artist.get("name") for artist in album.get("artists", [])
                    if artist.get("name")],
        "cover_url": spotify_cover_url(album.get("images") or []),
    }


def spotify_active_device(sp):
    devices = (sp.devices() or {}).get("devices") or []
    return next((device for device in devices
                 if device.get("is_active") and device.get("id")
                 and not device.get("is_restricted")), None)


def spotify_track_uris(fetch_page, maximum=100):
    """Collect up to Spotify's 100-URI playback limit."""
    uris = []
    offset = 0
    while len(uris) < maximum:
        page = fetch_page(min(50, maximum - len(uris)), offset) or {}
        items = page.get("items") or []
        for entry in items:
            track = (entry or {}).get("track") if "track" in (entry or {}) else entry
            if not track or track.get("is_local") or track.get("is_playable") is False:
                continue
            if track.get("uri"):
                uris.append(track["uri"])
                if len(uris) == maximum:
                    break
        offset += len(items)
        if not items or offset >= int(page.get("total") or offset) or not page.get("next"):
            break
    return uris


def confirm_spotify_transfer(sp, device_id, was_playing):
    """Wait for activation, then resume only on the confirmed target if needed."""
    confirmed_device = None
    resumed = False
    for delay in (0, 0.5, 0.75, 1, 1, 1.5, 2, 2):
        if delay:
            time.sleep(delay)
        playback = sp.current_playback() or {}
        device = playback.get("device") or {}
        # Idle sessions may have no playback object even after activation.
        if not device.get("id"):
            device = next((d for d in ((sp.devices() or {}).get("devices") or [])
                           if d.get("id") == device_id and d.get("is_active")), {})
        if device.get("id") != device_id or not device.get("is_active"):
            continue
        confirmed_device = spotify_device_payload(device)
        playing = bool(playback.get("is_playing"))
        if not was_playing or playing:
            return {"ok": True, "device": confirmed_device, "is_playing": playing}, 200
        if not resumed:
            # Resume the transferred context without replacing the queue/position.
            try:
                sp.start_playback(device_id=device_id)
            except (spotipy.SpotifyException, requests.RequestException):
                return {"ok": False, "error": "playback_resume_failed",
                        "device": confirmed_device}, 502
            resumed = True
    return {
        "ok": False,
        "error": "playback_resume_timeout" if confirmed_device else "device_transfer_timeout",
        "device": confirmed_device,
    }, 504


def spotify_login_required_payload(configured=True):
    payload = {
        "is_playing": False,
        "progress_ms": 0,
        "duration_ms": 0,
        "track": None,
        "need_login": True,
    }
    if not configured:
        payload.update({
            "spotify_configured": False,
            "setup_url": url_for("spotify_setup"),
        })
    return payload


@app.get("/api/spotify/current")
def api_spotify_current():
    try:
        if spotify_oauth() is None:
            return jsonify(spotify_login_required_payload(configured=False)), 200

        sp = spotify_client()
        if not sp:
            return jsonify(spotify_login_required_payload()), 200

        pb = sp.current_playback()
        if not pb or not pb.get("item"):
            return jsonify({
                "is_playing": False,
                "progress_ms": 0,
                "duration_ms": 0,
                "track": None,
                "device": spotify_device_payload((pb or {}).get("device")),
            }), 200

        item = pb["item"]
        images = item.get("album", {}).get("images", [])
        cover_url = spotify_cover_url(images)
        artists = [artist["name"] for artist in item.get("artists", [])]
        return jsonify({
            "device": spotify_device_payload(pb.get("device")),
            "is_playing": bool(pb.get("is_playing")),
            "progress_ms": int(pb.get("progress_ms") or 0),
            "duration_ms": int(item.get("duration_ms") or 0),
            "track": {
                "id": item.get("id") or "",
                "name": item.get("name") or "—",
                "artists": artists,
                "album": (item.get("album") or {}).get("name"),
                "cover_url": cover_url,
            },
        })
    except SpotifyOauthError:
        return jsonify(spotify_login_required_payload()), 200
    except spotipy.SpotifyException as error:
        if error.http_status == 401:
            return jsonify(spotify_login_required_payload()), 200
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502
    except requests.RequestException:
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502


@app.get("/api/spotify/devices")
def api_spotify_devices():
    try:
        sp = spotify_client()
        if not sp:
            return jsonify({"ok": False, "error": "not_authed"}), 401
        devices = (sp.devices() or {}).get("devices") or []
        return jsonify({"devices": [
            spotify_device_payload(device)
            for device in devices
        ]})
    except SpotifyOauthError:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except requests.RequestException:
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502


@app.get("/api/spotify/library")
def api_spotify_library():
    try:
        sp = spotify_client()
        if not sp:
            return jsonify({"ok": False, "error": "not_authed"}), 401

        saved = sp.current_user_saved_tracks(limit=1, offset=0) or {}
        recent = sp.current_user_recently_played(limit=50) or {}
        albums = []
        seen_album_ids = set()
        for entry in recent.get("items") or []:
            album = ((entry or {}).get("track") or {}).get("album") or {}
            album_id = album.get("id")
            if not album_id or album_id in seen_album_ids:
                continue
            seen_album_ids.add(album_id)
            albums.append(spotify_album_payload(album))
            if len(albums) == 5:
                break

        return jsonify({
            "favorites": {
                "type": "liked",
                "name": "Lieblingssongs",
                "track_count": int(saved.get("total") or 0),
            },
            "albums": albums,
        })
    except SpotifyOauthError:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except requests.RequestException:
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502


@app.post("/api/spotify/library/play")
def api_spotify_library_play():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "invalid_request"}), 400
    selection_type = data.get("type")
    album_id = str(data.get("id") or "").strip()
    if selection_type not in {"liked", "album"}:
        return jsonify({"ok": False, "error": "invalid_selection"}), 400
    if selection_type == "album" and not re.fullmatch(r"[A-Za-z0-9]{1,64}", album_id):
        return jsonify({"ok": False, "error": "invalid_album_id"}), 400

    try:
        sp = spotify_client()
        if not sp:
            return jsonify({"ok": False, "error": "not_authed"}), 401
        device = spotify_active_device(sp)
        if not device:
            return jsonify({"ok": False, "error": "no_active_device"}), 409

        if selection_type == "liked":
            uris = spotify_track_uris(
                lambda limit, offset: sp.current_user_saved_tracks(
                    limit=limit, offset=offset))
        else:
            uris = spotify_track_uris(
                lambda limit, offset: sp.album_tracks(
                    album_id, limit=limit, offset=offset))
        if not uris:
            return jsonify({"ok": False, "error": "empty_selection"}), 409

        random.SystemRandom().shuffle(uris)
        sp.start_playback(device_id=device["id"], uris=uris)
        return jsonify({
            "ok": True,
            "device": spotify_device_payload(device),
            "track_count": len(uris),
        })
    except SpotifyOauthError:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except requests.RequestException:
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502


@app.post("/api/spotify/device", defaults={"device_id": ""}, strict_slashes=False)
@app.post("/api/spotify/device/<device_id>")
def api_spotify_device(device_id):
    device_id = device_id.strip()
    if not device_id:
        return jsonify({"ok": False, "error": "device_id_required"}), 400
    try:
        sp = spotify_client()
        if not sp:
            return jsonify({"ok": False, "error": "not_authed"}), 401
        # Recheck availability/restrictions: the picker may have stale data.
        devices = (sp.devices() or {}).get("devices") or []
        device = next((d for d in devices if d.get("id") == device_id), None)
        if device is None:
            return jsonify({"ok": False, "error": "device_unavailable"}), 404
        if device.get("is_restricted"):
            return jsonify({"ok": False, "error": "device_restricted"}), 400
        # Explicitly continue a running song on the target. A paused/idle
        # session must not start playing just because its device changes.
        playback = sp.current_playback()
        was_playing = bool(playback and playback.get("is_playing"))
        sp.transfer_playback(device_id, force_play=was_playing)
        result, status = confirm_spotify_transfer(sp, device_id, was_playing)
        return jsonify(result), status
    except SpotifyOauthError:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except requests.RequestException:
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502


@app.post("/api/spotify/toggle")
def api_spotify_toggle():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict) or ("is_playing" in data and not isinstance(data["is_playing"], bool)):
        return jsonify({"ok": False, "error": "is_playing must be boolean"}), 400
    try:
        sp = spotify_client()
        if not sp:
            return jsonify({"ok": False, "error": "not_authed"}), 401
        # An explicit target avoids toggling against a stale Spotify snapshot.
        playing = data.get("is_playing")
        if playing is None:
            pb = sp.current_playback()
            playing = not (pb and pb.get("is_playing"))
        if playing:
            sp.start_playback()
        else:
            sp.pause_playback()
        return jsonify({"ok": True, "is_playing": bool(playing)})
    except SpotifyOauthError:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except requests.RequestException:
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502


@app.post("/api/spotify/next")
def api_spotify_next():
    try:
        sp = spotify_client()
        if not sp:
            return jsonify({"ok": False, "error": "not_authed"}), 401
        sp.next_track()
        return jsonify({"ok": True})
    except SpotifyOauthError:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except requests.RequestException:
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502


@app.post("/api/spotify/prev")
def api_spotify_prev():
    try:
        sp = spotify_client()
        if not sp:
            return jsonify({"ok": False, "error": "not_authed"}), 401
        sp.previous_track()
        return jsonify({"ok": True})
    except SpotifyOauthError:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except requests.RequestException:
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502


@app.post("/api/spotify/seek")
def api_spotify_seek():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "invalid_request"}), 400
    position = data.get("position_ms")
    if isinstance(position, bool) or not isinstance(position, (int, float)):
        return jsonify({"ok": False, "error": "position_ms must be a number"}), 400
    if not math.isfinite(position):
        return jsonify({"ok": False, "error": "position_ms must be finite"}), 400
    pos = int(max(0, position))
    try:
        sp = spotify_client()
        if not sp:
            return jsonify({"ok": False, "error": "not_authed"}), 401
        sp.seek_track(pos)
        return jsonify({"ok": True})
    except SpotifyOauthError:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except requests.RequestException:
        return jsonify({"ok": False, "error": "spotify_unavailable"}), 502


# ---------- Dynamische SVG-Cover (same-origin, CORS-frei für Canvas) ----------
def hsl_to_rgb(h, s, l):
    # h in [0,1], s,l in [0,1] -> return (r,g,b) [0..255]
    def hue2rgb(p, q, t):
        if t < 0: t += 1
        if t > 1: t -= 1
        if t < 1 / 6: return p + (q - p) * 6 * t
        if t < 1 / 2: return q
        if t < 2 / 3: return p + (q - p) * (2 / 3 - t) * 6
        return p

    if s == 0:
        v = int(round(l * 255))
        return v, v, v
    q = l * (1 + s) if l < 0.5 else l + s - l * s
    p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
    return int(round(r * 255)), int(round(g * 255)), int(round(b * 255))


def rgb_hex(r, g, b):
    return f"#{r:02x}{g:02x}{b:02x}"


@app.get("/covers/<int:n>.svg")
def cover_svg(n: int):
    # zwei Hues pro n, damit die Bilder leicht unterschiedlich wirken
    h1 = ((n * 0.17) % 1.0)
    h2 = ((n * 0.37 + 0.15) % 1.0)
    r1, g1, b1 = hsl_to_rgb(h1, 0.6, 0.5)
    r2, g2, b2 = hsl_to_rgb(h2, 0.7, 0.45)
    c1 = rgb_hex(r1, g1, b1)
    c2 = rgb_hex(r2, g2, b2)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{c1}"/>
      <stop offset="100%" stop-color="{c2}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="460" cy="520" r="90" fill="rgba(255,255,255,0.08)"/>
</svg>"""
    return Response(svg, mimetype="image/svg+xml")


@app.get("/api/desktop")
def api_desktop():
    desktop_ip = os.getenv("DESKTOP_IP")

    if not desktop_ip:
        return jsonify({
            "configured": False,
            "online": False
        })

    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "1", desktop_ip],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        online = result.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        online = False

    return jsonify({
        "configured": True,
        "online": online
    })

def send_magic_packet(mac_address: str):
    mac = mac_address.replace(":", "").replace("-", "")

    if len(mac) != 12:
        raise ValueError("Invalid MAC address")

    data = bytes.fromhex("FF" * 6 + mac * 16)

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.sendto(data, ("255.255.255.255", 9))


@app.post("/api/desktop/wake")
def api_desktop_wake():
    mac = os.getenv("DESKTOP_MAC")

    if not mac:
        return jsonify({
            "ok": False,
            "error": "DESKTOP_MAC not configured"
        }), 503

    try:
        send_magic_packet(mac)
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({
            "ok": False,
            "error": str(e)
        }), 400


@app.post("/api/pihole/blocking")
def api_pihole_blocking():
    global _pihole_sid

    if not PIHOLE_APP_PASSWORD:
        return jsonify({
            "ok": False,
            "error": "PIHOLE_APP_PASSWORD not configured",
        }), 503

    try:
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify({
                "ok": False,
                "error": "invalid request",
            }), 400
        enabled = data.get("enabled")

        if not isinstance(enabled, bool):
            return jsonify({
                "ok": False,
                "error": "enabled must be boolean"
            }), 400

        sid = get_pihole_sid()

        r = requests.post(
            f"{PIHOLE_URL}/api/dns/blocking",
            headers={"X-FTL-SID": sid},
            json={
                "blocking": enabled
            },
            timeout=3,
        )

        # SID abgelaufen
        if r.status_code == 401:
            _pihole_sid = None
            sid = get_pihole_sid()

            r = requests.post(
                f"{PIHOLE_URL}/api/dns/blocking",
                headers={"X-FTL-SID": sid},
                json={
                    "blocking": enabled
                },
                timeout=3,
            )

        r.raise_for_status()

        return jsonify({
            "ok": True,
            "enabled": enabled
        })

    except Exception as e:
        return jsonify({
            "ok": False,
            "error": str(e)
        }), 502


# ---------- Dev-Server ----------
if __name__ == "__main__":
    # Auf dem Pi lieber Port 8080 nutzen (oder wie du magst)
    app.run(host="0.0.0.0", port=8888, debug=False)
