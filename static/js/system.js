// static/js/system.js
import { jget } from "./api.js";

export function initSystem({ cpuEl, ramEl, tempEl, containerEl, pollMs = 6000 }) {
  let intId = null;
  let visible = true; // falls du keinen IO nutzt

  // Sanfte Writer mit Checks (verhindert NaN-Anzeigen)
  const setCPU  = (v) => { if (Number.isFinite(v) && cpuEl)  cpuEl.textContent  = Math.round(v) + "%"; };
  const setRAM  = (v) => { if (Number.isFinite(v) && ramEl)  ramEl.textContent  = Math.round(v) + "%"; };
  const setTEMP = (v) => { if (tempEl) tempEl.textContent = (Number.isFinite(v) ? v.toFixed(1) : "—") + "°C"; };

  async function refresh() {
    try {
      if (!visible) return;
      const s = await jget("/api/system");

      setCPU(s.cpu_pct);
      setRAM(s.ram_pct);
      setTEMP(s.temp_c);
    } catch (e) {
      console.warn("[system] failed", e);
    }
  }

  function start() {
    if (intId) return;
    visible = true;
    refresh();
    intId = setInterval(refresh, pollMs);
  }
  function stop() {
    visible = false;
    if (intId) clearInterval(intId);
    intId = null;
  }

  // Optional: Sichtbarkeit via Viewport (funktioniert auch mit transform)
  if (containerEl && typeof window !== "undefined" && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        const isVis = e.isIntersecting;
        isVis ? start() : stop();
      },
      { root: null, threshold: [0, 0.1, 1] }
    );
    io.observe(containerEl);
  }

  // Ensure initial values are populated
  start();

  return { start, stop, refresh };
}
