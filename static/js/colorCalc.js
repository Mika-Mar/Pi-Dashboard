

// Schnell & simpel: dominante/Ø-Farbe (Downsampling + Histogramm)
export function dominantFromImage(img){
  const w = 64, h = Math.max(1, Math.round((img.naturalHeight/img.naturalWidth)*64));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Quantisierung auf 32er Stufen für "dominant"
  const bins = new Map();
  let rSum=0,gSum=0,bSum=0,count=0;

  for (let i=0;i<data.length;i+=4){
    const a = data[i+3];
    if (a < 128) continue; // transparente Pixel ignorieren
    const r = data[i], g = data[i+1], b = data[i+2];
    rSum += r; gSum += g; bSum += b; count++;

    const key = `${r>>3}-${g>>3}-${b>>3}`; // 5 Bit pro Kanal
    bins.set(key, (bins.get(key)||0)+1);
  }

  if (!count) return { rgb:[34,197,94] }; // fallback

  // häufigstes Bin = dominante Farbe (Mittel innerhalb des Bins reicht hier)
  let maxKey=null, max=0;
  for (const [k,v] of bins) if (v>max){ max=v; maxKey=k; }
  let dom = [rSum/count, gSum/count, bSum/count]; // fallback: Ø-Farbe
  if (maxKey){
    const parts = maxKey.split('-').map(x=>parseInt(x,10));
    dom = parts.map(p => Math.min(255, (p<<3) + 4)); // zurück auf 0..255, kleine Mitte
  }

  return { rgb: dom.map(x=>Math.round(x)) };
}

export function boostColor([r,g,b], {sat=1, light=1}={}){
  let [h,s,l] = rgbToHsl(r,g,b);
  s = Math.min(1, s*sat);
  l = Math.min(1, l*light);
  const [rr,gg,bb] = hslToRgb(h,s,l);
  return [rr,gg,bb];
}

function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h,s,l = (max+min)/2;
  if(max===min){ h=0; s=0; }
  else{
    const d = max-min;
    s = l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h = (g-b)/d + (g<b?6:0); break;
      case g: h = (b-r)/d + 2; break;
      case b: h = (r-g)/d + 4; break;
    }
    h/=6;
  }
  return [h,s,l];
}
function hslToRgb(h,s,l){
  if(s===0){
    const v = Math.round(l*255);
    return [v,v,v];
  }
  const hue2rgb = (p,q,t)=>{
    if(t<0) t+=1;
    if(t>1) t-=1;
    if(t<1/6) return p + (q-p)*6*t;
    if(t<1/2) return q;
    if(t<2/3) return p + (q-p)*(2/3 - t)*6;
    return p;
  };
  const q = l < .5 ? l*(1+s) : l + s - l*s;
  const p = 2*l - q;
  const r = hue2rgb(p,q,h+1/3);
  const g = hue2rgb(p,q,h);
  const b = hue2rgb(p,q,h-1/3);
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }