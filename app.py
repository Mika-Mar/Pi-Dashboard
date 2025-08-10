import os
from flask import Flask, redirect, request, session, render_template, jsonify, url_for
from spotipy import Spotify
from spotipy.oauth2 import SpotifyOAuth

# ---------- Konfig ----------
CLIENT_ID = os.environ.get("SPOTIPY_CLIENT_ID")
CLIENT_SECRET = os.environ.get("SPOTIPY_CLIENT_SECRET")
REDIRECT_URI = os.environ.get("SPOTIPY_REDIRECT_URI", "http://127.0.0.1:8888/callback")
SCOPE = "user-read-playback-state user-read-currently-playing"

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-change-me")  # setz später was Zufälliges!
CACHE_PATH = ".cache"  # Token-Cache (Datei)

def get_auth_manager():
    for k in ("SPOTIPY_CLIENT_ID", "SPOTIPY_CLIENT_SECRET", "SPOTIPY_REDIRECT_URI"):
        if not os.environ.get(k):
            raise RuntimeError(f"Umgebungsvariable {k} fehlt.")

    return SpotifyOAuth(
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        redirect_uri=REDIRECT_URI,
        scope=SCOPE,
        cache_path=CACHE_PATH,
        show_dialog=False,
        open_browser=False,  # auf dem Pi praktischer
    )

def get_spotify():
    auth_manager = get_auth_manager()
    token_info = auth_manager.get_cached_token()
    if not token_info:
        return None
    return Spotify(auth_manager=auth_manager)

# ---------- Routes ----------
@app.route("/")
def index():
    # Wenn kein Token -> zur Login-Seite
    auth_manager = get_auth_manager()
    if not auth_manager.get_cached_token():
        return redirect(url_for("login"))
    return render_template("index.html", )

@app.route("/login")
def login():
    auth_manager = get_auth_manager()
    auth_url = auth_manager.get_authorize_url()
    return redirect(auth_url)

@app.route("/callback")
def callback():
    code = request.args.get("code")
    auth_manager = get_auth_manager()
    auth_manager.get_access_token(code)  # speichert in .cache
    return redirect(url_for("index"))

@app.route("/api/current")
def api_current():
    sp = get_spotify()
    if not sp:
        return jsonify({"authorized": False}), 401

    current = sp.current_playback()
    if not current:
        return jsonify({"authorized": True, "is_playing": False})

    item = current.get("item")
    if not item:
        return jsonify({"authorized": True, "is_playing": False})

    data = {
        "authorized": True,
        "is_playing": current.get("is_playing", False),
        "name": item.get("name"),
        "artist": ", ".join(a["name"] for a in item.get("artists", [])),
        "duration_ms": item.get("duration_ms", 0),
        "progress_ms": current.get("progress_ms", 0),
        "album_image": (item.get("album", {}).get("images", [{}])[0].get("url")),
    }
    return jsonify(data)

if __name__ == "__main__":
    # Auf dem Pi oft 0.0.0.0 nutzen, damit’s im Netzwerk erreichbar ist
    app.run(host="0.0.0.0", port=8888, debug=False)
