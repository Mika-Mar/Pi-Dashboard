// gestures.js
// Swipe carousel with wrap-around navigation for touch, pen, and mouse.
export function initSwipe({ wrapEl, dots, onChange, startIndex = 0 }) {
  if (!wrapEl) throw new Error("initSwipe requires wrapEl");

  // Collect original slides and create clones for seamless looping
  const origSlides = Array.from(wrapEl.children);
  const count = origSlides.length;
  if (!count) return { next() {}, prev() {}, go() {} };

  const firstClone = origSlides[0].cloneNode(true);
  const lastClone = origSlides[count - 1].cloneNode(true);
  [firstClone, lastClone].forEach((clone) => {
    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
  });
  wrapEl.appendChild(firstClone);
  wrapEl.insertBefore(lastClone, wrapEl.firstChild);

  const slides = Array.from(wrapEl.children); // includes clones
  let idx = startIndex + 1; // account for leading clone
  let transitioning = false;
  let transitionTimer = 0;

  const updateDots = (realIdx) => {
    if (!dots?.length) return;
    dots.forEach((d, j) => d.classList.toggle("active", j === realIdx));
  };

  // Show slide by internal index (includes clones)
  const show = (i, { animate = true } = {}) => {
    clearTimeout(transitionTimer);
    idx = Math.max(0, Math.min(count + 1, i));
    transitioning = animate;
    if (!animate) wrapEl.style.transition = "none";

    // Keep the temporary edge slides in sync with live player/tile content.
    if (idx === 0) lastClone.innerHTML = origSlides[count - 1].innerHTML;
    else if (idx === count + 1) firstClone.innerHTML = origSlides[0].innerHTML;

    slides.forEach((s, j) => s.classList.toggle("active", j === idx));
    wrapEl.style.transform = `translateX(-${idx * 100}%)`;

    const realIdx = (idx - 1 + count) % count;
    updateDots(realIdx);
    if (typeof onChange === "function") onChange(realIdx);

    if (!animate) {
      requestAnimationFrame(() => (wrapEl.style.transition = ""));
    } else {
      // Fallback in case a browser does not emit transitionend.
      transitionTimer = setTimeout(settleTransition, 450);
    }
  };

  function settleTransition() {
    clearTimeout(transitionTimer);
    transitionTimer = 0;
    transitioning = false;
    if (idx === 0) show(count, { animate: false });
    else if (idx === count + 1) show(1, { animate: false });
  }

  // After sliding onto a clone, jump to the real slide without animation
  wrapEl.addEventListener("transitionend", (event) => {
    if (event.propertyName !== "transform") return;
    settleTransition();
  });

  // Pointer Events cover touchscreens, pens, and mouse dragging. Vertical
  // movement remains available for scrolling on short displays.
  const interactiveSelector = "button, a, input, select, textarea, [role='slider']";
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let startedAt = 0;
  let dragAxis = null;

  const resetDrag = () => {
    pointerId = null;
    dragAxis = null;
    wrapEl.classList.remove("is-dragging");
  };

  wrapEl.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || transitioning) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target.closest(interactiveSelector)) return;

    pointerId = event.pointerId;
    startX = lastX = event.clientX;
    startY = event.clientY;
    startedAt = performance.now();
    dragAxis = null;
  });

  wrapEl.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragAxis) {
      if (Math.hypot(dx, dy) < 8) return;
      dragAxis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (dragAxis === "y") return;
      wrapEl.setPointerCapture(event.pointerId);
      wrapEl.classList.add("is-dragging");
    }
    if (dragAxis !== "x") return;

    event.preventDefault();
    lastX = event.clientX;
    const offset = -idx * wrapEl.clientWidth + dx;
    wrapEl.style.transform = `translate3d(${offset}px, 0, 0)`;
  }, { passive: false });

  const finishDrag = (event, cancelled = false) => {
    if (event.pointerId !== pointerId) return;
    const wasHorizontal = dragAxis === "x";
    const dx = lastX - startX;
    const elapsed = Math.max(1, performance.now() - startedAt);
    const velocity = Math.abs(dx) / elapsed;
    const threshold = Math.min(80, Math.max(36, wrapEl.clientWidth * 0.12));
    const shouldChange = !cancelled
      && wasHorizontal
      && (Math.abs(dx) >= threshold || (Math.abs(dx) >= 16 && velocity >= 0.45));

    resetDrag();
    if (!wasHorizontal) return;
    // Commit the restored CSS transition before setting the target position.
    void wrapEl.offsetWidth;
    show(idx + (shouldChange ? (dx < 0 ? 1 : -1) : 0));
  };

  wrapEl.addEventListener("pointerup", (event) => finishDrag(event));
  wrapEl.addEventListener("pointercancel", (event) => finishDrag(event, true));
  wrapEl.addEventListener("lostpointercapture", (event) => {
    if (event.pointerId === pointerId) finishDrag(event, true);
  });
  wrapEl.addEventListener("dragstart", (event) => event.preventDefault());

  const bindActivate = (el, fn) => {
    if (!el || typeof fn !== "function") return;
    let pointerHandled = false;

    el.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointerHandled = true;
      e.preventDefault();
      e.stopPropagation();
      fn(e);
    });

    el.addEventListener("click", (e) => {
      if (pointerHandled) {
        pointerHandled = false;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      fn(e);
    });
  };

  // Dot navigation (real slide indices)
  if (dots?.length) {
    dots.forEach((d, i) => bindActivate(d, () => show(i + 1)));
  }

  // Initialize
  show(startIndex + 1, { animate: false });

  return {
    next: () => show(idx + 1),
    prev: () => show(idx - 1),
    go: (i) => show(i + 1),
  };
}
