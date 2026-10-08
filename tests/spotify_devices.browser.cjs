const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const server = http.createServer((req, res) => {
  const file = req.url === "/" ? "templates/index.html" : req.url.slice(1);
  try {
    let data = fs.readFileSync(path.join(root, file));
    if (file.endsWith(".html")) {
      data = data.toString().replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g, "/static/$1");
    }
    res.setHeader("Content-Type", file.endsWith(".html") ? "text/html"
      : file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
    res.end(data);
  } catch { res.writeHead(404).end(); }
});

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let devices = [
      { id: "desktop-id", name: "Desktop", is_active: true, is_restricted: false },
      { id: "macbook-id", name: "Mika's MacBook", is_active: false, is_restricted: false },
      { id: "speaker-id", name: "Living Room", is_active: false, is_restricted: true },
      { id: null, name: "Unknown client", is_active: false, is_restricted: false },
    ];
    let playing = true;
    let currentTrack = true;
    const librarySelections = [];
    let reportedDevices = null;
    let reportedPlaybackDevice = null;
    let holdNextDeviceRead = false;
    let releaseDeviceRead;
    let resumeFailure = false;
    let deviceFailure = false;
    let transferFailure = false;
    let delayTransfer = false;
    let releaseTransfer;
    let transferTarget;
    let deviceReads = 0;
    const waitFor = async predicate => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("Timed out waiting for mocked API request");
    };
    const posts = [];
    await page.route("**/api/**", async route => {
      const request = route.request();
      const endpoint = new URL(request.url()).pathname;
      if (request.method() === "POST") {
        posts.push(endpoint);
        if (endpoint === "/api/spotify/library/play") {
          librarySelections.push(request.postDataJSON());
          currentTrack = true;
          playing = true;
          return route.fulfill({ json: {
            ok: true,
            device: devices.find(d => d.is_active),
            track_count: 12,
          } });
        }
        if (endpoint.startsWith("/api/spotify/device/")) {
          transferTarget = decodeURIComponent(endpoint.split("/").pop());
          if (delayTransfer) await new Promise(resolve => { releaseTransfer = resolve; });
          if (transferFailure) return route.fulfill({ status: 400, json: { ok: false } });
          devices = devices.map(d => ({ ...d, is_active: d.id === transferTarget }));
          const device = devices.find(d => d.is_active);
          if (resumeFailure) {
            playing = false;
            return route.fulfill({ status: 504, json: { ok: false, error: "playback_resume_timeout", device } });
          }
          return route.fulfill({ json: { ok: true, device, is_playing: playing } });
        }
        if (endpoint === "/api/spotify/toggle") playing = !playing;
        return route.fulfill({ json: { ok: true } });
      }
      if (endpoint === "/api/spotify/devices") {
        deviceReads++;
        const snapshot = structuredClone(reportedDevices || devices);
        if (holdNextDeviceRead) {
          holdNextDeviceRead = false;
          await new Promise(resolve => { releaseDeviceRead = resolve; });
        }
        return route.fulfill({ status: deviceFailure ? 502 : 200, json: { devices: snapshot } });
      }
      if (endpoint === "/api/spotify/library") return route.fulfill({ json: {
        favorites: { type: "liked", name: "Lieblingssongs", track_count: 123 },
        albums: Array.from({ length: 5 }, (_, index) => ({
          id: `album${index + 1}`,
          name: `Recent Album ${index + 1}`,
          artists: [`Artist ${index + 1}`],
          cover_url: null,
        })),
      } });
      if (endpoint === "/api/spotify/current") return route.fulfill({ json: {
        is_playing: currentTrack && playing,
        progress_ms: currentTrack ? 30000 : 0,
        duration_ms: currentTrack ? 180000 : 0,
        device: reportedPlaybackDevice || devices.find(d => d.is_active) || null,
        track: currentTrack
          ? { id: "track-id", name: "Test Song", artists: ["Test Artist"], album: "Album" }
          : null,
      } });
      return route.fulfill({ json: { configured: true, online: true, cpu_pct: 12, ram_pct: 25, temp_c: 40 } });
    });
    await page.clock.install();
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.locator("#pager .dot").first().click();
    const picker = page.locator("#dash-now:not([aria-hidden]) #spotifyDevice");
    const status = page.locator("#dash-now:not([aria-hidden]) #spotifyDeviceStatus");
    const play = page.locator("#dash-now:not([aria-hidden]) #btnPlay");
    const expectValue = async value => {
      await page.waitForFunction(value =>
        document.querySelector("#dash-now:not([aria-hidden]) #spotifyDevice").value === value, value);
    };
    await expectValue("desktop-id");
    assert.match(await picker.locator("option:checked").textContent(), /● Desktop/);
    assert.equal(await page.locator("#titleText").textContent(), "Test Song");
    const libraryView = page.locator("#dash-now:not([aria-hidden]) #spotifyLibraryView");
    const nowPlayingView = page.locator("#dash-now:not([aria-hidden]) #nowPlayingView");
    await page.locator("#dash-now:not([aria-hidden]) #btnSpotifyLibrary").click();
    await page.waitForFunction(() => !document.querySelector("#dash-now:not([aria-hidden]) #spotifyLibraryView").hidden);
    await page.waitForFunction(() => document.querySelectorAll("#dash-now:not([aria-hidden]) .spotifyLibraryItem").length === 6);
    assert.equal(await libraryView.locator(".spotifyLibraryItem").count(), 6);
    assert.match(await libraryView.locator(".spotifyLibraryItem").first().textContent(), /Lieblingssongs/);
    await page.locator("#dash-now:not([aria-hidden]) #btnSpotifyNowPlaying").click();
    assert.equal(await nowPlayingView.isVisible(), true, "back button restores now playing");
    assert.equal(await picker.locator('option[value="speaker-id"]').isDisabled(), true);
    assert.equal(await picker.locator('option').last().isDisabled(), true);
    assert.equal(deviceReads, 1);
    await page.clock.fastForward(10000);
    assert.equal(deviceReads, 1, "playback polling must not fetch devices every time");
    await page.clock.fastForward(10000);
    await page.waitForFunction(() => document.querySelector("#clock").textContent !== "00:00");
    await waitFor(() => deviceReads === 2);

    // Reproduce a slow device read started before transfer and lagging snapshots
    // after success; the closed picker must show the confirmed device immediately.
    holdNextDeviceRead = true;
    await page.clock.fastForward(20000);
    await waitFor(() => !!releaseDeviceRead);
    reportedDevices = structuredClone(devices);
    reportedPlaybackDevice = structuredClone(devices[0]);
    delayTransfer = true;
    await picker.selectOption("macbook-id");
    assert.equal(await picker.isDisabled(), true);
    assert.equal(await play.isDisabled(), true);
    assert.equal(await picker.inputValue(), "desktop-id", "do not claim target before confirmation");
    await picker.dispatchEvent("change");
    assert.equal(posts.filter(p => p.includes("/device/")).length, 1);
    await waitFor(() => !!releaseTransfer);
    releaseTransfer();
    await expectValue("macbook-id");
    assert.match(await picker.locator("option:checked").textContent(), /● Mika's MacBook/);
    releaseDeviceRead();
    await page.waitForFunction(() => !document.querySelector("#dash-now:not([aria-hidden]) #spotifyDevice").disabled);
    await page.clock.fastForward(1000);
    await expectValue("macbook-id");
    assert.match(await picker.locator("option:checked").textContent(), /● Mika's MacBook/);
    reportedDevices = null;
    reportedPlaybackDevice = null;
    delayTransfer = false;
    await picker.selectOption("desktop-id");
    await expectValue("desktop-id");
    await page.waitForFunction(() => !document.querySelector("#dash-now:not([aria-hidden]) #spotifyDevice").disabled);
    await play.click();
    await waitFor(() => playing === false);
    await picker.selectOption("macbook-id");
    await expectValue("macbook-id");
    await page.waitForFunction(() => !document.querySelector("#dash-now:not([aria-hidden]) #spotifyDevice").disabled);
    assert.equal(playing, false, "transfer must not resume playback");
    await page.locator("#dash-now:not([aria-hidden]) #btnNext").click();
    await page.locator("#dash-now:not([aria-hidden]) #btnPrev").click();
    await page.locator("#dash-now:not([aria-hidden]) #progress").click();
    await waitFor(() => posts.includes("/api/spotify/seek"));
    for (const action of ["toggle", "next", "prev", "seek"]) {
      assert(posts.includes("/api/spotify/" + action), action + " still works");
    }

    transferFailure = true;
    await picker.selectOption("desktop-id");
    await page.waitForFunction(() => document.querySelector("#dash-now:not([aria-hidden]) #spotifyDeviceStatus").textContent.includes("nicht bestätigt"));
    assert.equal(await picker.inputValue(), "macbook-id");
    transferFailure = false;
    await page.clock.fastForward(1000); // finish existing post-control retries

    resumeFailure = true;
    await picker.selectOption("desktop-id");
    await expectValue("desktop-id");
    await page.waitForFunction(() => document.querySelector("#dash-now:not([aria-hidden]) #spotifyDeviceStatus").textContent.includes("Bitte Play drücken"));
    await page.clock.fastForward(1000);
    assert.match(await status.textContent(), /Bitte Play drücken/, "polling must not erase a resume failure");
    assert.equal(await play.isDisabled(), false);
    resumeFailure = false;
    await picker.selectOption("macbook-id");
    await expectValue("macbook-id");
    await page.clock.fastForward(1000);

    devices = devices.filter(d => d.id !== "macbook-id");
    await page.clock.fastForward(30000);
    await expectValue("");
    assert.match(await picker.locator("option:checked").textContent(), /Kein aktives Gerät/);
    assert.equal(await picker.isDisabled(), false);
    assert.equal(await picker.locator('option[value="macbook-id"]').count(), 0);

    devices = devices.map(d => ({ ...d, is_active: d.id === "speaker-id" }));
    await page.clock.fastForward(30000);
    await expectValue("speaker-id");
    assert.equal(await play.isDisabled(), true);
    assert.equal(await picker.isDisabled(), false, "can switch away from restricted device");

    devices = [];
    await page.clock.fastForward(30000);
    await expectValue("");
    assert.match(await picker.textContent(), /Keine Spotify-Geräte verfügbar/);
    assert.equal(await picker.isDisabled(), true);

    deviceFailure = true;
    await page.clock.fastForward(30000);
    await page.waitForFunction(() => document.querySelector("#dash-now:not([aria-hidden]) #spotifyDeviceStatus").textContent.includes("nicht geladen"));
    assert.match(await status.textContent(), /nicht geladen/);
    assert.equal(await page.locator("#titleText").textContent(), "Test Song");
    await page.locator("#pager .dot").nth(1).click();
    assert(await page.locator("#sysDash").first().evaluate(el => el.classList.contains("active")));
    await page.locator("#pager .dot").first().click();

    deviceFailure = false;
    devices = [{ id: "desktop-id", name: "A very long Desktop device name that must fit on a small Raspberry Pi screen", is_active: true }];
    await page.clock.fastForward(30000);
    await expectValue("desktop-id");
    assert.equal(await status.textContent(), "");

    currentTrack = false;
    playing = false;
    await page.clock.fastForward(10000);
    await page.waitForFunction(() => !document.querySelector("#dash-now:not([aria-hidden]) #spotifyLibraryView").hidden);
    assert.equal(await nowPlayingView.isHidden(), true, "empty playback opens the library");
    assert.equal(await play.isDisabled(), true, "empty playback controls are disabled");
    await libraryView.locator('.spotifyLibraryItem[data-type="liked"]').click();
    await page.clock.fastForward(1000);
    await page.waitForFunction(() => !document.querySelector("#dash-now:not([aria-hidden]) #nowPlayingView").hidden);
    assert.deepEqual(librarySelections[0], { type: "liked" });

    await page.locator("#dash-now:not([aria-hidden]) #btnSpotifyLibrary").click();
    await libraryView.locator('.spotifyLibraryItem[data-type="album"]').first().click();
    await page.clock.fastForward(1000);
    assert.deepEqual(librarySelections[1], { type: "album", id: "album1" });

    for (const [width, height] of [[1024, 600], [800, 480], [375, 667]]) {
      await page.setViewportSize({ width, height });
      const bounds = await picker.boundingBox();
      const playBounds = await play.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width, "picker fits width " + width);
      const viewport = await page.locator("#dashViewport").boundingBox();
      assert(bounds.y + bounds.height <= viewport.y + viewport.height,
        "picker fits visible height " + height + ": " + JSON.stringify(bounds));
      assert(playBounds.y + playBounds.height <= viewport.y + viewport.height, "controls fit height " + height);
      await status.evaluate(el => { el.textContent = "Spotify-Geräte konnten nicht geladen werden."; });
      const statusBounds = await status.boundingBox();
      assert(statusBounds.y + statusBounds.height <= viewport.y + viewport.height, "status fits height " + height);
      await status.evaluate(el => { el.textContent = ""; });
      await page.locator("#dash-now:not([aria-hidden]) #btnSpotifyLibrary").click();
      const libraryBounds = await libraryView.boundingBox();
      assert(libraryBounds.y + libraryBounds.height <= viewport.y + viewport.height,
        "library fits visible height " + height);
      await page.locator("#dash-now:not([aria-hidden]) #btnSpotifyNowPlaying").click();
    }
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.screenshot({ path: "/tmp/pi-dashboard-spotify.png" });
    assert.deepEqual(errors, []);
    console.log("Browser checks passed: confirmed picker label despite stale/in-flight reads, resume failure, polling, both transfer directions, paused transfer, controls, restrictions, empty/error/recovery states, and three viewport sizes.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => server.close());
