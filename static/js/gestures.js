// gestures.js
export function initSwipe({ wrapEl, dots, onChange }) {
  const slides = Array.from(wrapEl.children);
  let idx = 0, start = 0, vX = 0, lastX = 0, lastT = 0, drag = false;
  const w = () => wrapEl.clientWidth, THRESH = 0.18, MAXV = 2;

  const setX = (px, animate) => {
    wrapEl.classList.toggle("swipe-anim", !!animate);
    wrapEl.style.transform = `translate3d(${px}px,0,0)`;
  };

  const snap = (i, animate = true) => {
    idx = Math.max(0, Math.min(i, slides.length - 1));
    setX(-idx * w(), animate);

    // Dots-UI aktualisieren
    if (dots?.length) {
      dots.forEach((d, j) => d.classList.toggle("active", j === idx));
    }

    // Callback immer nachziehen
    if (typeof onChange === "function") onChange(idx);
  };

  // Touch handling
  wrapEl.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return;
    drag = true;
    wrapEl.classList.remove("swipe-anim");
    start = lastX = e.touches[0].clientX;
    lastT = performance.now();
    vX = 0;
  }, { passive: true });

  wrapEl.addEventListener("touchmove", e => {
    if (!drag) return;
    const cur = e.touches[0].clientX;
    const dx = cur - start;
    const atS = idx === 0 && dx > 0;
    const atE = idx === slides.length - 1 && dx < 0;
    setX(-idx * w() + dx * ((atS || atE) ? 0.35 : 1), false);

    const t = performance.now();
    const dt = Math.max(1, t - lastT);
    vX = ((cur - lastX) / dt) * 16;
    lastX = cur; lastT = t;
  }, { passive: true });

  wrapEl.addEventListener("touchend", () => {
    if (!drag) return;
    drag = false;

    // aktuelle X-Position robust auslesen
    let curX = 0;
    const tf = wrapEl.style.transform; // "translate3d(123px,0,0)"
    if (tf && tf.startsWith("translate3d(")) {
      const n = parseFloat(tf.slice(12)); // pickt die 123
      if (!Number.isNaN(n)) curX = n;
    }

    const dx = curX + idx * w();
    const far = Math.abs(dx) > w() * THRESH;
    const fast = Math.abs(vX) > MAXV;
    if (far || fast) snap(dx < 0 ? idx + 1 : idx - 1);
    else snap(idx);
  });

  // Resize -> Position beibehalten
  window.addEventListener("resize", () => snap(idx, false));

  // Dots-Klicks EINMAL binden
  if (dots?.length) {
    dots.forEach((d, i) => d.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      snap(i);
    }));
  }

  // Start
  snap(0, false);
  return { next: () => snap(idx + 1), prev: () => snap(idx - 1), go: (i) => snap(i) };
}
