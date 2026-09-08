import { jget, jpost } from "./api.js";

export function initDesktop({
  statusEl,
  wakeButton,
  pollMs = 5000
}) {
  let intId = null;
  let visible = false;
  let waking = false;
  const desktopDotEl = document.getElementById("desktopDot");

  function setStatus(online) {
  if (!statusEl) return;

  statusEl.textContent = online ? "ONLINE" : "OFFLINE";

  if (desktopDotEl) {
    desktopDotEl.classList.toggle("online", online);
    desktopDotEl.classList.toggle("offline", !online);
  }

  if (wakeButton) {
    wakeButton.disabled = online;
  }

  if (online) {
    waking = false;
  }
}

  async function refresh() {
    if (!visible) return;

    try {
      const data = await jget("/api/desktop");

      if (!data.configured) {
        statusEl.textContent = "NOT CONFIGURED";
        if (wakeButton) wakeButton.disabled = true;
        return;
      }

      setStatus(data.online);
    } catch (e) {
      console.warn("[desktop] status failed", e);

      if (statusEl) {
        statusEl.textContent = "● UNKNOWN";
      }
    }
  }

  async function wake() {
    if (waking) return;

    try {
      waking = true;

      if (wakeButton) {
        wakeButton.disabled = true;
        wakeButton.textContent = "Waking…";
      }

      await jpost("/api/desktop/wake");

      if (statusEl) {
        statusEl.textContent = "● WAKING";
      }

      // PC bekommt etwas Zeit, bevor wir erneut prüfen.
      setTimeout(refresh, 3000);

    } catch (e) {
      console.error("[desktop] wake failed", e);
      waking = false;

      if (statusEl) {
        statusEl.textContent = "● ERROR";
      }
    } finally {
      if (wakeButton) {
        wakeButton.textContent = "Wake Desktop";
        wakeButton.disabled = false;
      }
    }
  }

  wakeButton?.addEventListener("click", wake);

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

  return { start, stop, refresh, wake };
}