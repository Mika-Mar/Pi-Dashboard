import { jget, jpost } from "./api.js";
import { dominantFromImage, boostColor } from "./colorCalc.js";
import { applyAccent } from "./theme.js";

export function initPlayer({
  coverEl,
                             dotsEl,
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
  eqTextEl,
                             eqTopEl,
  pollMs = 1000,
}) {
  // ---- State ----
  let trackId = null;
  let durationMs = 0;
  let progressMs = 0;
  let isPlaying = false;

  let lastServerAt = 0;   // Date.now() der letzten Serverantwort
  let playStartWall = 0;  // "Startzeitpunkt" in Wallclock für smooth progress

  let readyToSeek = false;
  const controlsArmedAt = Date.now() + 1500; // 1.5s Grace-Periode
  const controlsArmed = () => Date.now() >= controlsArmedAt;

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
    const t = s.track || {};
    const newId = t.id || `${t.name}__${(t.artists || []).join("_")}__${t.album || ""}`;

    const switched = newId && newId !== trackId;
    trackId = newId;

    durationMs = Number(s.duration_ms || 0);
    progressMs = Number(s.progress_ms || 0);
    isPlaying  = !!s.is_playing;

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
  async function refreshOnce() {
    try {
      const s = await jget("/api/spotify/current");
      applyServer(s);
      readyToSeek = true;
    } catch (e) {
      // kein aktives Device etc. → okay
    }
  }
  const pollId = setInterval(refreshOnce, pollMs);
  refreshOnce();
  rafId = requestAnimationFrame(loop);

  // ---- Controls ----
  async function toggle() {
    if (!controlsArmed()) return;
    try {
      await jpost("/api/spotify/toggle");
      // Optimistic
      isPlaying = !isPlaying;
      if (isPlaying) {
        const cur = wallProgressMs();
        playStartWall = Date.now() - cur;
      }
      render();
      setTimeout(refreshOnce, 200);
    } catch {}
  }

  async function next() {
    if (!controlsArmed()) return;
    try {
      await jpost("/api/spotify/next");
      setTimeout(refreshOnce, 200);
    } catch {}
  }

  async function prev() {
    if (!controlsArmed()) return;
    try {
      await jpost("/api/spotify/prev");
      setTimeout(refreshOnce, 200);
    } catch {}
  }

  async function seekTo(ratio) {
    if (!(durationMs > 0)) return;
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
  btnPlayEl?.addEventListener("click", toggle);
  btnPrevEl?.addEventListener("click", prev);   // <— Funktionsreferenz!
  btnNextEl?.addEventListener("click", next);   // <— Funktionsreferenz!

  if (progressWrapEl && progressBarEl) {
    progressWrapEl.addEventListener("click", (e) => {
      if (!controlsArmed() || !readyToSeek) return;
      const rect = progressWrapEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = rect.width > 0 ? x / rect.width : 0;
      seekTo(ratio);
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
      clearInterval(pollId);
      cancelAnimationFrame(rafId);
    },
  };
}
