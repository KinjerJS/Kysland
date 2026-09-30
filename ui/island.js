'use strict';
// "Dynamic Island" notch stuck to the screen edge: time + date at rest, expands on hover
// (music, system), stretches briefly for events.
(() => {
  const { t } = window.i18n;
  const icon = (n) => `<i class="icon icon-${n}"></i>`;
  const eq = (playing) => `<span class="eq${playing ? '' : ' paused'}" data-morph="eq"><i></i><i></i><i></i><i></i></span>`;
  const appName = (app = '') => app.split('!').pop().replace(/\.exe$/i, '');

  function fmtDuration(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  function cover(m, size) {
    return m?.thumb
      ? `<img class="n-cover ${size}" src="${m.thumb}" data-morph="cover">`
      : `<span class="n-cover ${size} placeholder" data-morph="cover">${icon('music')}</span>`;
  }

  // Dominant (saturated) color of the album art → tint of the equalizer and the progress bar.
  function tintFrom(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, 24, 24);
        const px = g.getImageData(0, 0, 24, 24).data;
        let r = 0, gr = 0, b = 0, wsum = 0;
        for (let i = 0; i < px.length; i += 4) {
          const R = px[i] / 255, G = px[i + 1] / 255, B = px[i + 2] / 255;
          const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
          if (l < 0.12 || l > 0.92) continue;
          const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
          const w = s * s + 0.02;
          r += px[i] * w; gr += px[i + 1] * w; b += px[i + 2] * w; wsum += w;
        }
        if (!wsum) return resolve(null);
        const [h, s] = rgbToHsl(r / wsum, gr / wsum, b / wsum);
        resolve(`hsl(${Math.round(h)} ${Math.round(Math.max(s, 0.55) * 100)}% 66%)`);
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }

  // --- Morphing engine ---------------------------------------------------------------
  class Notch {
    constructor() {
      this.el = document.createElement('div');
      this.el.className = 'notch';
      this.inner = document.createElement('div');
      this.inner.className = 'notch-inner';
      this.el.appendChild(this.inner);
      document.body.appendChild(this.el);
      // Layer for elements "in flight" during transitions (outside the notch, which clips its content).
      this.flyLayer = document.createElement('div');
      this.flyLayer.className = 'notch-fly';
      document.body.appendChild(this.flyLayer);
      this.flights = [];
      this.current = null;
      this.key = null;
    }

    // view: { key, size, html, mount(el), update(el) }
    show(view) {
      if (view.key === this.key && this.current) {
        view.update?.(this.current);
      } else {
        this.finishFlights();
        const old = this.current;
        // Start positions of the shared elements, before the old view fades out.
        const from = new Map();
        old?.querySelectorAll('[data-morph]').forEach((el) => from.set(el.dataset.morph, el));
        const fromRects = new Map([...from].map(([k, el]) => [k, el.getBoundingClientRect()]));

        const next = document.createElement('div');
        next.className = 'notch-view';
        next.innerHTML = view.html;
        const pairs = [...next.querySelectorAll('[data-morph]')]
          .filter((el) => from.has(el.dataset.morph))
          .map((el) => [from.get(el.dataset.morph), el]);
        // With shared elements, no zoom effect on the views: exact positions.
        if (pairs.length) { next.classList.add('morphing'); old.classList.add('morphing'); }
        this.inner.appendChild(next);
        view.mount?.(next);
        view.update?.(next);
        if (old) {
          old.classList.remove('shown');
          old.classList.add('leaving');
          setTimeout(() => old.remove(), 320);
        }
        this.current = next;
        this.key = view.key;
        for (const [a, b] of pairs) this.fly(a, fromRects.get(a.dataset.morph), b);
        requestAnimationFrame(() => next.classList.add('shown'));
      }
      this.el.dataset.size = view.size;
      this.resize();
    }

    // Shared-element transition: a copy of the old element and one of the new one travel
    // together while cross-fading; the originals stay hidden during the flight.
    fly(oldEl, from, newEl) {
      const to = newEl.getBoundingClientRect();
      if (!from.width || !to.width) return;
      this.flyLayer.style.setProperty('--tint', getComputedStyle(this.el).getPropertyValue('--tint'));
      const clone = (el, r) => {
        const c = el.cloneNode(true);
        c.removeAttribute('data-morph');
        Object.assign(c.style, {
          position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
          margin: '0', transformOrigin: '0 0', boxSizing: 'border-box', visibility: 'visible',
        });
        this.flyLayer.appendChild(c);
        return c;
      };
      const a = clone(oldEl, from);
      const b = clone(newEl, to);
      oldEl.style.visibility = 'hidden';
      newEl.style.visibility = 'hidden';
      const dx = from.left - to.left, dy = from.top - to.top;
      const s = from.height / to.height; // uniform scale: text isn't distorted
      const timing = { duration: 520, easing: 'cubic-bezier(.3, 1.2, .5, 1)', fill: 'both' };
      const anims = [
        b.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }, { transform: 'none' }], timing),
        a.animate([{ transform: 'none' }, { transform: `translate(${-dx}px, ${-dy}px) scale(${1 / s})` }], timing),
        b.animate([{ opacity: 0 }, { opacity: 1, offset: 0.45 }, { opacity: 1 }], { duration: 520, fill: 'both' }),
        a.animate([{ opacity: 1 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }], { duration: 520, fill: 'both' }),
      ];
      const flight = { anims, done: () => { a.remove(); b.remove(); newEl.style.visibility = ''; } };
      this.flights.push(flight);
      anims[0].finished.then(() => {
        flight.done();
        this.flights = this.flights.filter((x) => x !== flight);
      }).catch(() => {});
    }

    // New transition before the previous one ended: finish the old one instantly.
    finishFlights() {
      for (const f of this.flights) { f.anims.forEach((an) => an.cancel()); f.done(); }
      this.flights = [];
    }

    resize() {
      if (!this.current) return;
      this.el.style.width = `${this.current.offsetWidth + (this.extra || 0)}px`; // extra: room for peeking eyes
      this.el.style.height = `${this.current.offsetHeight}px`;
    }
  }

  // --- Eyes of the hidden island ----------------------------------------------------------
  // While the island hides from a slow cursor, two small eyes in what's left of it keep watch:
  // quick glances at the cursor, a blink now and then, a look elsewhere before checking back.
  // If the cursor stays close long enough, the island grows tall and the eyes come alive: they
  // look around as if wondering where they are, circle, sneak up next to the cursor a few hops at
  // a time (never right under it), stare at it, doze off when nothing happens (Zzz; a slow cursor
  // doesn't wake them, a click does), jump away when it gets too close, and show moods with their
  // brows. The grown island catches the mouse, so it can be clicked (poked).
  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, max) => Math.max(-max, Math.min(max, v));

  class Eyes {
    constructor(notch) {
      this.el = document.createElement('div');
      this.el.className = 'notch-eyes';
      this.el.innerHTML = '<span class="eye l"><b></b><i></i></span><span class="eye r"><b></b><i></i></span><span class="mouth"></span>'
        + '<div class="stars"><span>✦</span><span>✧</span><span>✦</span></div>' // circle while dizzy
        + '<span class="hat"></span><span class="ask">🍪</span>'; // Kys's accessory; asking for food
      this.stars = this.el.querySelector('.stars');
      notch.appendChild(this.el);
      this.notch = notch;
      // Thrown out of the grown island, these same eyes fly in a drop of island: they move to a
      // flyer above everything, and the drop is drawn in a gooey layer below the island, next to a
      // copy of the island's shape, so it stretches out of the island and merges back into it.
      this.flyer = document.createElement('div');
      this.flyer.className = 'eye-flyer';
      this.goo = document.createElement('div');
      this.goo.className = 'eye-goo';
      this.goo.innerHTML = '<div class="goo-island"></div><div class="goo-drop"></div>';
      document.body.append(this.goo, this.flyer);
      [this.gooIsland, this.gooDrop] = this.goo.children;
      if (!document.getElementById('kysland-goo')) {
        document.body.insertAdjacentHTML('beforeend', '<svg width="0" height="0" style="position:absolute" aria-hidden="true">'
          + '<filter id="kysland-goo"><feGaussianBlur in="SourceGraphic" stdDeviation="6"/>'
          + '<feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8"/></filter></svg>');
      }
      this.flight = null;
      this.cursor = null;
      this.cursorAt = 0; // last time the cursor moved
      this.trail = []; // recent cursor positions, to tell a slow sneak from a real move
      this.pokes = [];
      this.elsewhere = false;
      this.roaming = false;
    }

    /** `roamAfter`: seconds before the eyes start roaming (0: never). */
    start(roamAfter = 0) {
      this.stop();
      this.openT = setTimeout(() => this.el.classList.add('opened'), 700); // don't open again when coming back in
      if (roamAfter > 0) this.roamT = setTimeout(() => this.roam(), roamAfter * 1000);
      const blink = () => {
        if (!this.asleep() && !this.eating()) {
          this.el.classList.add('blink');
          setTimeout(() => this.el.classList.remove('blink'), 110);
        }
        this.blinkT = setTimeout(blink, rand(2200, 5000));
      };
      const glance = () => {
        if (this.asleep()) {
          this.glanceT = setTimeout(glance, rand(3000, 7000));
          return;
        }
        const c = this.center();
        this.elsewhere = true;
        this.aim(c.x + (Math.random() < 0.5 ? -1 : 1) * rand(30, 70), c.y + rand(-10, 30));
        this.backT = setTimeout(() => {
          this.elsewhere = false;
          if (this.cursor && !this.roaming) this.aim(this.cursor.x, this.cursor.y);
        }, rand(260, 480));
        this.glanceT = setTimeout(glance, rand(3000, 7000));
      };
      this.blinkT = setTimeout(blink, rand(1200, 3000));
      this.glanceT = setTimeout(glance, rand(2500, 5000));
    }

    stop() {
      for (const timer of [this.blinkT, this.glanceT, this.backT, this.roamT, this.growT, this.moodT, this.shakeT, this.openT]) clearTimeout(timer);
      cancelAnimationFrame(this.raf);
      cancelAnimationFrame(this.wobbleRaf);
      this.dizzyUntil = 0;
      this.spin = 0;
      this.spinAngle = null;
      this.setMove(null);
      this.flight = null;
      if (this.el.parentElement !== this.notch) this.notch.appendChild(this.el); // was flying
      this.goo.classList.remove('on');
      this.el.classList.remove('shake', 'opened', 'dizzy');
      this.elsewhere = false;
      this.roaming = false;
      this.notch.classList.remove('roaming');
      this.setMood('neutral');
      this.el.style.setProperty('--ex', '0px');
      this.el.style.setProperty('--ey', '0px');
    }

    asleep() { return this.move?.kind === 'doze'; }

    eating() { return performance.now() < (this.eatingUntil || 0); }

    /**
     * Shows a mood (brows, lids); back to neutral after `ms`, or on to `then` = [mood, ms]. While it
     * eats, it stays happy: the last mood asked for waits until it's done.
     */
    setMood(mood, ms = 0, then = null) {
      if (this.eating()) {
        this.afterMeal = [mood, ms, then];
        return;
      }
      clearTimeout(this.moodT);
      if (mood === 'neutral' && this.sad) mood = 'sad'; // Kys starving or miserable
      this.el.dataset.mood = mood;
      if (ms) this.moodT = setTimeout(() => (then ? this.setMood(...then) : this.setMood('neutral')), ms);
    }

    /** Kys's state (kys.rs): what it wears, whether it's hungry or down. */
    setKys(k) {
      this.el.dataset.wear = k.wearing || '';
      this.el.classList.toggle('hungry', k.food < 30);
      const sad = k.food < 10 || k.joy < 15;
      if (sad === this.sad) return;
      this.sad = sad;
      if (['neutral', 'sad'].includes(this.el.dataset.mood)) this.setMood('neutral');
    }

    /** Eating: a few chomps, then happy. */
    munch() {
      mouthChew(this.el, false);
      this.eatingUntil = 0;
      this.setMood('happy');
      this.eatingUntil = performance.now() + MEAL;
      this.afterMeal = ['happy', 900]; // a bit more, unless something else came up meanwhile
      clearTimeout(this.mealT);
      this.mealT = setTimeout(() => {
        this.eatingUntil = 0;
        this.setMood(...this.afterMeal);
      }, MEAL);
    }

    look(x, y) {
      const now = performance.now();
      if (!this.cursor || Math.hypot(x - this.cursor.x, y - this.cursor.y) > 1) this.cursorAt = now;
      this.cursor = { x, y };
      this.trail.push({ t: now, x, y });
      while (this.trail.length && now - this.trail[0].t > 400) this.trail.shift();
      if (!this.flight) this.spinCheck(x, y, now);
      // While roaming, the animation loop decides where to look; dizzy, the eyes roll.
      if (!this.elsewhere && !this.busy && !this.roaming && !this.isDizzy(now)) this.aim(x, y); // busy: watching the ball
    }

    // --- Dizzy: the cursor circling around the eyes -------------------------------------------
    /** Sums how far the cursor turns around the eyes, fading over ~1.6 s: about a turn per second
     *  for two seconds makes them dizzy. Too close (on them) or too far doesn't count. */
    spinCheck(x, y, now) {
      const c = this.center();
      const dx = x - c.x, dy = y - c.y, r = Math.hypot(dx, dy);
      const dt = this.spinAt ? (now - this.spinAt) / 1000 : 0;
      this.spinAt = now;
      this.spin = (this.spin || 0) * Math.exp(-dt / 1.6);
      if (r < 16 || r > 260) { this.spinAngle = null; return; }
      const a = Math.atan2(dy, dx);
      if (this.spinAngle != null) {
        let d = a - this.spinAngle;
        if (d > Math.PI) d -= 2 * Math.PI;
        else if (d < -Math.PI) d += 2 * Math.PI;
        this.spin += d;
      }
      this.spinAngle = a;
      if (Math.abs(this.spin) > 8) this.dizzy(now);
    }

    isDizzy(now) { return now < (this.dizzyUntil || 0); }

    dizzy(now) {
      const already = this.isDizzy(now);
      this.dizzyUntil = now + 2200; // as long as the circling goes on
      if (already) return;
      api.kys.earn('dizzy');
      this.spinDir = Math.sign(this.spin) || 1;
      this.setMood('dizzy');
      this.el.classList.add('dizzy');
      if (this.roaming) {
        // Sways on the spot (the loop rolls the eyes).
        const base = { ...this.pos };
        this.setMove({ kind: 'dizzy', pull: 3, until: Infinity, target: (t) => ({ x: base.x + Math.sin(t / 260) * 8, y: base.y + Math.sin(t / 370) * 4 }) });
        return;
      }
      const step = (t) => {
        if (this.roaming || !this.dizzyUntil) return; // the roaming loop took over, or stopped
        if (!this.isDizzy(t)) return this.recover();
        this.roll(t);
        this.wobbleRaf = requestAnimationFrame(step);
      };
      this.wobbleRaf = requestAnimationFrame(step);
    }

    /** Rolling eyes, turning the way the cursor went round. */
    roll(t) {
      const [gx, gy] = this.roaming ? [5, 4] : [3, 1.5];
      const a = (t / 90) * this.spinDir;
      this.el.style.setProperty('--gx', `${(Math.cos(a) * gx).toFixed(2)}px`);
      this.el.style.setProperty('--gy', `${(Math.sin(a) * gy).toFixed(2)}px`);
      // Stars circling: below the thin strip (above it is the screen edge), above the eyes on the
      // grown island, or below them when they're up against the edge.
      const [rx, ry] = this.roaming ? [30, 7] : [34, 5];
      const cy = !this.roaming ? 13 : this.pos.y < -20 ? 26 : -26;
      [...this.stars.children].forEach((star, i) => {
        const b = (t / 240) * this.spinDir + (i * 2 * Math.PI) / 3;
        const depth = (Math.sin(b) + 1) / 2; // 1: in front, 0: behind
        star.style.setProperty('--sx', `${(Math.cos(b) * rx).toFixed(1)}px`);
        star.style.setProperty('--sy', `${(cy + Math.sin(b) * ry).toFixed(1)}px`);
        star.style.setProperty('--ss', (0.6 + depth * 0.5).toFixed(2));
        star.style.setProperty('--so', (0.45 + depth * 0.55).toFixed(2));
      });
    }

    /** The circling stopped: eyes shut, shaking its head, a bit cross. */
    recover() {
      this.dizzyUntil = 0;
      this.el.classList.remove('dizzy');
      this.spin = 0;
      if (this.move?.kind === 'dizzy') this.setMove(null);
      this.el.classList.remove('shake');
      void this.el.offsetWidth;
      this.el.classList.add('shake');
      clearTimeout(this.shakeT);
      this.shakeT = setTimeout(() => this.el.classList.remove('shake'), 950);
      this.setMood('dazed', 900, ['grumpy', 1400]);
    }

    center() {
      const r = this.el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    aim(x, y) {
      const c = this.center();
      const dx = x - c.x, dy = y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, len / 40); // a close cursor doesn't pull the eyes all the way
      const gx = (dx / len) * k, gy = (dy / len) * k;
      const [rx, ry] = this.roaming ? [6, 5] : [4, 2]; // bigger eyes, more room
      const s = this.el.style;
      s.setProperty('--gx', `${(gx * rx).toFixed(2)}px`);
      s.setProperty('--gy', `${(gy * ry).toFixed(2)}px`);
      // The eye on the far side looks a bit smaller, as if the head turned.
      s.setProperty('--sl', (1 - Math.max(0, gx) * 0.18).toFixed(3));
      s.setProperty('--sr', (1 + Math.min(0, gx) * 0.18).toFixed(3));
    }

    // --- Roaming: positions are offsets from the island's center, in CSS pixels. ---
    roam() {
      this.roaming = true;
      this.notch.classList.add('roaming');
      this.pos = { x: 0, y: 0 };
      this.move = null;
      this.fledAt = 0;
      this.setMood('surprised', 900, ['curious', 1600]); // "oh? where am I?"
      let last = 0;
      const tick = (now) => {
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
        last = now;
        const r = this.notch.getBoundingClientRect();
        const mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const box = { x: Math.max(0, r.width / 2 - 30), y: Math.max(0, r.height / 2 - 20) }; // room for the pair
        const c = this.cursor && { x: this.cursor.x - mid.x, y: this.cursor.y - mid.y };
        const fresh = now - this.cursorAt < 400;
        this.lastBox = box;
        this.lastC = c;
        if (this.flight) {
          this.fly(now, dt, r, mid, box);
          this.raf = requestAnimationFrame(tick);
          return;
        }
        const asleep = this.move?.kind === 'doze';
        // Cursor right on the eyes: they jump away (not too often, and not in their sleep). Too close
        // to the edge in that direction, the jump throws them out of the island.
        if (this.dizzyUntil && !this.isDizzy(now)) this.recover();
        const dizzy = this.isDizzy(now);
        if (c && fresh && !asleep && !dizzy && now - this.fledAt > 1800 && Math.hypot(c.x - this.pos.x, c.y - this.pos.y) < 28) {
          this.fledAt = now;
          const len = Math.hypot(this.pos.x - c.x, this.pos.y - c.y) || 1;
          const dir = { x: (this.pos.x - c.x) / len, y: (this.pos.y - c.y) / len };
          const reach = { x: this.pos.x + dir.x * box.x, y: this.pos.y + dir.y * box.y };
          const out = Math.abs(reach.x) > box.x * 1.25 || reach.y > box.y * 1.25; // not upward: that's the screen edge
          if (out && now - (this.ejectedAt || 0) > 6000) this.eject(now, dir);
          else this.setMove(this.flee(now, c, box));
        }
        if (this.flight) {
          this.raf = requestAnimationFrame(tick);
          return;
        }
        // Asleep, a cursor sneaking right up to it (10 to 20 px from the eyes): the eye on that side
        // opens a crack, and watches it.
        const side = asleep && c && Math.hypot(Math.max(0, Math.abs(c.x - this.pos.x) - 20), Math.max(0, Math.abs(c.y - this.pos.y) - 9)) < 18
          ? (c.x < this.pos.x ? 'l' : 'r') : null;
        this.el.classList.toggle('peek-l', side === 'l');
        this.el.classList.toggle('peek-r', side === 'r');
        this.cracked = side;
        // Woken up by a real move (sneaking up slowly doesn't wake them).
        if (asleep && this.travel() > 45) {
          this.setMood('surprised', 700, ['grumpy', 1400]);
          this.setMove(null);
        }
        if (!this.move || now > this.move.until) this.setMove(this.nextMove(now, c, box));
        const target = this.move.target(now, c, box);
        const k = 1 - Math.exp(-dt * this.move.pull); // eased chase of the target
        this.pos.x = clamp(this.pos.x + (target.x - this.pos.x) * k, box.x);
        this.pos.y = clamp(this.pos.y + (target.y - this.pos.y) * k, box.y);
        const breath = Math.sin(now / 700) * 1.2;
        this.el.style.setProperty('--ex', `${this.pos.x.toFixed(1)}px`);
        this.el.style.setProperty('--ey', `${(this.pos.y + breath).toFixed(1)}px`);
        if (dizzy) {
          this.roll(now);
        } else if (!this.elsewhere && !this.busy) {
          const spot = this.move.look?.(now); // somewhere else than the cursor
          if (spot) this.aim(mid.x + spot.x, mid.y + spot.y);
          else if (this.cursor) this.aim(this.cursor.x, this.cursor.y);
        }
        this.raf = requestAnimationFrame(tick);
      };
      this.growT = setTimeout(() => { this.raf = requestAnimationFrame(tick); }, 450); // once the island has grown
    }

    /** Replaces the current behavior (letting the old one clean up). */
    setMove(move) {
      this.move?.end?.();
      this.move = move;
    }

    /** Distance the cursor covered in the last 400 ms. */
    travel() {
      let d = 0;
      for (let i = 1; i < this.trail.length; i++) d += Math.hypot(this.trail[i].x - this.trail[i - 1].x, this.trail[i].y - this.trail[i - 1].y);
      return d;
    }

    /** A click on the grown island. */
    poke() {
      if (!this.roaming || this.flight) return;
      const now = performance.now();
      this.jolt();
      api.kys.earn('poke');
      if (this.move?.kind === 'doze') {
        // Woken up by a click: jumps away, startled or cross (this mood replaces the flee's own).
        this.setMove(this.lastC ? this.flee(now, this.lastC, this.lastBox) : null);
        if (Math.random() < 0.5) this.setMood('grumpy', 2800);
        else this.setMood('surprised', 900, ['grumpy', 1800]);
        return;
      }
      this.pokes = this.pokes.filter((t) => now - t < 2500).concat(now);
      if (this.pokes.length >= 3) this.setMood('grumpy', 2200); // enough!
      else this.setMood('surprised', 450, ['happy', 1600]);
    }

    jolt() {
      this.el.classList.remove('jolt');
      void this.el.offsetWidth; // restart the animation
      this.el.classList.add('jolt');
    }

    // Thrown out of the island: a drop of island flying off, then pulled back like by a gravity well.
    // It circles around the island through the bottom (the top is the screen edge), a little closer
    // as it goes, spinning, then gets sucked back in on the other side. Screen positions, CSS px.
    eject(now, dir) {
      const r = this.notch.getBoundingClientRect();
      const mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const from = this.center();
      let a0 = Math.atan2(from.y - mid.y + dir.y * 40, from.x - mid.x + dir.x * 40);
      let end;
      if (Math.cos(a0) >= 0) {
        end = Math.PI + rand(0, 0.35); // out on the right: around the bottom to the left
      } else {
        if (a0 < 0) a0 += 2 * Math.PI;
        end = -rand(0, 0.35); // out on the left: around the bottom to the right
      }
      this.flight = { from, p: from, a0, sweep: end - a0, orbit: rand(1.8, 2.4), since: now, spin: 0, spinDir: Math.sign(end - a0) || 1 };
      // Same eyes, same spot: they only change container.
      this.place(from, 0);
      this.shapeIsland(r);
      this.flyer.appendChild(this.el);
      this.goo.classList.add('on');
      this.splash();
      this.setMood('surprised');
    }

    /**
     * The eyes at a screen position, turned by `spin` degrees, and their drop there too, stretched
     * along its motion (`angle`, `stretch`) and jiggling (`jiggle`) like water.
     */
    place(p, spin, angle = 0, stretch = 0, jiggle = 0) {
      const x = `${p.x.toFixed(1)}px`, y = `${p.y.toFixed(1)}px`;
      const f = this.flyer.style, d = this.gooDrop.style;
      f.setProperty('--fx', x);
      f.setProperty('--fy', y);
      f.setProperty('--fspin', `${spin.toFixed(1)}deg`);
      d.setProperty('--fx', x);
      d.setProperty('--fy', y);
      d.setProperty('--dangle', `${angle.toFixed(1)}deg`);
      d.setProperty('--dsx', ((1 + stretch) * (1 + jiggle)).toFixed(3));
      d.setProperty('--dsy', ((1 - jiggle) / (1 + stretch)).toFixed(3));
    }

    /** A ripple through the island (a drop leaving or coming back). */
    splash() {
      this.notch.classList.remove('splash');
      void this.notch.offsetWidth; // restart the animation
      this.notch.classList.add('splash');
    }

    /** The copy of the island the drop merges with. */
    shapeIsland(r) {
      Object.assign(this.gooIsland.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }

    fly(now, dt, r, mid, box) {
      const f = this.flight;
      const t = (now - f.since) / 1000;
      const OUT = 0.45, BACK = 0.5;
      const ellipse = (a, k) => ({ x: mid.x + Math.cos(a) * (r.width / 2 + 46) * k, y: mid.y + Math.sin(a) * (r.height / 2 + 40) * k });
      let p, spin;
      if (t < OUT) {
        // Thrown out, slowing down.
        const u = 1 - (1 - t / OUT) ** 3;
        const to = ellipse(f.a0, 1.25);
        p = { x: f.from.x + (to.x - f.from.x) * u, y: f.from.y + (to.y - f.from.y) * u };
      } else if (t < OUT + f.orbit) {
        // Pulled around the island, a little closer as it goes.
        const u = (t - OUT) / f.orbit;
        const ease = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
        p = ellipse(f.a0 + f.sweep * ease, 1.25 - 0.3 * u + Math.sin(u * Math.PI * 3) * 0.05);
      } else {
        // Sucked back in, straightening up on the way.
        const u = Math.min(1, (t - OUT - f.orbit) / BACK);
        f.spinFrom ??= f.spin;
        f.spinTo ??= Math.round(f.spin / 360) * 360;
        spin = f.spinFrom + (f.spinTo - f.spinFrom) * (1 - (1 - u) ** 2);
        const a = f.a0 + f.sweep;
        const start = ellipse(a, 0.95);
        const spot = { x: mid.x + Math.cos(a) * box.x * 0.6, y: mid.y + Math.sin(a) * box.y * 0.6 };
        p = { x: start.x + (spot.x - start.x) * u * u, y: start.y + (spot.y - start.y) * u * u };
        if (u >= 1) {
          f.p = p;
          this.place(p, 0);
          return this.land(now, mid, box);
        }
      }
      if (spin === undefined) {
        f.spin += dt * (900 - Math.min(1, t / (OUT + f.orbit)) * 650) * f.spinDir; // deg/s, slowing down
        spin = f.spin;
      }
      p.y = Math.max(22, p.y);
      // Like water: stretched along its motion, jiggling after it tears off and as it merges back.
      const vx = dt ? (p.x - f.p.x) / dt : 0, vy = dt ? (p.y - f.p.y) / dt : 0;
      const stretch = Math.min(0.4, Math.hypot(vx, vy) / 1500);
      const settle = Math.max(0, 1 - t / 0.9) + Math.max(0, 1 - (OUT + f.orbit + BACK - t) / 0.35);
      const jiggle = Math.sin(t * 24) * 0.08 * Math.min(1, settle);
      f.p = p;
      this.place(p, spin, (Math.atan2(vy, vx) * 180) / Math.PI, stretch, jiggle);
      this.shapeIsland(r);
      // Rolling eyes: completely lost.
      const e = this.el.style;
      e.setProperty('--gx', `${(Math.cos(now / 70) * 3).toFixed(2)}px`);
      e.setProperty('--gy', `${(Math.sin(now / 70) * 2.5).toFixed(2)}px`);
      if (t > 0.7 && this.el.dataset.mood === 'surprised') this.setMood('worried');
    }

    // Back in: blinks and frowns, squinting to see where it is, then curious again.
    land(now, mid, box) {
      const p = this.flight.p;
      this.flight = null;
      this.ejectedAt = now;
      // Back into the island at the very same spot (upright by now, breathing as the loop does).
      this.pos = { x: clamp(p.x - mid.x, box.x), y: clamp(p.y - mid.y, box.y) };
      this.el.style.setProperty('--ex', `${this.pos.x.toFixed(1)}px`);
      this.el.style.setProperty('--ey', `${(this.pos.y + Math.sin(now / 700) * 1.2).toFixed(1)}px`);
      this.notch.appendChild(this.el);
      this.goo.classList.remove('on');
      this.splash();
      api.kys.earn('flight');
      this.setMood('squint', 1600, ['curious', 1000]);
      for (const at of [180, 520]) {
        setTimeout(() => {
          this.el.classList.add('blink');
          setTimeout(() => this.el.classList.remove('blink'), 110);
        }, at);
      }
      const still = { ...this.pos };
      this.setMove({ kind: 'squint', pull: 3, until: now + 2600, target: () => still }); // stays put, peering at the cursor
    }

    nextMove(now, c, box) {
      if (c && now - this.cursorAt > 9000) return this.doze(now);
      const roll = Math.random();
      if (c && roll < 0.35) return this.approach(now, c, box);
      if (roll < 0.6) return this.explore(now, box);
      if (roll < 0.78) return this.circle(now, box);
      return this.watch(now);
    }

    // Sneaks up next to the cursor (beside it, never right under it), a few hops at a time.
    approach(now, c, box) {
      let side = Math.sign(this.pos.x - c.x) || pick([-1, 1]);
      let spot = { ...this.pos }, hops = 0, hopAt = now;
      const total = Math.round(rand(2, 4));
      this.setMood(pick(['curious', 'neutral', 'suspicious']));
      return {
        kind: 'approach', pull: 8, until: now + total * 650 + rand(1400, 2600),
        target: (t, cur) => {
          if (cur && hops < total && t >= hopAt) {
            let gx = clamp(cur.x + side * rand(36, 50), box.x);
            if (Math.abs(gx - cur.x) < 26) { side = -side; gx = clamp(cur.x + side * rand(36, 50), box.x); } // no room there
            const gy = clamp(cur.y + rand(-12, 6), box.y);
            const step = hops === total - 1 ? 1 : rand(0.35, 0.55);
            spot = { x: spot.x + (gx - spot.x) * step, y: spot.y + (gy - spot.y) * step };
            hops++;
            hopAt = t + rand(420, 850);
            if (hops === total) this.setMood(pick(['happy', 'curious', 'suspicious']), 2200);
          }
          return spot;
        },
      };
    }

    // Goes somewhere, then looks left, right and up, as if wondering where it is.
    explore(now, box) {
      const spot = { x: rand(-box.x, box.x), y: rand(-box.y, box.y) };
      const arrive = now + rand(600, 900);
      const around = [{ x: spot.x - 90, y: spot.y + rand(-20, 20) }, { x: spot.x + 90, y: spot.y + rand(-20, 20) }, { x: spot.x, y: spot.y - 70 }];
      if (Math.random() < 0.3) this.setMood(pick(['curious', 'worried']), 2400);
      return {
        kind: 'explore', pull: 6, until: now + rand(2200, 3600),
        target: () => spot,
        look: (t) => (t < arrive ? null : around[Math.floor((t - arrive) / 550) % around.length]),
      };
    }

    // One or more turns along an ellipse filling the island.
    circle(now, box) {
      const f = rand(0.55, 1);
      const speed = rand(2.2, 3.6) * pick([-1, 1]); // rad/s
      const start = Math.atan2(this.pos.y / (box.y || 1), this.pos.x / (box.x || 1));
      if (Math.random() < 0.3) this.setMood('happy', 2000);
      return {
        kind: 'circle', pull: 7, until: now + rand(2600, 4800),
        target: (t) => {
          const a = start + (speed * (t - now)) / 1000;
          return { x: Math.cos(a) * box.x * f, y: Math.sin(a) * box.y * f };
        },
      };
    }

    // Stays put and stares at the cursor, leaning toward it a little.
    watch(now) {
      const base = { ...this.pos };
      this.setMood(pick(['suspicious', 'neutral', 'curious']), 2200);
      return {
        kind: 'watch', pull: 4, until: now + rand(1600, 3000),
        target: (t, cur) => (cur ? { x: base.x + clamp((cur.x - base.x) * 0.08, 6), y: base.y + clamp((cur.y - base.y) * 0.08, 4) } : base),
      };
    }

    // Nothing happening: heavy eyelids, a slow drift down, Zzz floating up (until a real move).
    doze(now) {
      this.setMood('sleepy');
      let n = 0;
      const snore = () => {
        const z = document.createElement('span');
        z.className = 'zzz';
        z.textContent = ['z', 'Z', 'z'][n % 3];
        z.style.setProperty('--zs', ['10px', '13px', '11px'][n++ % 3]);
        z.style.setProperty('--zx', `${rand(12, 28).toFixed(0)}px`);
        z.addEventListener('animationend', () => z.remove());
        this.el.appendChild(z);
      };
      snore();
      const timer = setInterval(snore, 850);
      return {
        kind: 'doze', pull: 1.2, until: now + 60000,
        target: (t, cur, box) => ({ x: 0, y: box.y * 0.5 }),
        look: () => (this.cracked ? null : { x: this.pos.x, y: this.pos.y + 60 }), // eyes down (one on the cursor, cracked)
        end: () => {
          clearInterval(timer);
          this.el.querySelectorAll('.zzz').forEach((z) => z.remove());
          this.el.classList.remove('peek-l', 'peek-r');
          this.cracked = null;
        },
      };
    }

    // Jumps to the other side, startled, then sulks a little.
    flee(now, c, box) {
      const away = {
        x: clamp(this.pos.x + (Math.sign(this.pos.x - c.x) || pick([-1, 1])) * box.x, box.x),
        y: clamp(this.pos.y + (Math.sign(this.pos.y - c.y) || 1) * box.y * 0.6, box.y),
      };
      this.setMood('surprised', 600, ['grumpy', 1800]);
      return { kind: 'flee', pull: 14, until: now + 1100, target: () => away };
    }
  }

  // --- Module ----------------------------------------------------------------------------
  TYPES.island = {
    topics: ['media', 'audio', 'battery', 'network', 'cpu', 'memory', 'notification', 'claude'],
    defaults: {
      'time-format': 'HH:mm',
      'date-format': 'ddd D MMM',
      'date-long-format': 'dddd D MMMM',
      'expand-on-hover': true,
      'hover-delay': 120,
      'collapse-delay': 350,
      'media-linger': 15, // seconds shown after a pause
      'scroll-step': 5,
      outline: 'auto',               // 'auto' (on dark backgrounds) | true | false
      dodge: true,                   // hides when the cursor approaches slowly (read by the engine)
      'dodge-eyes': true,            // two little eyes watch the cursor while it's hidden
      'dodge-roam': true,            // ...and roam around a grown island if the cursor stays close
      'dodge-roam-delay': 20,        // seconds
      'auto-hide': false,            // hides while the mouse is far away or on another screen (read by the engine)
      peek: true,                    // now and then, the eyes squeeze into the resting island to check on the cursor
      'auto-hide-distance': 300,     // px around the island where it comes back
      notifications: true,           // Windows notifications in the island
      claude: false,                 // Claude plan usage (if Claude Code is installed)
      'kys-brain': 'simple',         // what Kys understands: "simple" (rules), "light" or "smart" (a local model, brain.rs)
      'notification-duration': 6,    // seconds
      transients: { volume: true, media: true, battery: true, network: true, workspace: true },
    },

    init(m) {
      m.el.remove(); // the island lives outside the bar, stuck to the edge
      if (m.conf.monitor === 'primary' && !state.monitor.primary) return;
      const S = (m.island = {
        notch: new Notch(), eyes: null, expanded: false, transient: null, transientTimer: 0,
        data: { ...state.data }, pausedAt: 0, tint: null, tintKey: null, workspace: null, dragging: false,
        queue: [], notif: null, notifTimer: 0, claudeOn: m.conf.claude === true, unread: 0, page: 'main', history: null,
      });
      const notch = S.notch.el;
      // Whether the cursor is over the island (the engine reports the exits the page misses).
      notch.addEventListener('mouseenter', () => { S.hover = true; });
      notch.addEventListener('mouseleave', () => { S.hover = false; });
      S.eyes = new Eyes(notch);
      notch.classList.toggle('eyes', m.conf['dodge-eyes'] !== false);
      S.near = state.near !== false;
      applyOutline(m, state.backdropDark);
      api.kys.state().then((k) => onKysState(m, k));
      schedulePeek(m, 15, 40);
      let enterT = 0, leaveT = 0;
      if (m.conf['expand-on-hover']) {
        notch.addEventListener('mouseenter', () => {
          if (S.dodged || S.peeking) return; // grown hidden island, or Kys peeking (to be caught): no expanding
          clearTimeout(leaveT);
          if (S.notif) return clearTimeout(S.notifTimer); // reading the notification: pause
          enterT = setTimeout(() => setExpanded(m, true), m.conf['hover-delay']);
        });
        notch.addEventListener('mouseleave', () => {
          S.dragging = false; // a drag can't go on without the mouse
          if (S.dodged || S.typing || S.kysDragging) return; // typing to Kys, giving it something: stays open
          clearTimeout(enterT);
          if (S.notif) return startNotifTimer(m, 2500);
          leaveT = setTimeout(() => setExpanded(m, false), m.conf['collapse-delay']);
        });
      }
      notch.addEventListener('click', (e) => {
        if (S.dodged) return S.eyes.poke();
        if (S.peeking && nearEyes(S, e)) return catchKys(m);
        if (S.notif) {
          // Click: opens the app (and removes the notification); ✕: just closes.
          if (!e.target.closest('.n-close')) openNotif(S.notif.data);
          return showNextNotif(m);
        }
        // Click on the date (compact notch): straight to the calendar.
        if (e.target.closest('.n-date')) return openCalendar(m);
        if (!S.expanded && !e.target.closest('button, input')) setExpanded(m, true);
      });
      notch.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (S.notif) { S.queue = []; return showNextNotif(m); } // right click: clear all
        setExpanded(m, false);
        api.action('menu');
      });
      notch.addEventListener('wheel', (e) => {
        if (S.dodged || e.target.closest('input, .n-history, .n-kys-body')) return; // lists scroll, not the volume
        api.action('audio', e.deltaY < 0 ? 'up' : 'down', m.conf['scroll-step']);
      }, { passive: true });
      setInterval(() => render(m), 500);
      if (S.data.media?.thumb) updateTint(m, S.data.media);
      render(m);
    },

    onData(m, topic, data) {
      const S = m.island;
      if (!S) return;
      if (topic === 'claude') stopClaudeSpin(S);
      if (topic === 'notification') {
        if (m.conf.notifications === false) return;
        S.unread++;
        S.queue.push(data);
        if (!S.notif && !S.expanded && !S.dodged) showNextNotif(m); // hidden: shown when it comes back
        return;
      }
      const prev = S.data[topic];
      S.data[topic] = data;
      const t = m.conf.transients || {};
      if (topic === 'audio' && prev && t.volume && (prev.volume !== data.volume || prev.muted !== data.muted)) {
        pushTransient(m, volumeView(data), 1600);
      } else if (topic === 'media') {
        if (prev?.playing && !data.playing) S.pausedAt = Date.now();
        if (data.thumb && data.key !== S.tintKey) updateTint(m, data);
        if (t.media && data.has && data.playing && prev?.has && prev.key !== data.key) pushTransient(m, trackView(data), 3200);
      } else if (topic === 'battery' && prev && t.battery && data.present && prev.plugged !== data.plugged) {
        pushTransient(m, batteryView(data), 2600);
      } else if (topic === 'claude' && S.claudeOn && prev?.ok && data.ok && data.session && prev.session) {
        const was = prev.session.percent, now = data.session.percent;
        if (was < 100 && now >= 100) pushTransient(m, claudeAlertView(data, true), 5000);
        else if (was < 80 && now >= 80) pushTransient(m, claudeAlertView(data, false), 4000);
      } else if (topic === 'network' && prev && t.network && prev.connected !== data.connected) {
        pushTransient(m, networkView(data), 2600);
      }
      render(m);
    },

    onGlaze(m, g) {
      const S = m.island;
      if (!S || !g.connected || !(m.conf.transients || {}).workspace) return;
      const ws = myGlazeMonitor()?.workspaces.find((w) => w.focused);
      if (!ws) return;
      if (S.workspace && S.workspace !== ws.name) pushTransient(m, workspaceView(ws), 1300);
      S.workspace = ws.name;
    },

    onBackdrop(m, dark) {
      if (m.island) applyOutline(m, dark);
    },

    onDodge(m, on) {
      const S = m.island;
      if (!S) return;
      if (on && S.peeking) endPeek(m);
      S.dodged = on;
      S.notch.el.classList.toggle('dodged', on);
      if (on && m.conf['dodge-eyes'] !== false) S.eyes.start(m.conf['dodge-roam'] !== false ? m.conf['dodge-roam-delay'] : 0);
      else S.eyes.stop();
      if (on) {
        // Hidden: the view stays as it is (see render), without an event in progress or elements
        // in flight, which would show up outside the hidden island.
        S.notch.finishFlights();
        clearTimeout(S.transientTimer);
        S.transient = null;
      } else if (!S.notif && S.queue.length) {
        showNextNotif(m); // notifications that arrived meanwhile
      } else {
        render(m);
      }
    },

    onPresence(m, near) {
      if (!m.island) return;
      m.island.near = near;
      applyAway(m);
    },

    onKys(m, { state, gain }) {
      if (!m.island) return;
      onKysState(m, state);
      if (gain) showGain(m, gain);
    },

    onKysFeed(m, { item }) {
      if (m.island) kysEat(m, item);
    },

    onKysPlay(m) {
      if (m.island) kysPlay(m);
    },

    onKysMood(m, { mood }) {
      if (m.island) kysFeel(m, mood);
    },

    onGaze(m, x, y) {
      const S = m.island;
      if (!S) return;
      if (S.peeking) watchPeek(m, x, y);
      S.eyes.look(x, y);
    },

    onMessage(m, msg) {
      if (!m.island) return;
      pushTransient(m, messageView(msg), 4500);
    },

    render() {},
    popup() { return null; },
  };

  // Thin outline so the black island stays visible over a black background.
  function applyOutline(m, dark) {
    const o = m.conf.outline;
    m.island.notch.el.classList.toggle('outlined', o === true || (o !== false && dark === true));
  }

  // Auto-hide: tucked away above the screen edge while the mouse is far, except to show something
  // (a notification, an event such as the volume), or while open or hiding from the cursor.
  function applyAway(m) {
    const S = m.island;
    const away = m.conf['auto-hide'] === true && !S.near && !S.expanded && !S.notif && !S.transient && !S.dodged;
    S.notch.el.classList.toggle('away', away);
  }

  /** The volume slider and its number back to the current volume. */
  function syncVolume(el, audio) {
    const input = el.querySelector('.n-vol input');
    if (!audio || !input) return;
    input.value = audio.volume;
    el.querySelector('.n-vol b').textContent = audio.volume;
  }

  function setExpanded(m, v) {
    const S = m.island;
    if (S.expanded === v) return;
    S.expanded = v;
    S.dragging = false;
    if (!v) { S.page = 'main'; stopTyping(m); }
    if (!v && !S.notif && S.queue.length) return showNextNotif(m); // notifications that arrived while expanded
    render(m);
  }

  // --- Notification queue: one at a time, takes priority over other events ---
  function showNextNotif(m) {
    const S = m.island;
    clearTimeout(S.notifTimer);
    const n = S.queue.shift();
    S.notif = n ? notificationView(n) : null;
    if (n) startNotifTimer(m, m.conf['notification-duration'] * 1000);
    render(m);
  }

  function startNotifTimer(m, ms) {
    const S = m.island;
    clearTimeout(S.notifTimer);
    // Notifications are waiting: go through them a bit faster.
    S.notifTimer = setTimeout(() => showNextNotif(m), S.queue.length ? Math.min(ms, 3500) : ms);
  }

  function pushTransient(m, view, ms) {
    const S = m.island;
    if (S.expanded || S.dodged) return; // the expanded view already shows everything; hidden: skipped
    S.transient = view;
    clearTimeout(S.transientTimer);
    S.transientTimer = setTimeout(() => { S.transient = null; render(m); }, ms);
    render(m);
  }

  async function updateTint(m, media) {
    const S = m.island;
    S.tintKey = media.key;
    const tint = await tintFrom(media.thumb);
    if (S.tintKey !== media.key) return;
    S.tint = tint;
    S.notch.el.style.setProperty('--tint', tint || 'var(--accent)');
  }

  function activeMedia(m) {
    const md = m.island.data.media;
    if (!md?.has) return null;
    if (md.playing) return md;
    return Date.now() - m.island.pausedAt < m.conf['media-linger'] * 1000 ? md : null;
  }

  function mediaPosition(md) {
    const pos = md.position + (md.playing ? (Date.now() - md.at) / 1000 : 0);
    return md.duration ? Math.min(pos, md.duration) : pos;
  }

  function render(m) {
    const S = m.island;
    if (!S || S.dodged) return; // hidden: nothing changes until it comes back
    applyAway(m);
    // Only a resting island hides from the cursor (not while open or showing a notification).
    updateDodgeable(S);
    if (S.peeking && (S.expanded || S.notif || S.transient)) endPeek(m);
    S.notch.show(S.expanded ? expandedView(m) : S.notif || S.transient || compactView(m));
    if (S.peeking) placePeekEyes(S); // the view may have changed width
  }

  // --- Peeking eyes -----------------------------------------------------------------------------
  // Now and then the eyes drop in from the top (the screen edge) right into the middle of the
  // resting island, landing on its content: the time and the date get knocked down and askew (a
  // little differently each time) and stay that way under them, while the island widens a touch.
  // They keep an eye on the cursor for a few seconds, then go back up and everything springs back.
  // Coming at them fast scares them off: they shoot back up and stay away for a while.
  const PEEK_ROOM = 12; // px the island widens by

  function schedulePeek(m, min = 25, max = 70) {
    const S = m.island;
    clearTimeout(S.peekT);
    if (m.conf.peek === false) return;
    const hurry = S.kys && S.kys.food < 30 ? 0.5 : 1; // hungry: comes asking more often
    S.peekT = setTimeout(() => startPeek(m), rand(min, max) * hurry * 1000);
  }

  /** `force`: to eat or play, even with peeking turned off. */
  function canPeek(m, S, force = false) {
    return (force || m.conf.peek !== false) && !S.expanded && !S.notif && !S.transient && !S.dodged && S.near !== false
      && !document.hidden && String(S.notch.key).startsWith('compact');
  }

  /** `opts`: `duration` (ms), `quiet` (no credit: not on its own), `force` (see canPeek). */
  function startPeek(m, opts = {}) {
    const S = m.island;
    if (m.conf.peek === false && !opts.force) return;
    if (S.peeking || !canPeek(m, S, opts.force)) return opts.force ? undefined : schedulePeek(m, 8, 20); // busy: a bit later
    S.peeking = { v: 0, last: null, x: peekSpot(S) };
    S.eyes.start(0);
    // How hard what's on either side gets knocked: sideways, down, askew.
    const n = S.notch.el.style;
    n.setProperty('--knock-l-x', `${-rand(6, 10).toFixed(1)}px`);
    n.setProperty('--knock-l-y', `${rand(3, 5).toFixed(1)}px`);
    n.setProperty('--knock-l-r', `${rand(8, 16).toFixed(1)}deg`); // inner ends down: a V
    n.setProperty('--knock-r-x', `${rand(6, 10).toFixed(1)}px`);
    n.setProperty('--knock-r-y', `${rand(3, 5).toFixed(1)}px`);
    n.setProperty('--knock-r-r', `${-rand(7, 14).toFixed(1)}deg`);
    // Above the island first (off the screen), right over the spot they land on...
    const eyes = S.eyes.el;
    eyes.style.transition = 'none';
    eyes.style.setProperty('--ex', `${S.peeking.x.toFixed(1)}px`);
    eyes.style.setProperty('--ey', '-36px');
    void eyes.offsetWidth;
    eyes.style.transition = '';
    // ...then down they drop, knocking the time and the date as the island widens a touch.
    S.notch.extra = PEEK_ROOM;
    S.notch.el.classList.add('peek');
    S.notch.resize();
    placePeekEyes(S);
    setTimeout(() => {
      S.notch.el.classList.remove('splash');
      void S.notch.el.offsetWidth;
      S.notch.el.classList.add('splash'); // the bump of the landing
    }, 140);
    S.peekEndT = setTimeout(() => endPeek(m), opts.duration ?? rand(3500, 7000));
    updateDodgeable(S);
    if (!opts.quiet) api.kys.earn('peek');
  }

  /** Middle of the gap between the time and the date, from the island's center (measured before
   *  they get knocked). */
  function peekSpot(S) {
    const view = S.notch.current;
    const time = view?.querySelector('.n-time'), date = view?.querySelector('.n-date');
    if (!time || !date) return 0;
    const n = S.notch.el.getBoundingClientRect();
    return (time.getBoundingClientRect().right + date.getBoundingClientRect().left) / 2 - (n.left + n.width / 2);
  }

  function placePeekEyes(S) {
    S.eyes.el.style.setProperty('--ex', `${S.peeking.x.toFixed(1)}px`);
    S.eyes.el.style.setProperty('--ey', '0px');
  }

  /** The cursor rushing at them (closing in fast, already close) scares them off. */
  function watchPeek(m, x, y) {
    const S = m.island, p = S.peeking;
    if (p.caught) return;
    const now = performance.now();
    const c = S.eyes.center();
    const d = Math.hypot(x - c.x, y - c.y);
    if (p.last) {
      const dt = Math.max(0.016, (now - p.last.t) / 1000);
      p.v = p.v * 0.4 + ((p.last.d - d) / dt) * 0.6; // closing speed, px/s
      if (d < 260 && p.v > 800) {
        S.eyes.setMood('surprised');
        S.eyes.jolt();
        return endPeek(m, true);
      }
    }
    p.last = { t: now, d };
  }

  function endPeek(m, scared = false) {
    const S = m.island, p = S.peeking;
    if (!p) return;
    S.peeking = null;
    clearTimeout(S.peekEndT);
    // Back up past the screen edge: calmly, or in a flash when scared. The time and the date
    // close the gap behind them.
    const eyes = S.eyes.el;
    eyes.classList.add(scared ? 'scared' : 'leaving');
    eyes.style.setProperty('--ey', scared ? '-46px' : '-36px');
    setTimeout(() => {
      S.notch.el.classList.remove('peek');
      S.notch.extra = 0;
      S.notch.resize();
      updateDodgeable(S);
    }, scared ? 60 : 160);
    setTimeout(() => {
      eyes.classList.remove('scared', 'leaving');
      if (!S.dodged) S.eyes.stop(); // hiding from the cursor took the eyes over meanwhile
      schedulePeek(m, scared ? 90 : 30, scared ? 180 : 80);
    }, scared ? 200 : 320);
  }

  /** Only a resting island hides from the cursor (not while open, showing a notification, or
   *  with Kys peeking: it can be approached slowly and caught). */
  function updateDodgeable(S) {
    S.notch.el.dataset.dodgeable = !S.expanded && !S.notif && !S.peeking ? '1' : '0';
  }

  // --- Kys, the eyes as a pet (kys.rs) -------------------------------------------------------------
  // Its state shows on the eyes (accessory, asking for food when hungry, sad when starving or
  // miserable); what happens to it earns credits (the engine keeps the count, capped per day),
  // floating away as "+N ✦"; fed or played with from the settings, it comes into the island for it.
  const FOOD = { cookie: '🍪', apple: '🍎', candy: '🍬', cake: '🍰' };

  function onKysState(m, k) {
    const S = m.island;
    S.kys = k;
    S.kysStamp = (S.kysStamp || 0) + 1;
    S.eyes.setKys(k);
    if (S.expanded && S.page === 'kys') render(m); // its page, open
  }

  function nearEyes(S, e) {
    const c = S.eyes.center();
    return Math.hypot(e.clientX - c.x, e.clientY - c.y) < 32;
  }

  /** Caught while peeking (approached slowly, eyes clicked): delighted, and a few credits. */
  function catchKys(m) {
    const S = m.island, p = S.peeking;
    if (p.caught) return;
    p.caught = true;
    clearTimeout(S.peekEndT);
    S.eyes.jolt();
    S.eyes.setMood('surprised', 400, ['happy', 1500]);
    floatAt(S.eyes.center(), '❤', 'heart');
    api.kys.earn('catch');
    S.peekEndT = setTimeout(() => endPeek(m), 1300);
  }

  /** A little something floating away from a point: "+2 ✦", a heart... */
  function floatAt(p, text, cls = '') {
    const el = document.createElement('div');
    el.className = `kys-float ${cls}`;
    el.textContent = text;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.addEventListener('animationend', () => el.remove());
    document.body.appendChild(el);
  }

  function showGain(m, gain) {
    const S = m.island;
    const out = S.peeking || S.dodged || S.eyes.flight;
    if (!out && gain.source === 'time') return; // quietly, when Kys isn't around
    const r = S.notch.el.getBoundingClientRect();
    const text = gain.amount ? `+${gain.amount} ✦` : t('kys.capped'); // 0: today's cap reached
    floatAt(out ? S.eyes.center() : { x: r.left + r.width / 2, y: r.bottom - 6 }, text, gain.amount ? 'gain' : 'gain capped');
  }

  /** Fed from the settings: the food drops onto Kys, who munches it (peeking in to eat if needed). */
  function kysEat(m, item) {
    const S = m.island;
    if (S.expanded && S.page === 'kys') return faceEat(m, item); // on its page, open
    const eat = () => {
      const c = S.eyes.center();
      mouthOpen(S.eyes.el, 1);
      const food = document.createElement('div');
      food.className = 'kys-food';
      food.textContent = FOOD[item] || '🍪';
      food.style.left = `${c.x}px`;
      food.style.top = `${c.y}px`;
      document.body.appendChild(food);
      setTimeout(() => {
        food.remove();
        S.eyes.munch();
        floatAt(c, '❤', 'heart');
      }, 480);
    };
    if (S.peeking) {
      clearTimeout(S.peekEndT);
      S.peekEndT = setTimeout(() => endPeek(m), 3500);
      return eat();
    }
    if (S.dodged) return eat();
    if (canPeek(m, S, true)) {
      startPeek(m, { duration: 3800, quiet: true, force: true });
      setTimeout(eat, 420);
    }
  }

  /**
   * What Kys felt while answering (brain.rs), on every Kys: the face of its page when it's open,
   * otherwise the island's own eyes, which drop in to show it (when it was talked to from the
   * settings).
   */
  function kysFeel(m, mood) {
    const S = m.island;
    const face = S.notch.current?.querySelector('.n-kys-face');
    if (face) return faceMood(face, mood, 4000);
    const feel = () => S.eyes.setMood(mood, 3400);
    if (S.peeking) {
      clearTimeout(S.peekEndT);
      S.peekEndT = setTimeout(() => endPeek(m), 3800);
      return feel();
    }
    if (S.dodged) return feel();
    if (!S.expanded && canPeek(m, S, true)) {
      startPeek(m, { duration: 4000, quiet: true, force: true });
      setTimeout(feel, 420);
    }
  }

  /** Playing ball (from the settings): a ball bouncing under the island, Kys following it. */
  function kysPlay(m) {
    const S = m.island;
    if (S.expanded && S.page === 'kys') return facePlay(m); // on its page, open
    const play = () => {
      const ball = document.createElement('div');
      ball.className = 'kys-ball';
      ball.textContent = '⚽';
      document.body.appendChild(ball);
      S.eyes.busy = true;
      S.eyes.setMood('happy');
      const t0 = performance.now(), duration = 3600;
      const step = (t) => {
        const u = (t - t0) / duration;
        if (u >= 1) {
          ball.remove();
          S.eyes.busy = false;
          S.eyes.setMood('happy', 1500);
          return;
        }
        const r = S.notch.el.getBoundingClientRect();
        const x = r.left + r.width / 2 + Math.sin(u * Math.PI * 4) * (r.width / 2 + 30);
        const y = r.bottom + 14 - Math.abs(Math.sin(u * Math.PI * 9)) * 12;
        ball.style.left = `${x}px`;
        ball.style.top = `${y}px`;
        ball.style.rotate = `${Math.round(u * 1080)}deg`;
        S.eyes.aim(x, y);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if (S.peeking) {
      clearTimeout(S.peekEndT);
      S.peekEndT = setTimeout(() => endPeek(m), 4200);
      return play();
    }
    if (S.dodged) return play();
    if (canPeek(m, S, true)) {
      startPeek(m, { duration: 4400, quiet: true, force: true });
      setTimeout(play, 400);
    }
  }

  // --- Kys page (expanded island) ------------------------------------------------------------------
  // The settings window's Kys tab, in the island: Kys's face (watching the cursor, eating and
  // playing right there), credits, belly and joy, inventory, shop and ways to earn, live.
  const KYS_ICON = { cookie: '🍪', apple: '🍎', candy: '🍬', cake: '🍰', ball: '⚽', bow: '🎀', cap: '🧢', glasses: '👓', crown: '👑' };

  function kysView(m) {
    const S = m.island;
    return {
      key: 'kys',
      size: 'expanded',
      html: `<div class="n-expanded n-kys-view">
        <div class="n-hist-head">
          <button class="n-back" title="${t('island.back')}">${icon('chevron-left')}</button>
          <span class="n-hist-title">Kys</span>
          <span class="n-kys-credits"></span>
        </div>
        <div class="k-msg"></div>
        <div class="n-kys-top">
          <div class="n-kys-face">${FACE_EYES}<span class="hat"></span><span class="ask">🍪</span></div>
          <div class="n-kys-gauges"></div>
        </div>
        <div class="k-say"></div>
        <form class="k-talk">
          <input type="text" maxlength="200" spellcheck="false" autocomplete="off" placeholder="${esc(t('kys.talk_placeholder'))}">
          <button type="submit" title="${esc(t('kys.send'))}">${icon('send-horizontal')}</button>
        </form>
        <div class="n-kys-body"></div>
      </div>`,
      mount(el) {
        el.querySelector('.n-back').onclick = () => { stopTyping(m); S.page = 'main'; render(m); };
        el.querySelector('.n-kys-body').onclick = (e) => kysPageClick(m, el, e);
        el.querySelector('.n-kys-body').addEventListener('pointerdown', (e) => kysDrag(m, el, e));
        el.addEventListener('mousemove', (e) => faceAim(el, e.clientX, e.clientY));
        faceBlink(el.querySelector('.n-kys-face'));
        mountTalk(m, el);
      },
      update(el) {
        const k = S.kys;
        if (!k || el.dataset.stamp === String(S.kysStamp) || S.kysDragging) return; // redrawn when Kys changes (not mid-drag)
        el.dataset.stamp = S.kysStamp;
        const hungry = k.food < 30, sad = k.food < 10 || k.joy < 15;
        el.querySelector('.n-kys-credits').textContent = `✦ ${k.credits}`;
        const face = el.querySelector('.n-kys-face');
        face.dataset.wear = k.wearing || '';
        face.classList.toggle('hungry', hungry);
        face.classList.toggle('sad', sad);
        if (!face.moodT) faceMood(face, 'neutral');
        const status = sad ? 'kys.status_sad' : hungry ? 'kys.status_hungry' : k.food > 60 && k.joy > 70 ? 'kys.status_great' : 'kys.status_ok';
        const bar = (label, value, cls) => `<div class="k-bar"><span>${esc(label)}</span>`
          + `<div class="track"><div class="fill ${cls}" style="width:${value}%"></div></div><b>${value}</b></div>`;
        el.querySelector('.n-kys-gauges').innerHTML = bar(t('kys.food'), k.food, 'food') + bar(t('kys.joy'), k.joy, 'joy')
          + `<div class="k-status${sad || hungry ? ' warn' : ''}">${esc(t(status))}</div>`;
        const body = el.querySelector('.n-kys-body');
        const scroll = body.scrollTop;
        body.innerHTML = kysPageBody(k);
        body.scrollTop = scroll;
        requestAnimationFrame(() => S.notch.resize());
      },
    };
  }

  function kysPageBody(k) {
    const name = (id) => esc(t(`kys.item.${id}`));
    // What it has, to drag onto it (kysDrag): food, the ball, things to wear.
    const tiles = [
      ...k.items.filter((i) => i.kind === 'food' && (k.inventory[i.id] || 0) > 0),
      ...k.items.filter((i) => i.kind !== 'food' && k.owned.includes(i.id)),
    ].map((i) => {
      const worn = k.wearing === i.id, tired = i.kind === 'toy' && !k.canPlay;
      const tip = worn ? t('kys.take_off_tip') : tired ? t('kys.tired') : t('kys.drag_tip');
      return `<div class="k-inv${worn ? ' worn' : ''}${tired ? ' tired' : ''}" data-kys-item="${i.id}" title="${name(i.id)} · ${esc(tip)}">`
        + `<span class="k-inv-icon">${KYS_ICON[i.id]}</span>${i.kind === 'food' ? `<em>×${k.inventory[i.id]}</em>` : ''}</div>`;
    }).join('');
    const inventory = tiles ? `<div class="k-hint">${esc(t('kys.drag_hint'))}</div><div class="k-inv-grid">${tiles}</div>`
      : `<div class="n-empty">${esc(t('kys.inventory_empty'))}</div>`;
    const shop = k.items.map((i) => {
      const have = i.kind !== 'food' && k.owned.includes(i.id);
      const effect = i.kind === 'toy' ? t('kys.effect_toy') : i.kind === 'wear' ? t('kys.effect_wear')
        : [i.food && t('kys.effect_food', { n: i.food }), i.joy && t('kys.effect_joy', { n: i.joy })].filter(Boolean).join(' · ');
      return `<button class="k-shop${have ? ' have' : ''}" data-kys-buy="${i.id}" ${have || k.credits < i.price ? 'disabled' : ''}`
        + ` title="${name(i.id)} · ${esc(effect)}"><span class="k-shop-icon">${KYS_ICON[i.id]}</span>`
        + `<span class="k-shop-price">${have ? '✓' : `✦ ${i.price}`}</span></button>`;
    }).join('');
    const earn = [...k.sources.map((s) => [t(`kys.source.${s.id}`), `+${s.credits}`, `${s.today}/${s.cap}`]), [t('kys.source.daily'), '+10', '']]
      .map(([label, plus, today]) => `<div class="k-earn"><span>${esc(label)}</span><b>${plus} ✦</b><em>${today}</em></div>`).join('');
    return `<div class="k-title">${esc(t('kys.inventory'))}</div>${inventory}`
      + `<div class="k-title">${esc(t('kys.shop'))}</div><div class="k-shop-grid">${shop}</div>`
      + `<div class="k-title">${esc(t('kys.earn'))}</div>${earn}`;
  }

  /** The shop's tiles; the engine answers with the new state (event "kys"). */
  function kysPageClick(m, el, e) {
    const b = e.target.closest('button[data-kys-buy]');
    if (!b || b.disabled) return;
    api.kys.buy(b.dataset.kysBuy).catch((err) => kysError(m, el, err));
  }

  /** What went wrong (not enough credits, Kys too tired to play...), for a moment. */
  function kysError(m, el, err) {
    const text = String(err);
    const msg = el.querySelector('.k-msg');
    if (!msg) return;
    msg.textContent = text.includes('credits') ? t('kys.poor') : text.includes('tired') ? t('kys.tired') : text;
    msg.classList.add('show');
    clearTimeout(m.island.kysMsgT);
    m.island.kysMsgT = setTimeout(() => { msg.classList.remove('show'); m.island.notch.resize(); }, 2500);
    m.island.notch.resize();
  }

  /**
   * Talking to Kys from its page (brain.rs). The island never takes the keyboard, except while
   * this input is in use: a click on it brings the island to the foreground, and leaving it
   * (Escape, a click elsewhere, the island closing) gives the keyboard back to the window that had it.
   */
  function mountTalk(m, el) {
    const S = m.island;
    const form = el.querySelector('.k-talk');
    const input = form.querySelector('input');
    if (S.kysSay) showSay(m, el, S.kysSay.text, S.kysSay.mood, false);
    input.addEventListener('pointerdown', () => {
      if (S.typing) return;
      S.typing = true;
      api.kys.typing(true).then(() => input.focus());
    });
    input.addEventListener('focus', () => {
      S.typing = true;
      api.kys.warm(); // the smart brain gets ready while you type
    });
    input.addEventListener('blur', () => {
      stopTyping(m);
      const out = () => !S.hover;
      if (out()) setTimeout(() => { if (!S.typing && out()) setExpanded(m, false); }, m.conf['collapse-delay']);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') input.blur(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || S.kysThinking) return;
      input.value = '';
      S.kysThinking = true;
      showSay(m, el, '', null, true);
      let reply = null;
      try { reply = await api.kys.talk(text); } catch { /* shown as no answer */ }
      S.kysThinking = false;
      // The island may have closed and reopened meanwhile: the answer goes to the page shown now.
      showSay(m, S.notch.current || el, reply?.say || '…', reply?.mood || 'curious', false);
    });
  }

  /** Kys's answer in a bubble next to its face, which takes the answer's mood for a moment. */
  function showSay(m, el, text, mood, thinking) {
    const S = m.island;
    if (!thinking) S.kysSay = { text, mood }; // still there when the page opens again
    const say = el.querySelector('.k-say');
    const face = el.querySelector('.n-kys-face');
    if (!say || !face) return;
    say.classList.toggle('thinking', thinking);
    say.innerHTML = thinking ? '<i></i><i></i><i></i>' : esc(text);
    say.classList.add('show');
    face.classList.toggle('think', thinking);
    faceMood(face, thinking ? 'curious' : mood, thinking ? 0 : 4000);
    requestAnimationFrame(() => S.notch.resize());
  }

  function stopTyping(m) {
    const S = m.island;
    if (!S.typing) return;
    S.typing = false;
    api.kys.typing(false);
  }

  /** The face's eyes follow the cursor over the page. */
  function faceAim(view, x, y) {
    const eyes = view.querySelector('.n-kys-face .notch-eyes');
    if (!eyes) return;
    const r = eyes.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy) || 1, k = Math.min(1, len / 80);
    eyes.style.setProperty('--gx', `${((dx / len) * k * 4).toFixed(2)}px`);
    eyes.style.setProperty('--gy', `${((dy / len) * k * 3).toFixed(2)}px`);
  }

  // The page's face has Kys's own eyes (the markup and the moods of the Eyes class: brows, lids).
  const FACE_EYES = '<div class="notch-eyes"><span class="eye l"><b></b><i></i></span><span class="eye r"><b></b><i></i></span>'
    + '<span class="mouth"></span></div>';

  /** A mood on the face, for a while (then back to its usual one: sad when it's miserable). While it
   *  eats, it stays happy: the last mood asked for waits until it's done. */
  function faceMood(face, mood, ms = 0) {
    const eyes = face.querySelector('.notch-eyes');
    if (!eyes) return;
    if (performance.now() < (face.eatingUntil || 0)) {
      face.afterMeal = [mood, ms];
      return;
    }
    clearTimeout(face.moodT);
    face.moodT = 0;
    eyes.dataset.mood = mood === 'neutral' && face.classList.contains('sad') ? 'sad' : mood;
    if (ms) face.moodT = setTimeout(() => { face.moodT = 0; faceMood(face, 'neutral'); }, ms);
  }

  /** The face blinks now and then, as long as it's on screen (not with its mouth full). */
  function faceBlink(face) {
    const eyes = face.querySelector('.notch-eyes');
    const blink = () => {
      if (!face.isConnected) return;
      if (performance.now() >= (face.eatingUntil || 0)) {
        eyes.classList.add('blink');
        setTimeout(() => eyes.classList.remove('blink'), 120);
      }
      setTimeout(blink, 2200 + Math.random() * 3300);
    };
    setTimeout(blink, 1500 + Math.random() * 1500);
  }

  /** Fed while its page is open: the food drops onto the face, a few chomps, a heart. */
  function faceEat(m, item) {
    const S = m.island;
    const face = S.notch.current?.querySelector('.n-kys-face');
    if (!face) return;
    const eyes = face.querySelector('.notch-eyes');
    const r = face.getBoundingClientRect();
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const chew = () => {
      mouthChew(eyes);
      face.eatingUntil = 0;
      faceMood(face, 'happy');
      face.eatingUntil = performance.now() + MEAL;
      face.afterMeal = ['happy', 900];
      setTimeout(() => {
        face.eatingUntil = 0;
        faceMood(face, ...face.afterMeal);
      }, MEAL);
      floatAt({ x: c.x + 30, y: c.y - 6 }, '❤', 'heart'); // beside the mouth, not over it
    };
    if (performance.now() - (S.handFedAt || 0) < 1500) return chew(); // given by hand: already in its mouth
    // Otherwise (fed from the settings) the food drops in, its mouth wide open.
    mouthOpen(eyes, 1);
    faceMood(face, 'surprised');
    const food = document.createElement('div');
    food.className = 'kys-food';
    food.textContent = FOOD[item] || '🍪';
    food.style.left = `${c.x}px`;
    food.style.top = `${c.y + 8}px`;
    document.body.appendChild(food);
    setTimeout(() => {
      food.remove();
      chew();
    }, 480);
  }

  /** How long a meal lasts (the chewing), in ms. */
  const MEAL = 1300;

  /** Kys's mouth, on a pair of eyes: hidden at 0, wide open at 1 (food coming near). */
  function mouthOpen(eyes, open) {
    eyes.style.setProperty('--open', open.toFixed(2));
    eyes.classList.toggle('mouthy', open > 0.02);
  }

  /** Eating: the mouth chomps a few times, crumbs falling (not on the small resting island). */
  function mouthChew(eyes, crumbs = true) {
    mouthOpen(eyes, 0);
    eyes.style.setProperty('--side', Math.random() < 0.5 ? -1 : 1); // chews on one side or the other
    eyes.classList.remove('chewing');
    void eyes.offsetWidth;
    eyes.classList.add('chewing');
    if (crumbs) for (let i = 0; i < 3; i++) setTimeout(() => crumb(eyes), 120 + i * 260);
    clearTimeout(eyes.chewT);
    eyes.chewT = setTimeout(() => eyes.classList.remove('chewing'), 1250);
  }

  function crumb(eyes) {
    const r = eyes.querySelector('.mouth')?.getBoundingClientRect();
    if (!r?.width) return;
    const el = document.createElement('span');
    el.className = 'kys-crumb';
    el.style.left = `${r.left + r.width / 2 + rand(-4, 4)}px`;
    el.style.top = `${r.bottom}px`;
    el.style.setProperty('--cx', `${rand(-8, 8).toFixed(1)}px`);
    el.addEventListener('animationend', () => el.remove());
    document.body.appendChild(el);
  }

  /**
   * Giving Kys something from its page: an item of the inventory follows the pointer, Kys watches
   * it, and for food opens its mouth wider as it comes near. Dropped on Kys, it's eaten, played
   * with or worn; dropped elsewhere, it goes back. A click on what it wears takes it off.
   */
  function kysDrag(m, view, e) {
    const S = m.island;
    const tile = e.target.closest('[data-kys-item]');
    const item = tile && S.kys?.items.find((i) => i.id === tile.dataset.kysItem);
    const face = view.querySelector('.n-kys-face');
    if (!item || !face || e.button !== 0) return;
    e.preventDefault();
    tile.setPointerCapture(e.pointerId);
    const eyes = face.querySelector('.notch-eyes');
    const from = { x: e.clientX, y: e.clientY };
    const mouth = () => {
      const r = face.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 + 8 };
    };
    const reach = (x, y) => { const c = mouth(); return Math.hypot(x - c.x, y - c.y); };
    let ghost = null;
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 5) return; // a click, so far
        ghost = document.createElement('div');
        ghost.className = 'kys-drag';
        ghost.textContent = KYS_ICON[item.id];
        document.body.appendChild(ghost);
        tile.classList.add('dragging');
        S.kysDragging = true;
        faceMood(face, item.kind === 'food' ? 'surprised' : 'curious');
      }
      ghost.style.left = `${ev.clientX}px`;
      ghost.style.top = `${ev.clientY}px`;
      faceAim(view, ev.clientX, ev.clientY);
      const d = reach(ev.clientX, ev.clientY);
      if (item.kind === 'food') mouthOpen(eyes, Math.max(0, Math.min(1, 1 - (d - 25) / 110)));
      ghost.classList.toggle('near', d < 50);
    };
    const end = (ev) => {
      tile.removeEventListener('pointermove', move);
      tile.removeEventListener('pointerup', end);
      tile.removeEventListener('pointercancel', end);
      tile.classList.remove('dragging');
      S.kysDragging = false;
      if (!S.hover) setTimeout(() => { if (!S.hover && !S.typing) setExpanded(m, false); }, m.conf['collapse-delay']);
      if (!ghost) {
        if (tile.classList.contains('worn')) api.kys.wear(null).catch((err) => kysError(m, view, err));
        return;
      }
      if (ev.type === 'pointercancel' || reach(ev.clientX, ev.clientY) > 55) {
        // Not for it: back where it was.
        const r = tile.getBoundingClientRect();
        ghost.classList.add('back');
        ghost.style.left = `${r.left + r.width / 2}px`;
        ghost.style.top = `${r.top + r.height / 2}px`;
        setTimeout(() => ghost.remove(), 260);
        mouthOpen(eyes, 0);
        faceMood(face, 'neutral');
        return;
      }
      const c = mouth();
      ghost.classList.add('given');
      ghost.style.left = `${c.x}px`;
      ghost.style.top = `${c.y}px`;
      setTimeout(() => ghost.remove(), 180);
      S.handFedAt = performance.now();
      const call = item.kind === 'food' ? api.kys.feed(item.id) : item.kind === 'toy' ? api.kys.play() : api.kys.wear(item.id);
      if (item.kind !== 'food') faceMood(face, 'happy', 1800);
      call.catch((err) => {
        mouthOpen(eyes, 0);
        faceMood(face, 'sad', 1500);
        kysError(m, view, err);
      });
    };
    tile.addEventListener('pointermove', move);
    tile.addEventListener('pointerup', end);
    tile.addEventListener('pointercancel', end);
  }

  /** Playing while its page is open: a ball bouncing across the page, the face following it. */
  function facePlay(m) {
    const view = m.island.notch.current;
    const face = view?.querySelector('.n-kys-face');
    if (!face) return;
    const ball = document.createElement('div');
    ball.className = 'kys-ball';
    ball.textContent = '⚽';
    document.body.appendChild(ball);
    faceMood(face, 'happy', 3600);
    const t0 = performance.now(), duration = 3600;
    const step = (now) => {
      const u = (now - t0) / duration;
      if (u >= 1 || !view.isConnected) {
        ball.remove();
        return;
      }
      const r = view.getBoundingClientRect(), f = face.getBoundingClientRect();
      const x = r.left + r.width / 2 + Math.sin(u * Math.PI * 4) * (r.width / 2 - 30);
      const y = f.bottom + 16 - Math.abs(Math.sin(u * Math.PI * 9)) * 14;
      ball.style.left = `${x}px`;
      ball.style.top = `${y}px`;
      ball.style.rotate = `${Math.round(u * 1080)}deg`;
      faceAim(view, x, y);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // --- Views --------------------------------------------------------------------------------
  function compactView(m) {
    const md = activeMedia(m);
    const now = dayjs();
    return {
      key: `compact|${md ? 'media' : 'idle'}|${m.island.unread > 0}`,
      size: 'compact',
      html: `<div class="n-compact${md ? ' with-media' : ''}">${md ? `<span class="n-slot">${trackInfo(md, 'sm', false)}</span>` : ''}`
        + '<span class="n-time" data-morph="time"></span><span class="n-date" data-morph="date"></span>'
        + `${md ? eq(md.playing) : ''}${m.island.unread > 0 ? '<span class="n-dot"></span>' : ''}</div>`,
      update(el) {
        el.querySelector('.n-time').textContent = now.format(m.conf['time-format']);
        el.querySelector('.n-date').textContent = now.format(m.conf['date-format']);
        el.querySelector('.eq')?.classList.toggle('paused', !md?.playing);
        if (md) updateTrack(el, md, 'sm', false);
      },
    };
  }

  function expandedView(m) {
    const S = m.island;
    if (S.page === 'notifs') return historyView(m);
    if (S.page === 'calendar') return calendarView(m);
    if (S.page === 'kys') return kysView(m);
    const md = S.data.media?.has ? S.data.media : null;
    const now = dayjs();
    return {
      key: `expanded|${md ? 'media' : 'none'}|${claudeState(S)}`,
      size: 'expanded',
      html: `<div class="n-expanded">
        <div class="n-head"><span class="n-date-long" data-morph="date"></span><div class="n-head-right">
          <button class="n-kysbtn" title="Kys"><span class="mini-kys"><i></i><i></i></span></button>
          <button class="n-gear" title="${t('island.settings')}">${icon('settings')}</button>
          <button class="n-bell" title="${t('island.notifications')}">${icon('bell')}<span class="n-badge"></span></button>
          <span class="n-time-big" data-morph="time"></span></div></div>
        ${md ? `<div class="n-media">
          <div class="n-slot">${trackInfo(md, 'lg', true)}</div>
          ${eq(md.playing)}
        </div>
        <div class="n-progress"><span class="n-pos"></span><div class="n-track"><div class="n-fill"></div></div><span class="n-dur"></span></div>
        <div class="n-controls">
          <button data-media="prev">${icon('skip-back')}</button>
          <button data-media="play-pause" class="n-play"><i class="icon"></i></button>
          <button data-media="next">${icon('skip-forward')}</button>
        </div>` : `<div class="n-empty">${t('island.nothing_playing')}</div>`}
        <div class="n-stats">
          <span class="n-chip" data-stat="cpu">${icon('cpu')}<b></b></span>
          <span class="n-chip" data-stat="memory">${icon('memory-stick')}<b></b></span>
          <span class="n-chip" data-stat="network">${icon('arrow-down')}<b></b></span>
        </div>
        ${claudeRow(S)}
        <div class="n-chip n-vol"><i class="icon" data-mute></i><input type="range" min="0" max="100"><b></b></div>
      </div>`,
      mount(el) {
        el.querySelector('.n-bell').onclick = () => openHistory(m);
        el.querySelector('.n-kysbtn').onclick = () => { S.page = 'kys'; render(m); };
        el.querySelector('.n-gear').onclick = () => { setExpanded(m, false); api.action('settings'); };
        el.querySelector('.n-date-long').onclick = () => openCalendar(m);
        el.querySelectorAll('.n-claude-refresh').forEach((b) => {
          b.onclick = () => {
            S.claudeSpinAt = Date.now();
            b.classList.add('spinning');
            clearTimeout(S.claudeSpinTimer);
            S.claudeSpinTimer = setTimeout(() => stopClaudeSpin(S), 8000);
            api.action('claude-refresh');
          };
        });
        el.querySelectorAll('[data-media]').forEach((b) => {
          b.onclick = () => api.action('media', b.dataset.media);
        });
        const track = el.querySelector('.n-track');
        if (track) {
          track.onclick = (e) => {
            const cur = S.data.media;
            if (!cur?.duration) return;
            const r = track.getBoundingClientRect();
            api.action('media', 'seek', clamp((e.clientX - r.left) / r.width, 0, 1) * cur.duration);
          };
        }
        const range = el.querySelector('input[type=range]');
        // While dragging, the volume shown follows the slider; once it ends, however it ends
        // (released, the island closing, the mouse leaving it...), back to the current volume.
        S.dragging = false;
        const release = () => {
          if (!S.dragging) return;
          S.dragging = false;
          syncVolume(el, S.data.audio);
        };
        range.addEventListener('pointerdown', (e) => {
          S.dragging = true;
          range.setPointerCapture?.(e.pointerId); // keeps the drag past the island's edge
        });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) range.addEventListener(type, release);
        range.addEventListener('input', () => {
          el.querySelector('.n-vol b').textContent = range.value;
          api.action('audio', Number(range.value));
        });
        el.querySelector('[data-mute]').onclick = () => api.action('audio', 'mute');
      },
      update(el) {
        const d = S.data;
        el.querySelector('.n-date-long').textContent = now.format(m.conf['date-long-format']);
        el.querySelector('.n-time-big').textContent = now.format(m.conf['time-format']);
        const badge = el.querySelector('.n-badge');
        badge.textContent = S.unread > 9 ? '9+' : S.unread;
        badge.hidden = !S.unread;
        el.querySelector('.n-kysbtn').classList.toggle('hungry', (S.kys?.food ?? 100) < 30); // asking for food
        const cur = d.media;
        if (cur?.has && el.querySelector('.n-media')) {
          updateTrack(el, cur, 'lg', true);
          const pos = mediaPosition(cur);
          el.querySelector('.n-pos').textContent = fmtDuration(pos);
          el.querySelector('.n-dur').textContent = cur.duration ? fmtDuration(cur.duration) : '';
          el.querySelector('.n-fill').style.width = `${cur.duration ? (pos / cur.duration) * 100 : 0}%`;
          // Live / stream without a duration: no progress bar.
          el.querySelector('.n-progress').hidden = !(cur.duration >= 1);
          el.querySelector('.n-play .icon').className = `icon icon-${cur.playing ? 'pause' : 'play'}`;
          el.querySelector('.eq')?.classList.toggle('paused', !cur.playing);
        }
        const chip = (name, text) => { el.querySelector(`[data-stat="${name}"] b`).textContent = text; };
        chip('cpu', d.cpu ? `${d.cpu.usage}%` : '–');
        chip('memory', d.memory ? `${d.memory.percentage}%` : '–');
        chip('network', d.network?.connected ? d.network.down : t('island.offline'));
        updateClaude(el, d.claude);
        if (d.audio) {
          el.querySelector('[data-mute]').className = `icon icon-${d.audio.muted ? 'volume-x' : 'volume-2'}`;
          if (!S.dragging) syncVolume(el, d.audio);
        }
      },
    };
  }

  function volumeView(a) {
    return {
      key: 'transient|volume',
      size: 'wide',
      html: `<div class="n-wide"><i class="icon"></i><div class="n-bar"><div class="n-bar-fill"></div></div><span class="n-num"></span></div>`,
      update(el) {
        const v = a.muted ? 0 : a.volume;
        el.querySelector('.icon').className = `icon icon-${a.muted ? 'volume-x' : v < 34 ? 'volume' : v < 67 ? 'volume-1' : 'volume-2'}`;
        el.querySelector('.n-bar-fill').style.width = `${v}%`;
        el.querySelector('.n-num').textContent = a.muted ? t('island.muted') : v;
      },
    };
  }

  function trackView(md) {
    return {
      key: 'transient|track',
      size: 'wide',
      html: `<div class="n-wide track"><div class="n-slot">${trackInfo(md, 'md', true)}</div>${eq(true)}</div>`,
      update(el) { updateTrack(el, md, 'md', true); },
    };
  }

  // --- Track change: the art + title block slides ------------------------------------------
  // The old one leaves to the left, the new one comes from the right; the rest of the view stays.
  function trackInfo(md, size, withMeta) {
    const meta = withMeta
      ? `<div class="n-meta"><div class="n-title" data-morph="title">${esc(md.title)}</div>`
        + `<div class="n-artist" data-morph="artist">${esc(md.artist || appName(md.app))}</div></div>`
      : '';
    return `<div class="n-info" data-track="${esc(md.key)}" data-thumb="${md.thumb ? 1 : 0}">${cover(md, size)}${meta}</div>`;
  }

  function updateTrack(el, md, size, withMeta) {
    const slot = el.querySelector('.n-slot');
    const cur = slot?.querySelector('.n-info:not(.leaving)');
    if (!slot || !cur) return;
    if (cur.dataset.track !== md.key) return slideTrack(slot, cur, trackInfo(md, size, withMeta));
    // Same track, album art arrived in the meantime: replaced in place, no slide.
    if (md.thumb && cur.dataset.thumb === '0') {
      cur.querySelector('.n-cover').outerHTML = cover(md, size);
      cur.dataset.thumb = '1';
    }
  }

  function slideTrack(slot, old, html) {
    slot.insertAdjacentHTML('beforeend', html);
    const next = slot.lastElementChild;
    old.classList.add('leaving');
    old.querySelectorAll('[data-morph]').forEach((e) => e.removeAttribute('data-morph')); // a single shared element
    old.animate(
      [{ transform: 'translateX(0)', opacity: 1, filter: 'blur(0)' }, { transform: 'translateX(-48px)', opacity: 0, filter: 'blur(3px)' }],
      { duration: 280, easing: 'cubic-bezier(.5, 0, .75, 0)', fill: 'forwards' },
    ).finished.then(() => old.remove()).catch(() => old.remove());
    next.animate(
      [{ transform: 'translateX(48px)', opacity: 0, filter: 'blur(3px)' }, { transform: 'translateX(0)', opacity: 1, filter: 'blur(0)' }],
      { duration: 460, delay: 90, easing: 'cubic-bezier(.3, 1.25, .5, 1)', fill: 'backwards' },
    );
  }

  function batteryView(b) {
    return {
      key: `transient|battery|${b.plugged}`,
      size: 'wide',
      html: `<div class="n-wide ${b.plugged ? 'n-good' : ''}">${icon(b.plugged ? 'battery-charging' : 'battery')}`
        + `<span class="n-label">${t(b.plugged ? 'island.charging' : 'island.on_battery')}</span><span class="n-num">${b.capacity}%</span></div>`,
    };
  }

  function networkView(n) {
    return {
      key: `transient|network|${n.connected}`,
      size: 'wide',
      html: n.connected
        ? `<div class="n-wide n-good">${icon(n.type === 'wifi' ? 'wifi' : 'ethernet-port')}<span class="n-label">${t('island.connected')}</span><span class="n-num">${esc(n.essid || n.ifname || '')}</span></div>`
        : `<div class="n-wide n-bad">${icon('wifi-off')}<span class="n-label">${t('island.network_lost')}</span></div>`,
    };
  }

  // --- Claude usage -------------------------------------------------------------------------
  // 'off': option disabled / no data; 'ok': gauges; otherwise a message (expired token...).
  const claudeState = (S) => (!S.claudeOn || !S.data.claude ? 'off' : S.data.claude.ok ? 'ok' : S.data.claude.reason);
  const claudeLevel = (p) => (p >= 90 ? 'critical' : p >= 75 ? 'warning' : '');

  function claudeReset(ts, short) {
    if (!ts) return '';
    const min = Math.max(0, Math.round((ts - Date.now()) / 60000));
    if (short) return min < 60 ? t('time.in_minutes', { n: min }) : t('time.in_hours', { h: Math.floor(min / 60), m: String(min % 60).padStart(2, '0') });
    return dayjs(ts).format('ddd HH:mm');
  }

  function claudeRow(S) {
    const state = claudeState(S);
    if (state === 'off' || state === 'absent') return '';
    if (state === 'rate-limited') {
      const at = S.data.claude.retryAt ? t('claude.retry_at', { time: dayjs(S.data.claude.retryAt).format('HH:mm') }) : '';
      return `<div class="n-claude muted"><i class="icon icon-sparkle"></i><span>${t('claude.rate_limited')}${at}</span><button class="n-claude-refresh" title="${t('claude.refresh')}"><i class="icon icon-refresh-cw"></i></button></div>`;
    }
    if (state !== 'ok') {
      return `<div class="n-claude muted"><i class="icon icon-sparkle"></i><span>${t('claude.open_claude_code')}</span></div>`;
    }
    const gauge = (key, label) => `<div class="n-claude-gauge" data-claude="${key}">
        <div class="n-claude-top"><span>${label}</span><b></b></div>
        <div class="n-claude-track"><div class="n-claude-fill"></div></div>
        <div class="n-claude-reset"></div></div>`;
    const c = S.data.claude;
    const plan = c.plan ? ` ${c.plan.charAt(0).toUpperCase()}${c.plan.slice(1)}` : '';
    return `<div class="n-claude">
        <div class="n-claude-head"><i class="icon icon-sparkle"></i><span class="n-claude-plan">Claude${esc(plan)}</span>
          <span class="n-claude-account">${esc(c.account || '')}</span><span class="n-claude-age"></span><button class="n-claude-refresh" title="${t('claude.refresh')}"><i class="icon icon-refresh-cw"></i></button></div>
        <div class="n-claude-gauges">${gauge('session', t('claude.session'))}${gauge('week', t('claude.week'))}</div>
      </div>`;
  }

  function stopClaudeSpin(S) {
    const wait = Math.max(0, 600 - (Date.now() - (S.claudeSpinAt || 0)));
    clearTimeout(S.claudeSpinTimer);
    S.claudeSpinTimer = setTimeout(() => {
      S.notch.current?.querySelectorAll('.n-claude-refresh.spinning').forEach((b) => b.classList.remove('spinning'));
    }, wait);
  }

  function updateClaude(el, c) {
    if (!c?.ok) return;
    const age = el.querySelector('.n-claude-age');
    if (age) age.textContent = c.fetchedAt ? `· ${ago(c.fetchedAt)}` : '';
    for (const key of ['session', 'week']) {
      const g = el.querySelector(`[data-claude="${key}"]`);
      const w = c[key];
      if (!g || !w) continue;
      g.querySelector('b').textContent = `${w.percent} %`;
      g.querySelector('.n-claude-fill').style.width = `${Math.min(100, w.percent)}%`;
      g.className = `n-claude-gauge ${claudeLevel(w.percent)}`;
      g.querySelector('.n-claude-reset').textContent = w.resetsAt ? t('claude.resets', { when: claudeReset(w.resetsAt, key === 'session') }) : '';
    }
  }

  function claudeAlertView(c, reached) {
    const reset = c.session.resetsAt ? dayjs(c.session.resetsAt).format('HH:mm') : '';
    return {
      key: `transient|claude|${reached}`,
      size: 'wide',
      html: `<div class="n-wide ${reached ? 'n-bad' : 'n-claude-alert'}"><i class="icon icon-sparkle"></i>`
        + `<span class="n-label">${t(reached ? 'claude.limit_reached' : 'claude.session_80')}</span>`
        + `<span class="n-num">${reached ? `${reset}` : `${c.session.percent} %`}</span></div>`,
    };
  }

  function workspaceView(ws) {
    return {
      key: `transient|ws|${ws.name}`,
      size: 'wide',
      html: `<div class="n-wide">${icon('layout-grid')}<span class="n-label">${t('island.desktop', { name: esc(ws.displayName || ws.name) })}</span></div>`,
    };
  }

  // --- Calendar (click on the date) ------------------------------------------------------------
  function openCalendar(m) {
    const S = m.island;
    S.page = 'calendar';
    S.calMonth = dayjs().startOf('month');
    if (!S.expanded) setExpanded(m, true); else render(m);
  }

  function calendarView(m) {
    const S = m.island;
    return {
      key: 'calendar',
      size: 'expanded',
      html: `<div class="n-expanded n-calendar-view">
        <div class="n-hist-head">
          <button class="n-back" title="${t('island.back')}">${icon('chevron-left')}</button>
          <span class="n-hist-title n-cal-title"></span>
          <button class="n-cal-today" title="${t('island.today')}">${icon('calendar-check')}</button>
          <button class="n-cal-prev" title="${t('island.prev_month')}">${icon('chevron-up')}</button>
          <button class="n-cal-next" title="${t('island.next_month')}">${icon('chevron-down')}</button>
        </div>
        <div class="n-cal-slot"></div>
      </div>`,
      mount(el) {
        el.querySelector('.n-back').onclick = () => { S.page = 'main'; render(m); };
        const go = (delta) => {
          const target = delta ? S.calMonth.add(delta, 'month') : dayjs().startOf('month');
          if (target.isSame(S.calMonth, 'month')) return;
          const dir = target.isAfter(S.calMonth) ? 1 : -1;
          S.calMonth = target;
          drawCalendar(el, S, dir);
        };
        el.querySelector('.n-cal-prev').onclick = () => go(-1);
        el.querySelector('.n-cal-next').onclick = () => go(1);
        el.querySelector('.n-cal-today').onclick = () => go(0);
        // Mouse wheel: previous / next month (instead of the volume).
        let lastWheel = 0;
        el.querySelector('.n-cal-slot').addEventListener('wheel', (e) => {
          e.stopPropagation();
          if (Date.now() - lastWheel < 300) return; // one wheel notch = one month
          lastWheel = Date.now();
          go(e.deltaY < 0 ? -1 : 1);
        }, { passive: true });
        drawCalendar(el, S, 0);
      },
      update(el) {
        // Midnight: the highlighted day changes.
        if (el.dataset.today !== dayjs().format('YYYY-MM-DD')) drawCalendar(el, S, 0);
      },
    };
  }

  // Month grid (weeks from Monday to Sunday, days of the neighboring months dimmed).
  // dir: 1 / -1 → the old month slides up / down while the new one comes in.
  function drawCalendar(el, S, dir) {
    const month = S.calMonth;
    const today = dayjs();
    el.dataset.today = today.format('YYYY-MM-DD');
    const title = month.format('MMMM YYYY');
    el.querySelector('.n-cal-title').textContent = title.charAt(0).toUpperCase() + title.slice(1);
    el.querySelector('.n-cal-today').classList.toggle('hidden', month.isSame(today, 'month'));
    const first = month.startOf('month');
    const start = first.subtract((first.day() + 6) % 7, 'day');
    const weeks = Math.ceil(((first.day() + 6) % 7 + month.daysInMonth()) / 7);
    let cells = t('island.weekdays').split(',').map((d) => `<span class="n-cal-wd">${d}</span>`).join('');
    for (let i = 0; i < weeks * 7; i++) {
      const d = start.add(i, 'day');
      const cls = ['n-cal-day', !d.isSame(month, 'month') && 'other', d.day() % 6 === 0 && 'weekend', d.isSame(today, 'day') && 'today'].filter(Boolean).join(' ');
      cells += `<span class="${cls}">${d.date()}</span>`;
    }
    const slot = el.querySelector('.n-cal-slot');
    const old = slot.querySelector('.n-cal-grid:not(.leaving)');
    slot.insertAdjacentHTML('beforeend', `<div class="n-cal-grid">${cells}</div>`);
    const next = slot.lastElementChild;
    if (old && dir) {
      old.classList.add('leaving');
      old.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${-24 * dir}px)`, opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
        .finished.then(() => old.remove()).catch(() => old.remove());
      next.animate([{ transform: `translateY(${24 * dir}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, delay: 60, easing: 'cubic-bezier(.3, 1.25, .5, 1)', fill: 'backwards' });
    } else if (old) {
      old.remove();
    }
    requestAnimationFrame(() => S.notch.resize()); // 5 or 6 weeks: the notch adjusts
  }

  // --- Notification history -------------------------------------------------------------
  function openHistory(m) {
    const S = m.island;
    S.page = 'notifs';
    S.unread = 0;
    S.history = null;
    render(m);
    api.notifications().then((list) => {
      if (S.page !== 'notifs') return;
      S.history = list;
      S.historyLoad = (S.historyLoad || 0) + 1;
      render(m);
    });
  }

  // Opens the notification's app (like a click in Windows) and removes it from the center.
  function openNotif(n) {
    api.action('notif-open', { aumid: n.aumid, launch: n.launch });
    api.action('notif-remove', n.nid);
  }

  // Removes a history item with a short animation, without reloading the list.
  function removeHistoryItem(m, el, n) {
    const S = m.island;
    S.history = S.history.filter((x) => x !== n);
    el.style.height = `${el.offsetHeight}px`;
    requestAnimationFrame(() => el.classList.add('removing'));
    setTimeout(() => {
      const box = el.parentElement;
      el.remove();
      // A single message, once the last item is really gone (several animations can end together).
      if (box && !box.querySelector('.n-hist-item, .n-empty')) box.insertAdjacentHTML('beforeend', `<div class="n-empty">${t('island.no_notifications')}</div>`);
      S.notch.resize();
    }, 220);
  }

  function ago(ts) {
    const sec = (Date.now() - ts) / 1000;
    if (sec < 60) return t('time.just_now');
    if (sec < 3600) return t('time.minutes_ago', { n: Math.floor(sec / 60) });
    if (sec < 86400) return t('time.hours_ago', { n: Math.floor(sec / 3600) });
    return dayjs(ts).format('D MMM HH:mm');
  }

  function historyView(m) {
    const S = m.island;
    const list = S.history;
    const items = !list ? `<div class="n-empty">${t('island.loading')}</div>`
      : !list.length ? `<div class="n-empty">${t('island.no_notifications')}</div>`
      : list.map((n, i) => `<div class="n-hist-item" data-idx="${i}">${notifIcon(n)}<div class="n-notif-main">
          <div class="n-notif-head"><span class="n-notif-app">${esc(n.app)}</span><span class="n-notif-time" data-at="${n.at}"></span></div>
          <div class="n-title">${esc(n.title)}</div>
          ${n.body ? `<div class="n-notif-text">${esc(n.body)}</div>` : ''}
        </div><button class="n-close" title="${t('island.delete')}">${icon('x')}</button></div>`).join('');
    return {
      key: `notifs|${list ? S.historyLoad : 'loading'}`,
      size: 'expanded',
      html: `<div class="n-expanded n-history-view">
        <div class="n-hist-head">
          <button class="n-back" title="${t('island.back')}">${icon('chevron-left')}</button>
          <span class="n-hist-title">${t('island.notifications')}</span>
          <button class="n-clear" title="${t('island.clear_all')}">${icon('trash-2')}</button>
          <button class="n-center" title="${t('island.notification_center')}">${icon('panel-right-open')}</button>
        </div>
        <div class="n-history">${items}</div>
      </div>`,
      mount(el) {
        const snapshot = list || [];
        el.querySelector('.n-back').onclick = () => { S.page = 'main'; render(m); };
        el.querySelector('.n-center').onclick = () => { setExpanded(m, false); api.action('notification-center'); };
        el.querySelector('.n-clear').onclick = () => {
          api.action('notif-clear');
          el.querySelectorAll('.n-hist-item').forEach((item) => removeHistoryItem(m, item, snapshot[item.dataset.idx]));
        };
        el.querySelector('.n-history').onclick = (e) => {
          const item = e.target.closest('.n-hist-item');
          if (!item || item.classList.contains('removing')) return;
          const n = snapshot[item.dataset.idx];
          if (!e.target.closest('.n-close')) openNotif(n);
          else api.action('notif-remove', n.nid);
          removeHistoryItem(m, item, n);
        };
      },
      update(el) {
        el.querySelectorAll('[data-at]').forEach((t) => { t.textContent = ago(Number(t.dataset.at)); });
      },
    };
  }

  // Stable color per app for the initial badge.
  const hueOf = (str) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

  function notifIcon(n) {
    return n.icon
      ? `<img class="n-notif-icon" src="${n.icon}">`
      : `<span class="n-notif-icon letter" style="background:hsl(${hueOf(n.app)} 55% 45%)">${esc((n.app || '?').charAt(0).toUpperCase())}</span>`;
  }

  function notificationView(n) {
    const icon = notifIcon(n);
    return {
      key: `notif|${n.id}`,
      size: 'card',
      html: `<div class="n-notif">${icon}<div class="n-notif-main">
          <div class="n-notif-head"><span class="n-notif-app">${esc(n.app)}</span><span class="n-notif-time">${t('island.now')}</span></div>
          <div class="n-title">${esc(n.title)}</div>
          ${n.body ? `<div class="n-notif-text">${esc(n.body)}</div>` : ''}
        </div><button class="n-close" title="${t('island.close')}">${`<i class="icon icon-x"></i>`}</button></div>`,
      data: n,
    };
  }

  let messageId = 0;
  function messageView(msg) {
    return {
      key: `transient|msg|${++messageId}`,
      size: 'wide',
      html: `<div class="n-wide message">${icon(msg.icon || 'bell')}<span class="n-label">${esc(msg.text)}</span></div>`,
    };
  }
})();
