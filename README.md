# Pi Dashboard

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
