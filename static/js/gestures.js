// gestures.js
// Simple carousel that toggles visibility of slides.
export function initSwipe({ wrapEl, dots, onChange, startIndex = 0 }) {
  const slides = Array.from(wrapEl.children);
  let idx = startIndex;
  const THRESH = 50;

  // Show a specific slide and hide the others
  const show = (i) => {
    idx = Math.max(0, Math.min(i, slides.length - 1));
    slides.forEach((s, j) => {
      s.classList.toggle("active", j === idx);
      s.style.display = j === idx ? "" : "none";
    });

    if (dots?.length) {
      dots.forEach((d, j) => d.classList.toggle("active", j === idx));
    }

    if (typeof onChange === "function") onChange(idx);
  };

  // Basic swipe handling – detect horizontal swipe on release
  let startX = 0, dragging = false;
  wrapEl.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return;
    dragging = true;
    startX = e.touches[0].clientX;
  }, { passive: true });

  wrapEl.addEventListener("touchend", e => {
    if (!dragging) return;
    dragging = false;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > THRESH) show(idx + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // Bind dot navigation
  if (dots?.length) {
    dots.forEach((d, i) => d.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      show(i);
    }));
  }

  // Initial display
  show(startIndex);
  return {
    next: () => show(idx + 1),
    prev: () => show(idx - 1),
    go: (i) => show(i)
  };
}

