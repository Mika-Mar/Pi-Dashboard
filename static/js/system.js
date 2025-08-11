

import { jget } from "./api.js";

export function initSystem({ cpuEl, ramEl, tempEl}){
    async function refresh(){
        try {
            const s = await jget("/api/system");
            cpuEl.textContent = s.cpu_pct.toFixed(0) + "%";
            ramEl.textContent = s.ram_pct.toFixed(0) + "%";
            tempEl.textContent = s.temp_c != null ? s.temp_c.toFixed(1) + "°C" : "-";
        }catch(e){
            console.warn("system refresh failed", e);
        }
    }
    refresh();
    return setInterval(refresh, 6000);
}