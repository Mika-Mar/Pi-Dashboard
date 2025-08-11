

export function applyAccent([r,g,b], scope = document.documentElement) {
  const accent = `rgb(${r} ${g} ${b})`;
  scope.style.setProperty("--accent", accent);
  scope.style.setProperty("--accent-10", `rgba(${r} ${g} ${b} / 0.10)`);
  scope.style.setProperty("--accent-20", `rgba(${r} ${g} ${b} / 0.20)`);
  scope.style.setProperty("--accent-60", `rgba(${r} ${g} ${b} / 0.60)`);

  // Kontrastfarbe (Y/Luminanz)
  const srgb = c => { c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  const lum = 0.2126*srgb(r) + 0.7152*srgb(g) + 0.0722*srgb(b);
  const on = lum > 0.45 ? "rgb(20 20 20)" : "rgb(255 255 255)";
  scope.style.setProperty("--on-accent", on);
}
