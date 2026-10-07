import { jget, jpost } from "./api.js";
import { dominantFromImage, boostColor } from "./colorCalc.js";
import { applyAccent } from "./theme.js";
import { initSpotifyLibrary } from "./spotifyLibrary.js";

export function initPlayer({
  coverEl, dotsEl,
  bgEl,
  titleEl,
  artistEl,
  progressWrapEl,
  progressBarEl,
  timeNowEl,
  timeTotalEl,
  btnPlayEl,
  btnPrevEl,
  btnNextEl,
  eqTextEl, eqTopEl,
  deviceSelectEl, deviceStatusEl,
  nowPlayingEl, libraryEl, libraryOpenEl, libraryBackEl,
  libraryItemsEl, libraryStatusEl,
  pollMs = 1000,
}) {
  const bindActivate = (el, fn) => {
    if (!el || typeof fn !== "function") return;
    let pointerHandled = false;

    el.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointerHandled = true;
      e.preventDefault();
      fn(e);
    });

    el.addEventListener("click", (e) => {
      if (pointerHandled) {
        pointerHandled = false;
        return;
      }
      fn(e);
    });
  };

  // ---- State ----
  let trackId = null;
  let durationMs = 0;
  let progressMs = 0;
  let isPlaying = false;
  let toggleInFlight = false;
  let playbackRevision = 0;
  let playbackRequest = 0;
  let appliedPlaybackRequest = 0;
  let pendingPlayback = null;
  let hasPlaybackTrack = false;

  let lastServerAt = 0;   // Date.now() der letzten Serverantwort
  let playStartWall = 0;  // "Startzeitpunkt" in Wallclock für smooth progress

  let readyToSeek = false;
  const controlsArmedAt = Date.now() + 1500; // 1.5s Grace-Periode
  const controlsArmed = () => Date.now() >= controlsArmedAt && !switchingDevice && !toggleInFlight
    && hasPlaybackTrack
    && !devices.some((device) => device.is_active && device.is_restricted);

  // ---- Spotify Connect (nur Fernsteuerung) ----
  let devices = [];
  let devicesLoaded = false;
  let deviceError = "";
  let transferError = "";
  let switchingDevice = false;
  let devicesRequest = null;
  let deviceRevision = 0;
  let confirmedTransfer = null;
  let lastDevicesAt = -Infinity;
  let destroyed = false;
  const devicePollMs = 20000;

  function applyActiveDevice(device) {
    if (device?.id && !devices.some((entry) => entry.id === device.id)) {
      devices.push(device);
    }
    devices = devices.map((entry) => ({
      ...entry,
      ...(entry.id === device?.id ? device : {}),
      is_active: !!device?.is_active && entry.id === device.id,
    }));
  }

  function retainConfirmedDevice() {
    if (confirmedTransfer && Date.now() < confirmedTransfer.until) {
      applyActiveDevice(confirmedTransfer.device);
    }
  }

  function renderDevices() {
    const active = devices.find((device) => device.is_active);
    if (deviceSelectEl) {
      const options = [];
      if (!active) {
        const label = deviceError ? "Geräte nicht verfügbar"
          : !devicesLoaded ? "Geräte werden geladen …"
          : devices.length ? "Kein aktives Gerät" : "Keine Spotify-Geräte verfügbar";
        const placeholder = new Option(label, "");
        placeholder.disabled = true;
        placeholder.selected = true;
        options.push(placeholder);
      }
      devices.forEach((device) => {
        const label = `${device.is_active ? "● " : ""}${device.name || "Unbekanntes Gerät"}`
          + (device.is_restricted ? " (eingeschränkt)" : "");
        const option = new Option(label, device.id || "", false, !!device.is_active);
        option.disabled = !device.id || !!device.is_restricted;
        options.push(option);
      });
      deviceSelectEl.replaceChildren(...options);
      deviceSelectEl.value = active?.id || "";
      deviceSelectEl.disabled = switchingDevice || toggleInFlight
        || !devices.some((device) => device.id && !device.is_restricted);
      deviceSelectEl.setAttribute("aria-busy", String(switchingDevice));
    }
    if (deviceStatusEl) {
      deviceStatusEl.textContent = switchingDevice ? "Gerät wird gewechselt …"
        : deviceError || transferError || (active?.is_restricted ? "Dieses Gerät erlaubt keine Fernsteuerung." : "");
    }
    const disabled = switchingDevice || toggleInFlight || !hasPlaybackTrack || !!active?.is_restricted;
    [btnPlayEl, btnPrevEl, btnNextEl].forEach((button) => {
      if (button) button.disabled = disabled;
    });
    progressWrapEl?.setAttribute("aria-disabled", String(disabled));
  }

  async function refreshDevices(force = false) {
    if (!deviceSelectEl || destroyed) return;
    if (devicesRequest) {
      await devicesRequest;
      if (!force || destroyed) return;
    }
    if (!force && (switchingDevice || Date.now() - lastDevicesAt < devicePollMs)) return;
    lastDevicesAt = Date.now();
    const revision = deviceRevision;
    devicesRequest = (async () => {
      try {
        const data = await jget("/api/spotify/devices", { cache: "no-store" });
        if (destroyed || revision !== deviceRevision) return;
        devices = Array.isArray(data.devices) ? data.devices : [];
        retainConfirmedDevice();
        devicesLoaded = true;
        deviceError = "";
      } catch {
        if (destroyed || revision !== deviceRevision) return;
        devices = [];
        retainConfirmedDevice();
        deviceError = "Spotify-Geräte konnten nicht geladen werden.";
      }
      renderDevices();
    })();
    try {
      await devicesRequest;
    } finally {
      devicesRequest = null;
    }
  }

  async function transferDevice() {
    const device = devices.find((entry) => entry.id === deviceSelectEl?.value);
    if (destroyed || switchingDevice || toggleInFlight || !device?.id || device.is_active || device.is_restricted) {
      renderDevices();
      return;
    }
    switchingDevice = true;
    deviceRevision++;
    playbackRevision++;
    confirmedTransfer = null;
    deviceError = "";
    transferError = "";
    renderDevices(); // Bis zur Spotify-Antwort bleibt das bisher aktive Gerät ausgewählt.
    try {
      const result = await jpost(`/api/spotify/device/${encodeURIComponent(device.id)}`);
      if (destroyed) return;
      // Success includes the device that Spotify actually confirmed as active.
      confirmedTransfer = { device: result.device, until: Date.now() + 10000 };
      applyActiveDevice(result.device);
      pendingPlayback = { isPlaying: result.is_playing, until: Date.now() + 3000 };
    } catch (error) {
      if (destroyed) return;
      if (error.data?.device?.is_active) {
        confirmedTransfer = { device: error.data.device, until: Date.now() + 10000 };
        applyActiveDevice(error.data.device);
      }
      transferError = error.data?.error?.startsWith("playback_resume_")
        ? "Gerät gewechselt, Wiedergabe nicht bestätigt. Bitte Play drücken."
        : "Gerätewechsel nicht bestätigt. Bitte erneut versuchen.";
    } finally {
      deviceRevision++;
      playbackRevision++;
      switchingDevice = false;
      if (!destroyed) {
        renderDevices();
        await refreshAfterControl(true);
      }
    }
  }
  deviceSelectEl?.addEventListener("change", transferDevice);

  // ---- Cover preload ----
  const coverPreload = new Image();
  coverPreload.crossOrigin = "anonymous";
  coverPreload.decoding = "async";

  // ---- Helpers ----
  const pad = (n) => String(n).padStart(2, "0");
  const fmtTime = (ms) => {
    ms = Math.max(0, Math.floor(ms));
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return `${m}:${pad(ss)}`;
  };

  function wallProgressMs() {
    if (!isPlaying) return progressMs;
    const elapsed = Date.now() - playStartWall;
    return Math.min(durationMs, elapsed);
  }
  function setEqPaused(paused){
  // Klassen toggeln
    eqTopEl?.classList.toggle("paused", paused);
    eqTextEl?.classList.toggle("paused", paused);
    coverEl?.classList.toggle("cover--playing", !paused);
    // Fallback direkt auf die Bars (falls CSS überschrieben wird)
    [eqTopEl, eqTextEl].forEach(root=>{
      if(!root) return;
      root.querySelectorAll("span").forEach(s=>{
        s.style.animationPlayState = paused ? "paused" : "running";
      });
   });
  }
  // ---- Render ----
  function render() {
    const cur = wallProgressMs();
    if (progressBarEl && durationMs > 0) {
      const ratio = Math.max(0, Math.min(1, cur / durationMs));
      progressBarEl.style.width = (ratio * 100).toFixed(3) + "%";
    }
    if (timeNowEl)   timeNowEl.textContent = fmtTime(cur);
    if (timeTotalEl) timeTotalEl.textContent = fmtTime(durationMs);
    if (btnPlayEl) btnPlayEl.classList.toggle("is-playing", !!isPlaying);
      setEqPaused(!isPlaying);
  }

  // Smooth UI zwischen Polls
  let rafId = 0;
  function loop() {
    render();
    rafId = requestAnimationFrame(loop);
  }

  // ---- Track-UI ----
  function setTrackUI({ name, artists, album, cover_url }) {
    if (titleEl)  titleEl.textContent = name ?? "—";
    if (artistEl) artistEl.textContent = (artists && artists.length) ? artists.join(", ") : "—";
    // if (albumEl)  albumEl.textContent = album ?? "—";

    if (coverEl && cover_url) {
      coverPreload.onload = () => {
        coverEl.classList.add("cover--loading");
        coverEl.src = coverPreload.src;

        if (bgEl) {
          bgEl.style.setProperty("--bg-url", `url("${coverPreload.src}")`);
          bgEl.classList.remove("bg-zoom");   // Animation resetten
            void bgEl.offsetWidth;              // reflow zum Neustarten
            bgEl.classList.add("bg-zoom");
        }

        const run = () => {
          try {
            const { rgb } = dominantFromImage(coverPreload);
            const boosted = boostColor(rgb, { sat: 1.15, light: 1.03 });
            applyAccent(boosted, eqTextEl);
            applyAccent(boosted, eqTopEl);
            applyAccent(boosted, dotsEl);
          } catch (e) {
            console.warn("dominant color failed", e);
          } finally {
            requestAnimationFrame(() => coverEl.classList.remove("cover--loading"));
          }
        };
        (window.requestIdleCallback ? requestIdleCallback(run, { timeout: 150 }) : setTimeout(run, 0));
      };
      if (coverPreload.src !== cover_url) coverPreload.src = cover_url;
    }
  }

  // ---- Server state anwenden ----
  function applyServer(s) {
    // Ignore lagging snapshots from the old device just after confirmation.
    if (confirmedTransfer && Date.now() < confirmedTransfer.until
      && s.device?.id !== confirmedTransfer.device?.id) return;
    if (s.device?.id) {
      applyActiveDevice(s.device);
      renderDevices();
    }
    const t = s.track || {};
    const newId = s.track
      ? (t.id || `${t.name}__${(t.artists || []).join("_")}__${t.album || ""}`)
      : null;
    const serverPlaying = !!s.is_playing;
    // Spotify may briefly report the state from before a successful command.
    // Bound this grace period so changes from other Spotify clients still win.
    if (pendingPlayback && Date.now() < pendingPlayback.until
      && (!s.track || (newId === trackId && serverPlaying !== pendingPlayback.isPlaying))) return;
    if (pendingPlayback && (newId !== trackId || Date.now() >= pendingPlayback.until)) {
      pendingPlayback = null;
    }
    const serverHasTrack = !!s.track;
    hasPlaybackTrack = serverHasTrack;
    library.setHasTrack(serverHasTrack);
    renderDevices();
    if (!serverHasTrack) {
      trackId = null;
      durationMs = 0;
      progressMs = 0;
      isPlaying = false;
      lastServerAt = Date.now();
      setEqPaused(true);
      render();
      return;
    }
    const switched = newId && newId !== trackId;
    const displayedProgress = wallProgressMs();
    const serverProgress = Number(s.progress_ms || 0);
    // Keep the animation continuous across minor polling/command latency.
    // Larger corrections (including external seeks) and new tracks still apply.
    const keepProgress = !switched && serverPlaying === isPlaying
      && Math.abs(serverProgress - displayedProgress) < 1500;
    trackId = newId;

    durationMs = Number(s.duration_ms || 0);
    progressMs = keepProgress ? Math.min(durationMs, displayedProgress) : serverProgress;
    isPlaying = serverPlaying;

    lastServerAt = Date.now();
    if (isPlaying) playStartWall = lastServerAt - progressMs;
    setEqPaused(!isPlaying);
    if (switched) {
      setTrackUI({
        name: t.name,
        artists: t.artists || [],
        album: t.album,
        cover_url: t.cover_url,
      });
    }
  }

  // ---- Polling ----
  async function refreshOnce(refreshDeviceList = false) {
    if (destroyed) return;
    const revision = playbackRevision;
    const requestId = ++playbackRequest;
    const deviceRefresh = refreshDevices(refreshDeviceList);
    try {
      const s = await jget("/api/spotify/current", { cache: "no-store" });
      if (!destroyed && !toggleInFlight && !switchingDevice && revision === playbackRevision
        && requestId > appliedPlaybackRequest) {
        appliedPlaybackRequest = requestId;
        applyServer(s);
        readyToSeek = true;
      }
    } catch (e) {
      // kein aktives Device etc. → okay
    }
    await deviceRefresh;
  }
  const pollId = setInterval(refreshOnce, pollMs);
  const controlRefreshTimers = new Set();

  function refreshAfterControl(refreshDeviceList = false, settlePlayback = false) {
    // Sofort pollen; kurze Wiederholungen fangen Spotifys verzögerte
    // Zustandsübernahme ab, ohne auf das reguläre Intervall zu warten.
    controlRefreshTimers.forEach(clearTimeout);
    controlRefreshTimers.clear();
    const refreshed = refreshOnce(refreshDeviceList);

    (settlePlayback ? [250, 800, 2000, 3500] : [250, 800]).forEach((delay) => {
      const timerId = setTimeout(() => {
        controlRefreshTimers.delete(timerId);
        void refreshOnce(refreshDeviceList && delay === 800);
      }, delay);
      controlRefreshTimers.add(timerId);
    });
    return refreshed;
  }

  const library = initSpotifyLibrary({
    nowPlayingEl,
    libraryEl,
    openButton: libraryOpenEl,
    backButton: libraryBackEl,
    itemsEl: libraryItemsEl,
    statusEl: libraryStatusEl,
    async onPlaybackStarted(result) {
      if (result?.device) {
        confirmedTransfer = { device: result.device, until: Date.now() + 5000 };
        applyActiveDevice(result.device);
        renderDevices();
      }
      pendingPlayback = { isPlaying: true, until: Date.now() + 4000 };
      playbackRevision++;
      await refreshAfterControl(false, true);
    },
  });

  refreshOnce();
  rafId = requestAnimationFrame(loop);

  // ---- Controls ----
  async function toggle() {
    if (!controlsArmed() || toggleInFlight) return;
    const previousPlaying = isPlaying;
    const previousProgress = wallProgressMs();
    const startedAt = Date.now();
    const targetPlaying = !isPlaying;
    toggleInFlight = true;
    transferError = "";
    playbackRevision++;
    // Capture the visible position BEFORE changing playback state.
    progressMs = previousProgress;
    playStartWall = startedAt - progressMs;
    isPlaying = targetPlaying;
    renderDevices();
    render();
    try {
      await jpost("/api/spotify/toggle", { is_playing: targetPlaying });
      pendingPlayback = { isPlaying: targetPlaying, until: Date.now() + 3000 };
    } catch {
      isPlaying = previousPlaying;
      progressMs = Math.min(durationMs, previousProgress
        + (previousPlaying ? Date.now() - startedAt : 0));
      playStartWall = Date.now() - progressMs;
      pendingPlayback = null;
    } finally {
      // Discard reads started before the command completed, even if they arrive later.
      playbackRevision++;
      toggleInFlight = false;
      if (!destroyed) {
        renderDevices();
        render();
        refreshAfterControl(false, true);
      }
    }
  }

  async function next() {
    if (!controlsArmed()) return;
    try {
      await jpost("/api/spotify/next");
      refreshAfterControl();
    } catch {}
  }

  async function prev() {
    if (!controlsArmed()) return;
    try {
      await jpost("/api/spotify/prev");
      refreshAfterControl();
    } catch {}
  }

  async function seekTo(ratio) {
    if (!controlsArmed() || !(durationMs > 0)) return;
    const pos = Math.max(0, Math.min(durationMs, Math.floor(durationMs * ratio)));
    // Guard: vermeide versehentliches Seek auf 0 kurz nach Poll
    if (wallProgressMs() > 2000 && pos === 0 && Date.now() - lastServerAt < 700) return;

    try {
      await jpost("/api/spotify/seek", { position_ms: pos });
      progressMs = pos;
      if (isPlaying) playStartWall = Date.now() - progressMs;
      render();
      setTimeout(refreshOnce, 200);
    } catch {}
  }

  // ---- Events ----
  bindActivate(btnPlayEl, toggle);
  bindActivate(btnPrevEl, prev);
  bindActivate(btnNextEl, next);

  if (progressWrapEl && progressBarEl) {
    let progressPointerHandled = false;
    const onProgress = (e) => {
      if (!controlsArmed() || !readyToSeek) return;
      const rect = progressWrapEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = rect.width > 0 ? x / rect.width : 0;
      seekTo(ratio);
    };

    progressWrapEl.addEventListener("pointerup", (e) => {
      progressPointerHandled = true;
      onProgress(e);
    });
    progressWrapEl.addEventListener("click", (e) => {
      if (progressPointerHandled) {
        progressPointerHandled = false;
        return;
      }
      onProgress(e);
    }, { passive: true });
  }

  // ---- Public API ----
  return {
    refresh: refreshOnce,
    toggle, next, prev, seekTo,
    get state() {
      return { trackId, durationMs, progressMs: wallProgressMs(), isPlaying };
    },
    destroy() {
      destroyed = true;
      deviceSelectEl?.removeEventListener("change", transferDevice);
      library.destroy();
      clearInterval(pollId);
      controlRefreshTimers.forEach(clearTimeout);
      controlRefreshTimers.clear();
      cancelAnimationFrame(rafId);
    },
  };
}
