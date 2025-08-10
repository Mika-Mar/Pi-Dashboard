// ------- State für Smooth-Progress -------
let currentMs = 0;         // letzter von der API gelieferter Fortschritt (ms)
let durationMs = 0;        // Tracklänge (ms)
let lastUpdate = 0;        // Zeitstempel (ms), wann wir currentMs erhalten haben
let isPlaying = false;     // spielt gerade?
let playStartWall = 0;      // wall-clock Start (Date.now - progressMs) fürs Zeitlabel
let trackKey = "";// eindeutiger Track-Schlüssel (z.B. name+artist) zum Erkennen von Trackwechseln
let lastKnownPlaying = null;

const progressEl = document.getElementById('progress');
const barEl      = document.getElementById('bar');

const $ = sel => document.querySelector(sel);

const cover = document.getElementById('cover');
cover.addEventListener('load', () => {
  coverReady = true;
  maybeDoneLoading();
});
const eqEl  = document.getElementById('eq');
const clockEl = document.getElementById('clock');


let idleTimer;
function checkIdleMode(isPlaying) {
  clearTimeout(idleTimer);
  if (!isPlaying) {
    idleTimer = setTimeout(() => {
      document.body.classList.add("idle");
    }, 10000); // nach 10s Pause Idle Mode
  } else {
    document.body.classList.remove("idle");
  }
}

document.body.classList.add('loading');

let firstDataLoaded = false;
let coverReady = false;

function maybeDoneLoading(){
  if (firstDataLoaded && coverReady) {
    document.body.classList.remove('loading');
  }
}


function nowMs() { return performance.now(); }
// Beispiel: wenn du aus der Spotify API die Cover-URL hast:
function setCover(url){
  cover.crossOrigin = 'anonymous';  // wichtig für Canvas/CORS (i.scdn.co erlaubt das)
  cover.src = url;
}

const bar = document.getElementById('bar');
const tNowEl = document.getElementById('tNow');
const tDurEl = document.getElementById('tDur');

// Helper: sofort ohne Animation setzen
function snapBar(ratio) {
  bar.style.transition = 'none';
  bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  // Reflow erzwingen, damit die Änderung ohne Transition übernommen wird
  void bar.offsetWidth;
  // Transition wieder aktivieren (leerer String = CSS-Default)
  bar.style.transition = '';
}

// Bei jedem neuen Cover neu einfärben
cover.addEventListener('load', async () => {
  try {
    const { rgb } = dominantFromImage(cover);
    // leicht boost für Sättigung/Helligkeit
    const boosted = boostColor(rgb, {sat: 1.15, light: 1.05});
    const [r,g,b] = boosted;
    /*eqEl.style.setProperty('--bar', `rgb(${r}, ${g}, ${b})`);
    eqEl.style.setProperty('--bar-dim', `rgba(${r}, ${g}, ${b}, 0.35)`);*/
    setEqPaletteVisible(boosted)
    /*clockEl.style.setProperty('--bar',`rgb(${r}, ${g}, ${b})`);
    const stroke = (L > 0.55) ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.85)';
    clockEl.style.setProperty('--bar-stroke', stroke);*/
    //bar.style.setProperty('--text', `rgb(${r}, ${g}, ${b})`)
  } catch (e) {
    console.warn('Color extraction failed:', e);
  }
});

// Schnell & simpel: dominante/Ø-Farbe (Downsampling + Histogramm)
function dominantFromImage(img){
  const w = 64, h = Math.max(1, Math.round((img.naturalHeight/img.naturalWidth)*64));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Quantisierung auf 32er Stufen für "dominant"
  const bins = new Map();
  let rSum=0,gSum=0,bSum=0,count=0;

  for (let i=0;i<data.length;i+=4){
    const a = data[i+3];
    if (a < 128) continue; // transparente Pixel ignorieren
    const r = data[i], g = data[i+1], b = data[i+2];
    rSum += r; gSum += g; bSum += b; count++;

    const key = `${r>>3}-${g>>3}-${b>>3}`; // 5 Bit pro Kanal
    bins.set(key, (bins.get(key)||0)+1);
  }

  if (!count) return { rgb:[34,197,94] }; // fallback

  // häufigstes Bin = dominante Farbe (Mittel innerhalb des Bins reicht hier)
  let maxKey=null, max=0;
  for (const [k,v] of bins) if (v>max){ max=v; maxKey=k; }
  let dom = [rSum/count, gSum/count, bSum/count]; // fallback: Ø-Farbe
  if (maxKey){
    const parts = maxKey.split('-').map(x=>parseInt(x,10));
    dom = parts.map(p => Math.min(255, (p<<3) + 4)); // zurück auf 0..255, kleine Mitte
  }

  return { rgb: dom.map(x=>Math.round(x)) };
}

function boostColor([r,g,b], {sat=1, light=1}={}){
  let [h,s,l] = rgbToHsl(r,g,b);
  s = Math.min(1, s*sat);
  l = Math.min(1, l*light);
  const [rr,gg,bb] = hslToRgb(h,s,l);
  return [rr,gg,bb];
}

function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h,s,l = (max+min)/2;
  if(max===min){ h=0; s=0; }
  else{
    const d = max-min;
    s = l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h = (g-b)/d + (g<b?6:0); break;
      case g: h = (b-r)/d + 2; break;
      case b: h = (r-g)/d + 4; break;
    }
    h/=6;
  }
  return [h,s,l];
}
function hslToRgb(h,s,l){
  if(s===0){
    const v = Math.round(l*255);
    return [v,v,v];
  }
  const hue2rgb = (p,q,t)=>{
    if(t<0) t+=1;
    if(t>1) t-=1;
    if(t<1/6) return p + (q-p)*6*t;
    if(t<1/2) return q;
    if(t<2/3) return p + (q-p)*(2/3 - t)*6;
    return p;
  };
  const q = l < .5 ? l*(1+s) : l + s - l*s;
  const p = 2*l - q;
  const r = hue2rgb(p,q,h+1/3);
  const g = hue2rgb(p,q,h);
  const b = hue2rgb(p,q,h-1/3);
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function setEqPaletteVisible([r,g,b]){
  // Basisfarbe (hast du eh schon aus dem Cover):
  eqEl.style.setProperty('--bar', `rgb(${r}, ${g}, ${b})`);
  eqEl.style.setProperty('--bar-glow', `rgba(${r}, ${g}, ${b}, 0.35)`);

  // Luminanz -> wähle helle ODER dunkle Outline automatisch
  const srgb = [r,g,b].map(v=>v/255);
  const toLin = c => c<=0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
  const [R,G,B] = srgb.map(toLin);
  const L = 0.2126*R + 0.7152*G + 0.0722*B;

  // Helle Farbe => dunkle Outline, dunkle Farbe => helle Outline
  const stroke = (L > 0.55) ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.85)';
  eqEl.style.setProperty('--bar-dim', stroke);
}


function msToTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function cutAtChar(text, char) {
  let idx = text.indexOf(char);
  if (text[idx - 1] == ' ') {
    idx = idx - 1;
  }
  return idx !== -1 ? text.slice(0, idx).trim() : text;
}

// Play/Pause für den EQ toggeln
function setEqPlaying(isPlaying) {
  const eq = document.querySelector('#eq');
  if (!eq) return;
  eq.classList.toggle('paused', !isPlaying);
}


function startProgressCSS(duration, progress) {
  if (!progressEl || !barEl) return;
  durationMs = duration;

  progressEl.classList.remove('paused');
  progressEl.style.setProperty('--dur', `${duration}ms`);
  progressEl.style.setProperty('--neg-progress', `${-progress}ms`);

  barEl.style.animation = 'none';
  void barEl.offsetWidth;
  barEl.style.animation = '';

  playStartWall = Date.now() - progress;

  if (tDurEl) tDurEl.textContent = msToTime(duration);
  if (tNowEl) tNowEl.textContent = msToTime(progress); // <- sofort anzeigen
}


/** Friert bei Pause auf exakter Position ein (ohne „Nachlauf“) */
function pauseProgressCSS(duration, progressFromAPI) {
  if (!progressEl || !barEl) return;

  // 1) aktuellen visuellen Fortschritt auslesen (scaleX aus matrix(...))
  let ratioFromVisual = null;
  const tr = getComputedStyle(barEl).transform; // z.B. "matrix(0.42, 0, 0, 1, 0, 0)"
  if (tr && tr !== 'none' && tr.startsWith('matrix(')) {
    const parts = tr.slice(7, -1).split(',');
    const a = parseFloat(parts[0]); // scaleX
    if (Number.isFinite(a)) ratioFromVisual = Math.max(0, Math.min(1, a));
  }

  // 2) Fallback über Zeitbasis (falls transform nicht lesbar)
  const playedNow = Math.min(Date.now() - playStartWall, duration || 0);
  const apiMs     = typeof progressFromAPI === 'number' ? progressFromAPI : 0;

  // Nimm die "neuere" Quelle, damit es nie rückwärts springt
  const freezeMs = Math.max(apiMs, playedNow);
  let ratio = ratioFromVisual != null
    ? ratioFromVisual
    : (duration > 0 ? Math.max(0, Math.min(1, freezeMs / duration)) : 0);

  // 3) zuerst den Zielstand setzen, dann pausieren -> kein Zucken
  progressEl.style.setProperty('--ratio', ratio.toFixed(6));
  progressEl.classList.add('paused');    // schaltet animation: none; transform: scaleX(var(--ratio))

  // 4) Zeit-Label passend einfrieren
  const ms = Math.round(ratio * (duration || 0));
  if (tNowEl) tNowEl.textContent = msToTime(ms);
}




async function checkPlaybackState() {
  try {
    const res = await fetch('/api/playstate', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const playing = !!data.is_playing;

    if (playing !== lastKnownPlaying) {
      lastKnownPlaying = playing;
      setEqPlaying(playing);

      const progress = typeof data.progress_ms === 'number' ? data.progress_ms : 0;

      if (!playing) {
        // Sofort pixelgenau einfrieren
        pauseProgressCSS(durationMs, progress);
	checkIdleMode(playing);
      } else {
        // Sofort an richtiger Stelle weiterlaufen
        startProgressCSS(durationMs, progress);
      }
    }
  } catch (e) {
    console.error('playstate error', e);
  }
}





// Voll: Track-/Meta-Daten, 1s Poll
async function fetchCurrent() {
  try {
    const res = await fetch('/api/current', { cache: 'no-store' });
    if (!res.ok) { window.location.href = '/login'; return; }
    const data = await res.json();
    if (!data.authorized) { window.location.href = '/login'; return; }

    const uiIsPlaying = (lastKnownPlaying !== null) ? lastKnownPlaying : !!data.is_playing;
    setEqPlaying(uiIsPlaying);


    const newKey = `${data.name}__${data.artist}`;
    const trackChanged = newKey !== trackKey;

    const newDuration = data.duration_ms || 0;
    const progress    = data.progress_ms || 0;

    // Trackwechsel oder andere Dauer => Animation frisch initialisieren
    if (trackChanged || newDuration !== durationMs) {
      startProgressCSS(newDuration, progress);
      trackKey = newKey;

      // Meta aktualisieren
      const titleEl = document.getElementById('title');
      const artistEl = document.getElementById('artist');
      const coverEl  = document.getElementById('cover');
      const bgEl     = document.getElementById('bg');

      if (titleEl)  titleEl.textContent  = cutAtChar(data.name, '(');
      if (artistEl) artistEl.textContent = data.artist || '–';
      if (coverEl && data.album_image) {
        coverEl.crossOrigin = 'anonymous';
        coverEl.src = data.album_image;
      }
      if (bgEl && data.album_image) {
        bgEl.style.backgroundImage = `url("${data.album_image}?t=${Date.now()}")`;
      }
      // Früh exit: Rest macht Play/Pause unten
      if (!firstDataLoaded) {
      firstDataLoaded = true;
      maybeDoneLoading();
    }
    }
    setTimeout(() => {
  if (firstDataLoaded) document.body.classList.remove('loading');
    }, 2000);

    if (!uiIsPlaying) {
      // Pausiert: fix auf exakten Wert
      pauseProgressCSS(newDuration || durationMs, progress);
      return;
    }

    // Spielt: wir richten immer an den gelieferten Werten aus
    // (sehr responsiv: bei jedem Poll kurz die Animation neu ausrichten)
    startProgressCSS(newDuration || durationMs, progress);

  } catch (e) {
    console.error('current error', e);
  }
}

// Start
fetchCurrent();
checkPlaybackState();
setInterval(fetchCurrent, 1000);   // Track/Meta
setInterval(checkPlaybackState, 150); // schnelles Play/Pause
(function startClock(){
  const el = document.getElementById('clock');
  if (!el) return;

  const fmt = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Europe/Berlin'
  });

  function tick(){
    el.textContent = fmt.format(new Date());
    // zum nächsten vollen Sekundentick ausrichten:
    const drift = 1000 - (Date.now() % 1000);
    setTimeout(tick, drift);
  }

  tick();

  // Beim Tab-Wechsel neu syncen, damit es nicht „nachhinkt“
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
})();


// --- Animation bleibt wie gehabt: nutzt currentMs/lastUpdate/isPlaying ---
// --- rAF-Loop mit performance.now ---
let lastShownSec = -1;

/*function animateProgress() {
  function frame() {
    if (durationMs > 0) {
      const now = nowMs();
      const displayed = isPlaying
        ? Math.min(currentMs + (now - lastUpdate), durationMs)
        : Math.min(currentMs, durationMs);

      const ratio = Math.min(1, Math.max(0, displayed / durationMs));
      bar.style.width = `${ratio * 100}%`;

      const sec = Math.floor(displayed / 1000); // <- floor
      if (sec !== lastShownSec) {
        tNow.textContent = msToTime(displayed);
        lastShownSec = sec;
      }
      // 3) tDur NICHT hier setzen (nur wenn sich duration ändert)
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
animateProgress()*/
