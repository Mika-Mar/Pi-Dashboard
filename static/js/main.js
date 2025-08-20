

import { initSystem } from "./system.js";
import { initSwipe} from "./gestures.js";
import {initPlayer} from "./player.js";
//hier später noch die anderen

document.addEventListener("DOMContentLoaded", ()=> {
    // DOM-Refs einsammeln (nur ids, kein query-Chaos)
    const el = (id) => document.getElementById(id);

    //Uhr oben in Leiste:
    const clock = el("clock");
    const pad = (n) => String(n).padStart(2, "0");
    const tick = () => {
        const d = new Date();
        clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    tick();
    setInterval(tick, 1000);



    // Swipe-Carousel zum Wechseln der Dashboards
    const dots = Array.from(document.querySelectorAll("#pager .dot"));
    const carousel = initSwipe({
        wrapEl: el("dashWrap"),
        dots,
    });

    //spotify player:
    const player = initPlayer({
        coverEl: el("cover"),
        dotsEl: el("pager"),
        bgEl: el("bgOverlay"),     // optional
        titleEl: el("titleText"),
        artistEl: el("artistText"),
        albumEl: el("albumText"),
        progressWrapEl: el("progress"),      // äußerer Balken
        progressBarEl: el("progressFill"),           // gefüllter Balken
        timeNowEl: el("timeNow"),
        timeTotalEl: el("timeTotal"),
        btnPlayEl: el("btnPlay"),
        btnPrevEl: el("btnPrev"),
        btnNextEl: el("btnNext"),
        eqTopEl : el("eq-top"),
        eqTextEl : el("eq-text"),
        pollMs: 1000,
    });
    //Debug: window.Player = player;

    // System-Kachel (CPU/RAM/Temperatur)
    initSystem({
        cpuEl: el("cpu"),
        ramEl: el("ram"),
        tempEl: el("temp"),
        containerEl: el("sysDash"),
        pollMs: 6000,
    });


    // hier weitere Module einfügen:


    // aufräumen bei verstecken der Seiten:
    document.addEventListener("visibilitychange", () => {
        if(document.hidden) {

        }else{

        }
    })
})
