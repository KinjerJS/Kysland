'use strict';
// Liquid Glass (theme "glass", option "glass"): the island's glass (island.js, Glass) and Kys's
// (option "kys-skin": Lens, here and in the settings window). The kinds of glass, the bend of its
// rim, its displacement maps and its SVG filter.
window.GlassKit = (() => {
  const GLASS_PAD = 24; // the island's .notch-glass reaches this far past it (notch.css); the maps too

  // Option "glass": how much it looks like a real piece of glass. Frosted: well blurred, a thin
  // bent rim. Crystal: nearly clear, a thick bulging rim (the whole height of the resting capsule)
  // that bends what's behind it strongly and splits its colors like a prism (blue bends more than
  // red), a band of reflection along the edge (Fresnel), a sheen on its dome, brighter rims.
  // blur: px; bezel: share of the smaller side, and its most (px); thick: glass height / bezel;
  // dispersion: extra bend of green, then blue; dim: tint over dark → light backgrounds.
  const GLASS_LEVELS = {
    frosted: { blur: 7, bezel: [0.42, 28], thick: 0.9, dispersion: 0, saturate: 1.6, rim: 1, fresnel: 0, sheen: 0, dim: [0.2, 0.42] },
    balanced: { blur: 3.5, bezel: [0.46, 36], thick: 1.25, dispersion: 0.035, saturate: 1.7, rim: 1.3, fresnel: 0.1, sheen: 0.035, dim: [0.24, 0.42] },
    crystal: { blur: 1.2, bezel: [0.5, 46], thick: 1.7, dispersion: 0.07, saturate: 1.8, rim: 1.6, fresnel: 0.2, sheen: 0.07, dim: [0.28, 0.44] },
  };

  /** Sideways shift of the view through the bezel, from its edge (0) to where the glass is flat (1),
   *  for a bezel B px wide and a glass `thick` times as high. */
  function bezelShift(B, thick) {
    const T = B * thick, base = B * 0.35, n = 1.5;
    return Float32Array.from({ length: 128 }, (_, i) => {
      const u = 1 - Math.max(0.015, i / 127);
      const height = Math.pow(1 - u ** 4, 0.25);
      const slope = (T / B) * u ** 3 * Math.pow(1 - u ** 4, -0.75);
      const tilt = Math.atan(slope), refracted = Math.asin(Math.sin(tilt) / n);
      return (base + T * height) * Math.tan(tilt - refracted);
    });
  }

  /** The bezel's width (px): the rim of glass that bends what's behind it. */
  const glassBezel = (w, h, L) => Math.max(4, Math.min(L.bezel[1], Math.min(w, h) * L.bezel[0]));

  /** Displacement map (R, G: x, y shift around 128), one pixel per `res` px (2 for the island;
   *  1 for Kys, small: Lens), for an island of w×h with corner radii [tl, tr, br, bl], covering the glass layer (GLASS_PAD around it). `attached`:
   *  'top' / 'bottom' / 'left' / 'right' when that side is the screen edge (no bezel there). `L`:
   *  the level (GLASS_LEVELS). `make(w, h)`: a canvas that size. Self-contained (but for GLASS_PAD,
   *  bezelShift and glassBezel): it also runs in a worker (GLASS_WORKER). The light on its rim is
   *  drawn by CSS (notch.css), so it follows the island at any size. */
  function glassMaps(w, h, radii, attached, L, make, res = 2) {
    const P = GLASS_PAD, W = w + 2 * P, H = h + 2 * P;
    const B = glassBezel(w, h, L);
    const shifts = bezelShift(B, L.thick);
    const max = Math.max(...shifts);
    const top = attached === 'top' ? -1e4 : 0, bottom = attached === 'bottom' ? h + 1e4 : h;
    const left = attached === 'left' ? -1e4 : 0, right = attached === 'right' ? w + 1e4 : w;
    const cx = (left + right) / 2, cy = (top + bottom) / 2, hw = (right - left) / 2, hh = (bottom - top) / 2;
    // Signed distance to the edge (< 0 inside) and the outward normal.
    const g = { d: 0, nx: 0, ny: 0 };
    const at = (x, y) => {
      const px = x - cx, py = y - cy, sx = px < 0 ? -1 : 1, sy = py < 0 ? -1 : 1;
      const r = px < 0 ? (py < 0 ? radii[0] : radii[3]) : (py < 0 ? radii[1] : radii[2]);
      const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
      if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy); g.d = l - r; g.nx = (sx * qx) / l; g.ny = (sy * qy) / l; }
      else if (qx > qy) { g.d = qx - r; g.nx = sx; g.ny = 0; }
      else { g.d = qy - r; g.nx = 0; g.ny = sy; }
    };
    const dw = Math.ceil(W / res), dh = Math.ceil(H / res);
    const c = make(dw, dh), ctx = c.getContext('2d'), img = ctx.createImageData(dw, dh);
    for (let j = 0, k = 0; j < dh; j++) {
      for (let i = 0; i < dw; i++, k += 4) {
        at((i + 0.5) * res - P, (j + 0.5) * res - P);
        let vx = 0, vy = 0;
        if (g.d < 0 && -g.d < B) {
          const s = shifts[Math.round((-g.d / B) * 127)] / max;
          vx = -g.nx * s; vy = -g.ny * s; // looks further in
        }
        img.data.set([128 + vx * 127, 128 + vy * 127, 128, 255], k);
      }
    }
    ctx.putImageData(img, 0, 0);
    return { disp: c, scale: 2 * max };
  }

  /** The glass filter for a level (#kys-glass: the island's; others: Kys's, Lens): blur, then the
   *  bend (once per color when the glass splits them), then saturation. Its map: #<id>-map; its
   *  bends: #<id>-r, -g, -b. */
  function glassFilter(L, id = 'kys-glass') {
    const bend = (c, result) => `<feDisplacementMap id="${id}-${c}" in="blur" in2="map" scale="0" xChannelSelector="R" yChannelSelector="G" result="${result}"/>`;
    // Keeps one color channel (and the alpha).
    const only = (c) => [0, 1, 2, 3].map((row) => [0, 1, 2, 3, 4].map((col) => (row === col && (row === c || row === 3) ? 1 : 0)).join(' ')).join('  ');
    return '<svg width="0" height="0" style="position:absolute" aria-hidden="true">'
      + `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">`
      + `<feGaussianBlur in="SourceGraphic" stdDeviation="${L.blur}" result="blur"/>`
      + `<feImage id="${id}-map" x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map"/>`
      + (L.dispersion
        ? bend('r', 'r0') + bend('g', 'g0') + bend('b', 'b0')
          + `<feColorMatrix in="r0" values="${only(0)}" result="r"/><feColorMatrix in="g0" values="${only(1)}" result="g"/>`
          + `<feColorMatrix in="b0" values="${only(2)}" result="b"/>`
          + '<feBlend in="r" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b" mode="screen" result="bent"/>'
        : bend('r', 'bent'))
      + `<feColorMatrix in="bent" type="saturate" values="${L.saturate}"/></filter></svg>`;
  }

  /**
   * Kys's body of glass bending what's behind it like the island does (options "kys-skin" and
   * "glass"): its backdrop through a filter of the island's kind (backdrop-filter), with maps drawn
   * for its size. `attach(el)`: a body to bend behind; all of a Lens's bodies have the same size
   * (one filter). Until its maps are ready, a body keeps its CSS (blurred, not bent).
   */
  class Lens {
    constructor(id, level) {
      this.id = id;
      this.L = GLASS_LEVELS[level] || GLASS_LEVELS.frosted;
      document.body.insertAdjacentHTML('beforeend', glassFilter(this.L, id));
      this.map = document.getElementById(`${id}-map`);
      this.bends = ['r', 'g', 'b'].map((c) => document.getElementById(`${id}-${c}`)).filter(Boolean);
      this.els = new Set();
      this.size = '';
      this.ready = false;
    }

    attach(el, tries = 20) {
      for (const e of this.els) if (!e.isConnected) this.els.delete(e);
      this.els.add(el);
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (!w || !h) { if (tries) requestAnimationFrame(() => el.isConnected && this.attach(el, tries - 1)); return; } // not laid out yet
      const size = `${w}x${h}`;
      if (size === this.size) { if (this.ready) this.bend(el); return; }
      this.size = size;
      this.ready = false;
      const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2);
      const m = glassMaps(w, h, [r, r, r, r], null, this.L, (cw, ch) => Object.assign(document.createElement('canvas'), { width: cw, height: ch }), 1);
      m.disp.toBlob(async (blob) => {
        const url = URL.createObjectURL(blob), img = new Image();
        img.src = url;
        await img.decode().catch(() => {}); // a map not decoded yet: the filter would draw nothing
        if (this.size !== size) return URL.revokeObjectURL(url);
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = url;
        // The maps reach GLASS_PAD past the body, as the island's do.
        const at = { x: -GLASS_PAD, y: -GLASS_PAD, width: w + 2 * GLASS_PAD, height: h + 2 * GLASS_PAD, href: url };
        for (const [k, v] of Object.entries(at)) this.map.setAttribute(k, v);
        this.bends.forEach((b, i) => b.setAttribute('scale', (m.scale * (1 + i * this.L.dispersion)).toFixed(1)));
        this.ready = true;
        this.els.forEach((e) => this.bend(e));
      });
    }

    bend(el) { el.style.backdropFilter = `url(#${this.id})`; }

    /** A body that stops being of glass. */
    detach(el) {
      this.els.delete(el);
      el.style.backdropFilter = '';
    }
  }

  return { GLASS_PAD, GLASS_LEVELS, bezelShift, glassBezel, glassMaps, glassFilter, Lens };
})();
