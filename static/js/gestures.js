// gestures.js
// Swipe carousel with wrap-around navigation for touch, pen, and mouse.
export function initSwipe({ wrapEl, viewportEl = wrapEl?.parentElement, dots, onChange, startIndex = 0 }) {
  if (!wrapEl) throw new Error("initSwipe requires wrapEl");
  if (!viewportEl) throw new Error("initSwipe requires a stationary viewport");

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
    if (event.target !== wrapEl || event.propertyName !== "transform") return;
    settleTransition();
  });

  // Use native touch events on touch browsers: WebKit can cancel the pointer
  // stream when it starts a scroll. Mouse and pen still use Pointer Events.
  const useTouchEvents = "ontouchstart" in window;
  const interactiveSelector = "button, a, input, select, textarea, [role='slider']";
  let pointerId = null;
  let touchId = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let startedAt = 0;
  let dragAxis = null;

  const resetDrag = () => {
    const capturedId = pointerId;
    pointerId = null;
    touchId = null;
    dragAxis = null;
    wrapEl.classList.remove("is-dragging");
    if (capturedId !== null && viewportEl.hasPointerCapture(capturedId)) {
      viewportEl.releasePointerCapture(capturedId);
    }
  };

  const startDrag = (x, y) => {
    startX = lastX = x;
    startY = y;
    startedAt = performance.now();
    dragAxis = null;
  };

  const moveDrag = (x, y, event) => {
    const dx = x - startX;
    const dy = y - startY;

    // Claim horizontal touches from the first move, before Safari starts its
    // native pan. Keep the distance threshold for actually starting a drag.
    if (event.cancelable && (dragAxis === "x"
      || (!dragAxis && Math.abs(dx) > Math.abs(dy)))) {
      event.preventDefault();
    }

    if (!dragAxis) {
      if (Math.hypot(dx, dy) < 8) return;
      dragAxis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (dragAxis === "y") return;
      wrapEl.classList.add("is-dragging");
    }
    if (dragAxis !== "x") return;

    lastX = x;
    const offset = -idx * wrapEl.clientWidth + dx;
    wrapEl.style.transform = `translate3d(${offset}px, 0, 0)`;
  };

  const finishDrag = (cancelled = false) => {
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

  // Listen on the stationary viewport, not the translated track. On iOS the
  // track's own hit-test region can be entirely outside the visible carousel.
  const canStartDrag = (target) => wrapEl.contains(target)
    && !target.closest(interactiveSelector);

  viewportEl.addEventListener("pointerdown", (event) => {
    if (useTouchEvents && event.pointerType === "touch") return;
    if (!event.isPrimary || transitioning || pointerId !== null || touchId !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!canStartDrag(event.target)) return;

    pointerId = event.pointerId;
    startDrag(event.clientX, event.clientY);
    viewportEl.setPointerCapture(pointerId);
  });
  viewportEl.addEventListener("pointermove", (event) => {
    if (event.pointerId === pointerId) moveDrag(event.clientX, event.clientY, event);
  }, { passive: false });
  viewportEl.addEventListener("pointerup", (event) => {
    if (event.pointerId === pointerId) finishDrag();
  });
  viewportEl.addEventListener("pointercancel", (event) => {
    if (event.pointerId === pointerId) finishDrag(true);
  });
  viewportEl.addEventListener("lostpointercapture", (event) => {
    if (event.pointerId === pointerId) finishDrag(true);
  });

  if (useTouchEvents) {
    viewportEl.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) {
        if (touchId !== null) finishDrag(true);
        return;
      }
      if (transitioning || pointerId !== null || touchId !== null) return;
      if (!canStartDrag(event.target)) return;
      const touch = event.changedTouches[0];
      touchId = touch.identifier;
      startDrag(touch.clientX, touch.clientY);
    }, { passive: false });

    viewportEl.addEventListener("touchmove", (event) => {
      if (touchId === null) return;
      if (event.touches.length !== 1) {
        finishDrag(true);
        return;
      }
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === touchId);
      if (touch) moveDrag(touch.clientX, touch.clientY, event);
    }, { passive: false });

    const endTouch = (event, cancelled = false) => {
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === touchId);
      if (!touch) return;
      if (!cancelled && dragAxis === "x") lastX = touch.clientX;
      finishDrag(cancelled);
    };
    viewportEl.addEventListener("touchend", (event) => endTouch(event));
    viewportEl.addEventListener("touchcancel", (event) => endTouch(event, true));
  }
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
