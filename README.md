# Pi Dashboard

## Installation

Create the virtual environment and install every required package with one command:

```shell
./setup.sh
```

The script can be run again later to synchronize an existing `.venv` with
`requirements.txt`. To select a different Python executable, use for example:

```shell
PI_DASHBOARD_PYTHON=python3.11 ./setup.sh
```

Without the script, the equivalent commands are:

```shell
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

## Spotify setup

Spotify requires an app created in the
[Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Spotify does not
offer an API for automatically creating an app or retrieving its client secret.

1. Create a Spotify app and add
   `http://127.0.0.1:8888/spotify/callback` as its Redirect URI.
2. Save the credentials once:

   ```shell
   .venv/bin/flask --app app spotify-setup
   ```

3. Start the dashboard and visit `/spotify/login` once.

The command stores the credentials in the ignored local `.env` file. On every later
start, `app.py` loads them automatically. Existing `SPOTIPY_CLIENT_ID`,
`SPOTIPY_CLIENT_SECRET`, and `SPOTIPY_REDIRECT_URI` environment variables also work.

## Spotify Connect device selection

The Now Playing widget includes a **Wiedergabe auf** device picker. The active
device has a **●** marker. Choose another available device to transfer the
current playback context. The Pi dashboard is a controller/display only; audio
stays on the Spotify app or Connect speaker you select. No local player or Web
Playback SDK is used.

- `GET /api/spotify/devices` returns only device ID, name, type, active state,
  volume percentage, and restriction state.
- `POST /api/spotify/device/<device_id>` checks availability/restrictions and
  reads the current playback state before transferring. It calls Spotipy 2.26.0
  with `force_play=True` for a running song, so playback continues on the selected
  device. Paused or idle sessions use `force_play=False` and stay paused.
  It checks activation for up to eight attempts (about nine seconds of retry
  delays). If a running song becomes paused on the confirmed target, it explicitly
  resumes that device's transferred context once and verifies playback. Success
  includes the confirmed device and playback state; an unconfirmed transfer or
  resume returns an error instead of claiming success.
- Devices refresh on startup and every 20 seconds using the existing 10-second
  playback poll, plus immediately after a transfer and once more after 800 ms
  to catch delayed Spotify updates. Playback also refreshes after transfer.
  The picker immediately uses the device confirmed by the transfer response.
  Older in-flight reads are discarded; lagging snapshots cannot overwrite that
  confirmation for ten seconds. The regular playback response also includes its
  active device, so the label updates without reloading the page.
- The picker stays disabled during switching and only marks devices active when
  Spotify reports them. Empty, inactive, restricted, and failed device states
  are shown in the widget. Restricted devices cannot be selected; playback
  controls are disabled while the active device is restricted.
- When no track is loaded, the widget shows **Lieblingssongs** (Spotify Liked
  Songs) and the five most recently played distinct albums. The same selection
  is available during playback through the **Auswahl** button; **Zurück** returns
  to Now Playing. Clicking a card builds a shuffled queue of up to 100 playable
  tracks and starts it on the active Connect device. Album/history data is
  cached in the browser for 60 seconds.
- `GET /api/spotify/library` returns the Liked Songs count and five recent album
  cards. `POST /api/spotify/library/play` starts a validated `liked` or `album`
  selection on Spotify's active unrestricted device.

The OAuth scopes are `user-read-playback-state`,
`user-modify-playback-state`, `user-read-currently-playing`,
`user-library-read`, and `user-read-recently-played`. The last two are new, so
**you must visit `/spotify/login` once after installing this update** and approve
the expanded access. Spotipy rejects an older cached token when it does not
contain all requested scopes. Keep the existing credentials and OAuth setup.

### Manual verification on the Pi

1. Restart the dashboard, visit `/spotify/login` once to authorize the new
   library/history scopes, and reload Chromium. Open Now Playing (first pager dot).
   Open Spotify on Desktop and MacBook using the dashboard's authorized account.
   Spotify's transfer API requires Premium.
2. Start a song on Desktop. Verify the title, progress, and active-device marker,
   then test play/pause, previous, next, and seek.
3. Select MacBook. Confirm its active marker appears and audio moves to MacBook.
   Repeat MacBook → Desktop. Check that the Pi never outputs Spotify audio.
4. Pause, transfer to the other device, and confirm playback remains paused.
5. Close a Spotify client; once Spotify removes it, the next device refresh
   should remove it from the picker. With available but inactive devices, expect
   “Kein aktives Gerät”; with none, expect “Keine Spotify-Geräte verfügbar”.
6. Stop playback so no track is loaded. Confirm the widget shows Liked Songs and
   five distinct recent albums. Start both a Liked Songs card and an album card;
   confirm each starts in shuffled order on the active device. During playback,
   use **Auswahl** and **Zurück** to switch views without stopping the song.
7. Temporarily disconnect the Pi's network. Device errors should stay within the
   widget while navigation and the rest of the page still work. Reconnect and
   confirm the picker recovers on a subsequent poll.

API regression checks (mocked Spotify; no real playback or token access):

```shell
.venv/bin/python -B -m unittest discover -s tests -v
node --test tests/player.test.mjs
```

The player tests cover pause/resume progress, delayed and out-of-order playback
responses, duplicate clicks, and recovery from failed commands, without Spotify
credentials or a browser.

Spotify references:
[transfer playback](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback),
[available devices and restrictions](https://developer.spotify.com/documentation/web-api/reference/get-a-users-available-devices),
[saved tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks),
and [recently played tracks](https://developer.spotify.com/documentation/web-api/reference/get-recently-played).

Optional browser regression checks use Playwright with mocked API responses
and a temporary local HTTP server. With Playwright and its Chromium installed:

```shell
node tests/spotify_devices.browser.cjs
```

If Playwright is installed outside this project, set `NODE_PATH` to its
`node_modules` directory. Optionally set `CHROMIUM_EXECUTABLE` to an existing
Chromium binary. These checks cover device polling, both transfer directions,
paused transfers, the empty-state library, both shuffled selection types, view
navigation, controls, failure recovery, and 1024×600 / 800×480 / 375×667
layouts; they do not verify real Spotify audio handoff.
