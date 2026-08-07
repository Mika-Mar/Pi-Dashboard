from __future__ import annotations

from flask import Flask, render_template, jsonify, request, Response
from pathlib import Path
from typing import Optional
import subprocess, psutil, time, math, os

app = Flask(__name__)

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
    return jsonify({
        "cpu_pct": psutil.cpu_percent(interval=0.15),
        "ram_pct": psutil.virtual_memory().percent,
        "temp_c": cpu_temp()
    })

# ---------- Optional APIs (erstmal ausgeschaltet) ----------
@app.get("/api/pihole")
def api_pihole():
    # Später echt anbinden; fürs Testen "disabled"
    return jsonify({ "enabled": False })

@app.get("/api/weather")
def api_weather():
    # Später echt anbinden; fürs Testen "disabled"
    return jsonify({ "enabled": False })

# --- NEU: echte Spotify-Anbindung mit Spotipy ---
import os, time, math
from urllib.parse import urlparse, quote_plus
import requests
import click
from dotenv import load_dotenv
from dotenv import set_key
import spotipy
from spotipy.exceptions import SpotifyOauthError
from spotipy.oauth2 import SpotifyOAuth
from flask import session, redirect, url_for, request, jsonify, Response, abort

ENV_PATH = Path(
    os.getenv("PI_DASHBOARD_ENV_FILE", Path(__file__).with_name(".env"))
).expanduser()
load_dotenv(ENV_PATH)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-dev-dev")

SPOTIFY_SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing"

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
    auth_url = oauth.get_authorize_url()
    return redirect(auth_url)

@app.get("/spotify/callback")
def spotify_callback():
    err = request.args.get("error")
    if err:
        return f"Spotify error: {err}", 400

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
@app.get("/proxy/cover")
def proxy_cover():
    url = request.args.get("url", "")
    if not url:
        abort(400)
    host = urlparse(url).netloc.lower()
    if host not in ALLOW_COVER_HOSTS:
        abort(400)
    try:
        r = requests.get(url, timeout=5)
        ct = r.headers.get("Content-Type", "image/jpeg")
        return Response(r.content, content_type=ct)
    except requests.RequestException:
        abort(502)

# --- API, die exakt zu deinem Frontend passt ---

@app.get("/api/spotify/current")
def api_spotify_current():
    if spotify_oauth() is None:
        return jsonify({
            "is_playing": False,
            "progress_ms": 0,
            "duration_ms": 0,
            "track": None,
            "need_login": True,
            "spotify_configured": False,
            "setup_url": url_for("spotify_setup"),
        }), 200
    sp = spotify_client()
    if not sp:
        # Frontend kann /spotify/login verlinken, wenn not authed
        return jsonify({"is_playing": False, "progress_ms": 0, "duration_ms": 0, "track": None, "need_login": True}), 200

    pb = sp.current_playback()
    if not pb or not pb.get("item"):
        return jsonify({"is_playing": False, "progress_ms": 0, "duration_ms": 0, "track": None}), 200

    item = pb["item"]
    images = item.get("album", {}).get("images", [])
    cover_src = images[0]["url"] if images else None
    # über Proxy ausliefern, damit Canvas nicht tainted ist
    cover_url = f"/proxy/cover?url={quote_plus(cover_src)}" if cover_src else None

    artists = [a["name"] for a in item.get("artists", [])]
    payload = {
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
    }
    return jsonify(payload)

@app.post("/api/spotify/toggle")
def api_spotify_toggle():
    sp = spotify_client()
    if not sp:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    try:
        pb = sp.current_playback()
        if pb and pb.get("is_playing"):
            sp.pause_playback()
        else:
            sp.start_playback()
        return jsonify({"ok": True})
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400

@app.post("/api/spotify/next")
def api_spotify_next():
    sp = spotify_client()
    if not sp:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    try:
        sp.next_track()
        return jsonify({"ok": True})
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400

@app.post("/api/spotify/prev")
def api_spotify_prev():
    sp = spotify_client()
    if not sp:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    try:
        sp.previous_track()
        return jsonify({"ok": True})
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400

@app.post("/api/spotify/seek")
def api_spotify_seek():
    sp = spotify_client()
    if not sp:
        return jsonify({"ok": False, "error": "not_authed"}), 401
    data = request.get_json(silent=True) or {}
    pos = int(max(0, data.get("position_ms", 0)))
    try:
        sp.seek_track(pos)
        return jsonify({"ok": True})
    except spotipy.SpotifyException as e:
        return jsonify({"ok": False, "error": str(e)}), 400
# ---------- Dynamische SVG-Cover (same-origin, CORS-frei für Canvas) ----------
def hsl_to_rgb(h, s, l):
    # h in [0,1], s,l in [0,1] -> return (r,g,b) [0..255]
    def hue2rgb(p, q, t):
        if t < 0: t += 1
        if t > 1: t -= 1
        if t < 1/6: return p + (q - p) * 6 * t
        if t < 1/2: return q
        if t < 2/3: return p + (q - p) * (2/3 - t) * 6
        return p
    if s == 0:
        v = int(round(l * 255))
        return v, v, v
    q = l * (1 + s) if l < 0.5 else l + s - l * s
    p = 2 * l - q
    r = hue2rgb(p, q, h + 1/3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1/3)
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

# ---------- Dev-Server ----------
if __name__ == "__main__":
    # Auf dem Pi lieber Port 8080 nutzen (oder wie du magst)
    app.run(host="0.0.0.0", port=8888, debug=False)
