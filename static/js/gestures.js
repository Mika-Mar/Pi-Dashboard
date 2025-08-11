

export function initSwipe({wrapEl, dots}){
    const slides = Array.from(wrapEl.children);
    let idx = 0, start = 0, vX = 0, lastX = 0, lastT = 0, drag = false;
    const w=()=>wrapEl.clientWidth, THRESH = 0.18, MAXV=2;
    const setX=(px,a)=>{
        wrapEl.classList.toggle("swipe-anim", !!a);
        wrapEl.style.transform=`translate3d(${px}px,0,0`;
    }

    const snap=(i,a=true)=>{
        idx=Math.max(0,Math.min(i,slides.length-1));
        setX(-idx*w(),a);
        dots?.forEach((d,j)=>d.classList.toggle("active", j===idx))
    }

    wrapEl.addEventListener("touchstart", e=>{
        if(e.touches.length!==1) return;
        drag=true;
        wrapEl.classList.remove("swipe-anim");
        start=lastX=e.touches[0].clientX;
        lastT=performance.now();
        vX=0;
    },{passive:true});

    wrapEl.addEventListener("touchmove", e=>{
        if(!drag) return;
        const cur=e.touches[0].clientX;
        const dx = cur-start;
        const atS=idx===0 && dx>0;
        const atE=idx===slides.length-1 && dx<0;
        setX(-idx*w()+dx*(atS||atE?0.35:1), false);

        const t = performance.now();
        const dt =  Math.max(1,t-lastT);
        vX = ((cur-lastX) / dt) * 16
        lastX = cur;
        lastT = t;
    },{passive:true});

    wrapEl.addEventListener("touchend",()=>{
        if(!drag) return;
        drag = false;
        const curX = parseFloat(wrapEl.style.transform.split("(")[1]) || 0;
        const dx = curX + idx * w();
        const far = Math.abs(dx) > w()*THRESH;
        const fast = Math.abs(vX)>MAXV;
        if(far || fast) snap(dx<0?idx+1:idx-1);
        else snap(idx);
    });

    window.addEventListener("resize",()=>snap(idx,false));
    dots?.forEach((d,i)=>d.addEventListener("click",()=>snap(i)));
    snap(0,false);
    return{ next:()=>snap(idx+1), prev:()=>snap(idx-1), go:i=>snap(i)};
}