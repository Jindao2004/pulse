'use strict';

(function initPulseTheme() {
  const DEFAULT_ACCENT = '#0078D4';

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function parseHex(raw) {
    let value = String(raw || '')
      .trim()
      .replace(/^#/, '');
    if (value.length === 8) value = value.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(value)) value = DEFAULT_ACCENT.slice(1);
    return {
      r: Number.parseInt(value.slice(0, 2), 16),
      g: Number.parseInt(value.slice(2, 4), 16),
      b: Number.parseInt(value.slice(4, 6), 16),
    };
  }

  function rgbToHsl({ r, g, b }) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    let h = 0;

    if (delta !== 0) {
      if (max === red) h = ((green - blue) / delta) % 6;
      else if (max === green) h = (blue - red) / delta + 2;
      else h = (red - green) / delta + 4;
      h *= 60;
      if (h < 0) h += 360;
    }

    const l = (max + min) / 2;
    const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
    return { h, s: s * 100, l: l * 100 };
  }

  function hslToHex(h, s, l) {
    const hue = ((h % 360) + 360) % 360;
    const sat = clamp(s, 0, 100) / 100;
    const light = clamp(l, 0, 100) / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = light - c / 2;
    let red = 0;
    let green = 0;
    let blue = 0;

    if (hue < 60) [red, green, blue] = [c, x, 0];
    else if (hue < 120) [red, green, blue] = [x, c, 0];
    else if (hue < 180) [red, green, blue] = [0, c, x];
    else if (hue < 240) [red, green, blue] = [0, x, c];
    else if (hue < 300) [red, green, blue] = [x, 0, c];
    else [red, green, blue] = [c, 0, x];

    const toHex = (v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0');
    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
  }

  function toRgba(hex, alpha) {
    const { r, g, b } = parseHex(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function luminance(hex) {
    const { r, g, b } = parseHex(hex);
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function apply(theme) {
    const root = document.documentElement;
    const parsed = parseHex(theme?.accent);
    const accent = `#${parsed.r.toString(16).padStart(2, '0')}${parsed.g
      .toString(16)
      .padStart(2, '0')}${parsed.b.toString(16).padStart(2, '0')}`;
    const rgb = parsed;
    const hsl = rgbToHsl(rgb);
    const dark = theme?.dark !== false;
    const saturation = clamp(hsl.s, 45, 100);
    const accentLight = hslToHex(hsl.h, saturation, dark ? 68 : 44);
    const accentDeep = hslToHex(hsl.h, saturation, dark ? 38 : 34);
    const accentContrast = luminance(accentLight) > 0.56 ? '#06171a' : '#f7ffff';
    const bg1 = hslToHex(hsl.h, clamp(hsl.s * 0.46, 18, 44), 24);
    const bg2 = hslToHex(hsl.h, clamp(hsl.s * 0.36, 14, 32), 19);
    const bg3 = hslToHex((hsl.h + 12) % 360, clamp(hsl.s * 0.32, 12, 28), 14);
    const glowHue = (hsl.h + 18) % 360;

    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-light', accentLight);
    root.style.setProperty('--accent-deep', accentDeep);
    root.style.setProperty('--accent-contrast', accentContrast);
    root.style.setProperty('--accent-rgb', `${rgb.r} ${rgb.g} ${rgb.b}`);
    root.style.setProperty('--accent-soft', toRgba(accent, 0.14));
    root.style.setProperty('--accent-glow', toRgba(accent, 0.3));
    root.style.setProperty('--bg-1', bg1);
    root.style.setProperty('--bg-2', bg2);
    root.style.setProperty('--bg-3', bg3);
    root.style.setProperty('--bg-glow-1', toRgba(accent, 0.23));
    root.style.setProperty('--bg-glow-2', toRgba(hslToHex(glowHue, saturation, 42), 0.14));
    root.dataset.systemDark = String(dark);
    root.dataset.themeAccent = accent;
  }

  window.PulseTheme = { apply };
})();
