import { jget } from "./api.js";

export function initPihole({
    statusEl,
    queriesEl,
    blockedEl,
    percentEl,
    pollMs = 6000
}) {
    let intId = null;
    let visible = false;

    function setStatus(enabled) {
        if (!statusEl) return;

        statusEl.textContent = enabled ? "ACTIVE" : "DISABLED";

        const dot = document.getElementById("piholeDot");
        if (dot) {
            dot.classList.toggle("online", enabled);
            dot.classList.toggle("offline", !enabled);
        }
    }

    async function refresh() {
        if (!visible) return;

        try {
            const data = await jget("/api/pihole");

            if (!data.configured) {
                if (statusEl) statusEl.textContent = "NOT CONFIGURED";
                return;
            }

            setStatus(data.enabled);

            if (queriesEl) {
                queriesEl.textContent =
                    Number(data.queries ?? 0).toLocaleString("de-DE");
            }

            if (blockedEl) {
                blockedEl.textContent =
                    Number(data.blocked ?? 0).toLocaleString("de-DE");
            }

            if (percentEl) {
                percentEl.textContent =
                    Number(data.blocked_percent ?? 0).toFixed(1) + " %";
            }
        } catch (e) {
            console.warn("[pihole] failed", e);

            if (statusEl) statusEl.textContent = "ERROR";

            const dot = document.getElementById("piholeDot");
            if (dot) {
                dot.classList.remove("online");
                dot.classList.add("offline");
            }
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

        if (intId) {
            clearInterval(intId);
        }

        intId = null;
    }

    return {
        start,
        stop,
        refresh
    };
}