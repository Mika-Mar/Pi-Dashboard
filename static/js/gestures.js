// gestures.js
// Enhanced swipe carousel with wrap-around navigation.
export function initSwipe({ wrapEl, dots, onChange, startIndex = 0 }) {
  // Collect original slides and create clones for seamless looping
  const origSlides = Array.from(wrapEl.children);
  const count = origSlides.length;

  const firstClone = origSlides[0].cloneNode(true);
  const lastClone = origSlides[count - 1].cloneNode(true);
  wrapEl.appendChild(firstClone);
  wrapEl.insertBefore(lastClone, wrapEl.firstChild);

  const slides = Array.from(wrapEl.children); // includes clones
  let idx = startIndex + 1; // account for leading clone
  const THRESH = 50;

  const updateDots = (realIdx) => {
    if (!dots?.length) return;
    dots.forEach((d, j) => d.classList.toggle("active", j === realIdx));
  };

  // Show slide by internal index (includes clones)
  const show = (i, { animate = true } = {}) => {
    idx = i;
    if (!animate) wrapEl.style.transition = "none";

    slides.forEach((s, j) => s.classList.toggle("active", j === idx));
    wrapEl.style.transform = `translateX(-${idx * 100}%)`;

    const realIdx = (idx - 1 + count) % count;
    updateDots(realIdx);
    if (typeof onChange === "function") onChange(realIdx);

    if (!animate) requestAnimationFrame(() => (wrapEl.style.transition = ""));
  };

  // After sliding onto a clone, jump to the real slide without animation
  wrapEl.addEventListener("transitionend", () => {
    if (idx === 0) show(count, { animate: false });
    else if (idx === count + 1) show(1, { animate: false });
  });

  // Touch handling
  let startX = 0, dragging = false;
  wrapEl.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    dragging = true;
    startX = e.touches[0].clientX;
  }, { passive: true });

  wrapEl.addEventListener("touchend", (e) => {
    if (!dragging) return;
    dragging = false;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > THRESH) show(idx + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // Dot navigation (real slide indices)
  if (dots?.length) {
    dots.forEach((d, i) => d.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      show(i + 1);
    }));
  }

  // Initialize
  show(startIndex + 1, { animate: false });

  return {
    next: () => show(idx + 1),
    prev: () => show(idx - 1),
    go: (i) => show(i + 1),
  };
}

