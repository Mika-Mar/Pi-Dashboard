// static/js/system.js
import {jget} from "./api.js";

export function initSystem({
                               cpuEl,
                               ramEl,
                               tempEl,
                               diskEl = document.getElementById("disk"),
                               uptimeEl = document.getElementById("uptime"),
                               internetEl = document.getElementById("internet"),
                               pollMs = 6000
                           }) {
    let intId = null;
    let visible = false;

    const setCPU = (v) => {
        if (Number.isFinite(v) && cpuEl) {
            cpuEl.textContent = Math.round(v) + "%";
        }
    };

    const setRAM = (v) => {
        if (Number.isFinite(v) && ramEl) {
            ramEl.textContent = Math.round(v) + "%";
        }
    };

    const setTEMP = (v) => {
        if (tempEl) {
            tempEl.textContent =
                (Number.isFinite(v) ? v.toFixed(1) : "—") + "°C";
        }
    };

    const setDISK = (v) => {
        if (Number.isFinite(v) && diskEl) {
            diskEl.textContent = Math.round(v) + "%";
        }
    };

    const setUPTIME = (seconds) => {
        if (!uptimeEl || !Number.isFinite(seconds)) return;

        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (days > 0) {
            uptimeEl.textContent = `${days}d ${hours}h`;
        } else if (hours > 0) {
            uptimeEl.textContent = `${hours}h ${minutes}m`;
        } else {
            uptimeEl.textContent = `${minutes}m`;
        }
    };
     const internetDotEl = document.getElementById("internetDot");
    const setINTERNET = (online) => {
        if (!internetEl) return;

        internetEl.textContent = online ? "ONLINE" : "OFFLINE";

        if (internetDotEl) {
            internetDotEl.classList.toggle("online", online);
            internetDotEl.classList.toggle("offline", !online);
        }
    };

    async function refresh() {
        try {
            if (!visible) return;

            const s = await jget("/api/system");

            setCPU(s.cpu_pct);
            setRAM(s.ram_pct);
            setTEMP(s.temp_c);
            setDISK(s.disk_pct);
            setUPTIME(s.uptime_seconds);
            setINTERNET(s.internet_online);

        } catch (e) {
            console.warn("[system] failed", e);

            if (internetEl) {
                internetEl.textContent = "● UNKNOWN";
                internetEl.dataset.online = "unknown";
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

    return {start, stop, refresh};
}

