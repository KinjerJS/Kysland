'use strict';
// Settings window: the right-click menu's options with more room. Each change is written to
// config.jsonc by the engine; the reload that follows sends the new state back.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const { t } = window.i18n;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Island options and their defaults (same as island.js / the engine).
  const ISLAND = {
    'expand-on-hover': true, outline: 'auto', dodge: true, 'dodge-speed': 450, 'dodge-eyes': true,
    'dodge-roam': true, 'dodge-roam-delay': 20, 'auto-hide': false, 'auto-hide-distance': 300,
    notifications: true, 'hide-windows-osd': true, claude: false,
  };
  // Top-level options, as named in the state sent by the engine.
  const TOP = { language: 'language', monitors: 'monitors', 'hide-on-fullscreen': 'hideOnFullscreen', autostart: 'autostart' };

  let S = null;

  async function load() {
    S = await invoke('settings_state');
    S.island = { ...ISLAND, ...S.island };
    S.language = S.language ?? 'auto';
    S.monitors = S.monitors ?? 'primary';
    i18n.setLang(S.lang);
    render();
  }

  const val = (key) => (key in ISLAND ? S.island[key] : S[TOP[key]]);

  function set(key, value) {
    // Shown right away; the engine confirms with the reloaded state.
    if (key in ISLAND) S.island[key] = value; else S[TOP[key]] = value;
    render();
    invoke('set_setting', { key, value }).catch((e) => toast(t('set.error', { error: e })));
  }

  let toastT = 0;
  function toast(text) {
    const el = $('.toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('show'), 4000);
  }

  // --- Building blocks ---------------------------------------------------------------------------
  const section = (title, rows) => `<section><h2>${esc(title)}</h2><div class="card">${rows.join('')}</div></section>`;

  function row(title, desc, control, { disabled = false, block = false, sub = false } = {}) {
    const cls = ['row', disabled && 'disabled', block && 'block', sub && 'sub'].filter(Boolean).join(' ');
    return `<div class="${cls}"><div class="text"><div class="title">${esc(title)}</div>`
      + `${desc ? `<div class="desc">${esc(desc)}</div>` : ''}</div><div class="control">${control}</div></div>`;
  }

  const toggle = (key) => `<button class="switch" role="switch" aria-checked="${val(key) === true}" data-toggle="${key}"><span></span></button>`;

  const seg = (key, options) => `<div class="seg">${options.map(([v, label]) => {
    const on = JSON.stringify(val(key)) === JSON.stringify(v);
    return `<button class="${on ? 'on' : ''}" data-key="${key}" data-value="${esc(JSON.stringify(v))}">${esc(label)}</button>`;
  }).join('')}</div>`;

  // Screens: the main one, all of them, or picked ones (click a screen to add or remove it).
  function screens() {
    const m = S.monitors;
    const mode = m === 'all' ? 'all' : Array.isArray(m) && m.length ? 'pick' : 'primary';
    const modes = [['primary', t('set.screens_primary')], ['all', t('set.screens_all')], ['pick', t('set.screens_pick')]];
    const cards = S.screens.map((s) => {
      const on = shownOn(s);
      return `<button class="screen${on ? ' on' : ''}" data-screen="${s.index}">`
        + `<div class="monitor" style="aspect-ratio: ${s.width} / ${s.height}">${s.index + 1}</div>`
        + `<div class="screen-name">${esc(s.name)}</div>`
        + `<div class="screen-meta">${s.width}×${s.height}${s.primary ? ` · <span class="badge">${esc(t('set.screen_main'))}</span>` : ''}</div>`
        + '</button>';
    }).join('');
    return `<div class="seg">${modes.map(([v, label]) => `<button class="${mode === v ? 'on' : ''}" data-screens="${v}">${esc(label)}</button>`).join('')}</div>`
      + `<div class="screens">${cards}</div>`;
  }

  function shownOn(s) {
    const m = S.monitors;
    if (m === 'all') return true;
    if (Array.isArray(m) && m.length) return m.includes(s.index);
    return s.primary;
  }

  const action = (name, icon, label) => `<button data-action="${name}"><i class="icon icon-${icon}"></i><span>${esc(label)}</span></button>`;

  // --- Page ----------------------------------------------------------------------------------------
  function render() {
    const I = S.island;
    const dodgeOff = !I.dodge;
    const eyesOff = dodgeOff || !I['dodge-eyes'];
    const roamOff = eyesOff || !I['dodge-roam'];
    document.title = t('set.window_title');
    $('.version').textContent = t('set.version', { version: S.version });
    $('#sections').innerHTML = [
      section(t('set.general'), [
        row(t('set.language'), '', seg('language', [['auto', t('set.lang_auto')], ['en', 'English'], ['fr', 'Français']])),
        row(t('set.autostart'), t('set.autostart_desc'), toggle('autostart')),
        row(t('set.screens'), t('set.screens_desc'), screens(), { block: true }),
      ]),
      section(t('set.island'), [
        row(t('set.expand'), t('set.expand_desc'), toggle('expand-on-hover')),
        row(t('set.autohide'), t('set.autohide_desc'), toggle('auto-hide')),
        row(t('set.autohide_distance'), '', seg('auto-hide-distance', [[200, '200 px'], [300, '300 px'], [500, '500 px']]), { disabled: !I['auto-hide'], sub: true }),
        row(t('set.fullscreen'), t('set.fullscreen_desc'), toggle('hide-on-fullscreen')),
        row(t('set.outline'), t('set.outline_desc'), seg('outline', [['auto', t('set.outline_auto')], [true, t('set.outline_on')], [false, t('set.outline_off')]])),
      ]),
      section(t('set.dodge_section'), [
        row(t('set.dodge'), t('set.dodge_desc'), toggle('dodge')),
        row(t('set.dodge_speed'), '', seg('dodge-speed', [[300, t('set.speed_low')], [450, t('set.speed_medium')], [650, t('set.speed_high')]]), { disabled: dodgeOff, sub: true }),
        row(t('set.eyes'), t('set.eyes_desc'), toggle('dodge-eyes'), { disabled: dodgeOff, sub: true }),
        row(t('set.roam'), t('set.roam_desc'), toggle('dodge-roam'), { disabled: eyesOff, sub: true }),
        row(t('set.roam_delay'), '', seg('dodge-roam-delay', [[10, '10 s'], [20, '20 s'], [40, '40 s']]), { disabled: roamOff, sub: true }),
      ]),
      section(t('set.features'), [
        row(t('set.notifications'), t('set.notifications_desc'), toggle('notifications')),
        row(t('set.osd'), t('set.osd_desc'), toggle('hide-windows-osd')),
        row(t('set.claude'), S.claudeInstalled ? t('set.claude_desc') : t('set.claude_missing'), toggle('claude'), { disabled: !S.claudeInstalled }),
      ]),
      section(t('set.advanced'), [
        `<div class="actions">${[
          action('edit-config', 'file-cog', t('set.edit_config')),
          action('edit-style', 'palette', t('set.edit_style')),
          action('open-config', 'folder-open', t('set.open_folder')),
          action('devtools', 'code', t('set.devtools')),
          action('reload', 'refresh-cw', t('set.reload')),
        ].join('')}</div>`,
      ]),
    ].join('');
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !S || b.closest('.disabled')) return;
    const d = b.dataset;
    if (d.toggle) return set(d.toggle, val(d.toggle) !== true);
    if (d.key) return set(d.key, JSON.parse(d.value));
    if (d.screens) {
      const primary = S.screens.find((s) => s.primary)?.index ?? 0;
      if (d.screens === 'pick') return Array.isArray(S.monitors) && S.monitors.length ? undefined : set('monitors', [primary]);
      return set('monitors', d.screens);
    }
    if (d.screen) {
      // Starts from the screens showing the island right now, adds or removes this one.
      const i = Number(d.screen);
      const current = S.screens.filter(shownOn).map((s) => s.index);
      const next = current.includes(i) ? current.filter((x) => x !== i) : [...current, i].sort((a, b) => a - b);
      if (next.length) set('monitors', next);
      return;
    }
    if (d.action) invoke('settings_action', { name: d.action });
  });

  // --- Buddy: the little island of the header --------------------------------------------------
  // At the top of the page it sits in the header and only follows the cursor with its eyes (it
  // blinks, and dozes off with z's when the mouse stays still). Scroll down and it comes along: it
  // sticks to the top of the window, then keeps you company: wanders and looks around, comes next
  // to the cursor in two or three hops (never onto it), stares, hops away when the cursor gets onto
  // it. A calmer cousin of the hidden island's eyes. Back at the top, it goes home. It never catches
  // the mouse; with reduced motion it stays home.
  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const STICK = 44; // px from the top of the window where it stays when the page scrolls

  class Buddy {
    constructor(home, calm) {
      this.home = home;
      this.calm = calm;
      this.el = document.createElement('div');
      this.el.className = 'buddy';
      this.el.setAttribute('aria-hidden', 'true');
      this.el.innerHTML = '<div class="buddy-eyes"><span class="eye l"><b></b><i></i></span><span class="eye r"><b></b><i></i></span></div>';
      document.body.appendChild(this.el);
      this.eyes = this.el.firstElementChild;
      this.mode = 'home';
      this.settled = true;
      this.pos = this.homeSpot();
      this.cursor = null;
      this.cursorAt = performance.now();
      this.trail = [];
      this.move = null;
      document.addEventListener('mousemove', (e) => this.track(e.clientX, e.clientY));
      document.documentElement.addEventListener('mouseleave', () => { this.cursor = null; });
      const blink = () => {
        this.eyes.classList.add('blink');
        setTimeout(() => this.eyes.classList.remove('blink'), 120);
        setTimeout(blink, rand(2200, 5500));
      };
      setTimeout(blink, rand(1500, 3000));
      let last = 0;
      const tick = (now) => {
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
        last = now;
        this.step(now, dt);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    homeSpot() {
      const r = this.home.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    track(x, y) {
      const now = performance.now();
      this.cursor = { x, y };
      this.cursorAt = now;
      this.trail.push({ t: now, x, y });
      while (this.trail.length && now - this.trail[0].t > 400) this.trail.shift();
      this.spinCheck(x, y, now);
    }

    /** Circling the cursor around it (about a turn per second for two seconds) makes it dizzy. */
    spinCheck(x, y, now) {
      const dx = x - this.pos.x, dy = y - this.pos.y, r = Math.hypot(dx, dy);
      const dt = this.spinAt ? (now - this.spinAt) / 1000 : 0;
      this.spinAt = now;
      this.spin = (this.spin || 0) * Math.exp(-dt / 1.6);
      if (r < 20 || r > 300) { this.spinAngle = null; return; }
      const a = Math.atan2(dy, dx);
      if (this.spinAngle != null) {
        let d = a - this.spinAngle;
        if (d > Math.PI) d -= 2 * Math.PI;
        else if (d < -Math.PI) d += 2 * Math.PI;
        this.spin += d;
      }
      this.spinAngle = a;
      if (Math.abs(this.spin) > 8) {
        if (!this.dizzyUntil) { this.spinDir = Math.sign(this.spin) || 1; this.setMood('dizzy'); }
        this.dizzyUntil = now + 2200;
      }
    }

    /** Distance the cursor covered in the last 400 ms (a slow sneak doesn't wake it). */
    travel() {
      let d = 0;
      for (let i = 1; i < this.trail.length; i++) d += Math.hypot(this.trail[i].x - this.trail[i - 1].x, this.trail[i].y - this.trail[i - 1].y);
      return d;
    }

    step(now, dt) {
      const home = this.homeSpot();
      // Leaves home when the header scrolls past the top, comes back when it's there again.
      if (this.mode === 'home' && home.y < STICK && !this.calm) {
        this.mode = 'out';
        this.setMove(this.stick(now));
      } else if (this.mode === 'out' && home.y >= STICK) {
        this.mode = 'home';
        this.settled = false;
        this.setMove(this.rest(now));
        this.setMood('happy', 800);
      }
      const c = this.cursor;
      const out = this.mode === 'out';
      const asleep = this.move?.kind === 'doze';
      // Cursor onto it: hops away (out and about only, not in its sleep, not too often).
      if (out && c && now - this.cursorAt < 400 && !asleep && !this.dizzyUntil && this.move?.kind !== 'stick'
          && now - (this.fledAt || 0) > 2200 && Math.hypot(c.x - this.pos.x, c.y - this.pos.y) < 42) {
        this.fledAt = now;
        this.setMove(this.flee(now, c));
      }
      if (asleep && this.travel() > 45) {
        this.setMood('surprised', 700, ['grumpy', 1400]);
        this.setMove(null);
      }
      if (!this.move || now > this.move.until) this.setMove(this.nextMove(now));
      if (!out && this.settled) {
        this.pos = home; // sits in the header, scrolling with it
      } else {
        const t = this.move.target(now);
        const k = 1 - Math.exp(-dt * this.move.pull);
        this.pos = { x: this.pos.x + (t.x - this.pos.x) * k, y: this.pos.y + (t.y - this.pos.y) * k };
        if (out) this.pos = { x: this.clampX(this.pos.x), y: this.clampY(this.pos.y) };
        else if (Math.hypot(home.x - this.pos.x, home.y - this.pos.y) < 0.5) this.settled = true;
      }
      const breath = out ? Math.sin(now / 800) * 1.5 : 0;
      this.el.style.setProperty('--x', `${this.pos.x.toFixed(1)}px`);
      this.el.style.setProperty('--y', `${(this.pos.y + breath).toFixed(1)}px`);
      if (this.dizzyUntil && now > this.dizzyUntil) {
        // Over: a bit cross.
        this.dizzyUntil = 0;
        this.spin = 0;
        this.setMood('grumpy', 1600);
      }
      if (this.dizzyUntil) {
        // Rolling eyes, turning the way the cursor went round.
        const a = (now / 90) * this.spinDir;
        this.eyes.style.setProperty('--gx', `${(Math.cos(a) * 4).toFixed(2)}px`);
        this.eyes.style.setProperty('--gy', `${(Math.sin(a) * 3).toFixed(2)}px`);
        return;
      }
      const spot = this.move.look?.(now) ?? c;
      if (spot) this.aim(spot.x, spot.y);
    }

    clampX(x) { return Math.max(52, Math.min(innerWidth - 52, x)); }
    clampY(y) { return Math.max(STICK, Math.min(innerHeight - 40, y)); }

    aim(x, y) {
      const dx = x - this.pos.x, dy = y - this.pos.y;
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, len / 90);
      const gx = (dx / len) * k, gy = (dy / len) * k;
      const s = this.eyes.style;
      s.setProperty('--gx', `${(gx * 5).toFixed(2)}px`);
      s.setProperty('--gy', `${(gy * 3.5).toFixed(2)}px`);
      s.setProperty('--sl', (1 - Math.max(0, gx) * 0.18).toFixed(3));
      s.setProperty('--sr', (1 + Math.min(0, gx) * 0.18).toFixed(3));
    }

    setMood(mood, ms = 0, then = null) {
      clearTimeout(this.moodT);
      this.eyes.dataset.mood = mood;
      if (ms) this.moodT = setTimeout(() => (then ? this.setMood(...then) : this.setMood('neutral')), ms);
    }

    setMove(move) {
      this.move?.end?.();
      this.move = move;
    }

    nextMove(now) {
      const c = this.cursor;
      if (now - this.cursorAt > 12000) return this.doze(now);
      if (this.mode === 'home') return this.rest(now);
      const roll = Math.random();
      if (c && roll < 0.3) return this.approach(now);
      if (roll < 0.7) return this.wander(now);
      return this.watch(now);
    }

    // At home: stays in its spot in the header.
    rest(now) {
      return { kind: 'rest', pull: 9, until: now + 2000, target: () => this.homeSpot() };
    }

    // The header just scrolled away: stays at the top of the window for a moment.
    stick(now) {
      const x = this.pos.x;
      return { kind: 'stick', pull: 16, until: now + 900, target: () => ({ x, y: STICK }) };
    }

    // Comes next to the cursor in two or three hops.
    approach(now) {
      let side = Math.sign(this.pos.x - this.cursor.x) || pick([-1, 1]);
      let spot = { ...this.pos }, hops = 0, hopAt = now;
      const total = pick([2, 3]);
      return {
        kind: 'approach', pull: 4, until: now + total * 850 + rand(1800, 3000),
        target: (t) => {
          const c = this.cursor;
          if (c && hops < total && t >= hopAt) {
            let gx = this.clampX(c.x + side * rand(66, 88));
            if (Math.abs(gx - c.x) < 52) { side = -side; gx = this.clampX(c.x + side * rand(66, 88)); }
            const gy = this.clampY(c.y + rand(-24, 16));
            const step = hops === total - 1 ? 1 : rand(0.4, 0.6);
            spot = { x: spot.x + (gx - spot.x) * step, y: spot.y + (gy - spot.y) * step };
            hops++;
            hopAt = t + rand(600, 1100);
            if (hops === total) this.setMood(pick(['happy', 'curious', 'neutral']), 2000);
          }
          return spot;
        },
      };
    }

    // Floats somewhere and sometimes looks around.
    wander(now) {
      const spot = { x: this.clampX(rand(0, innerWidth)), y: this.clampY(rand(0, innerHeight)) };
      const arrive = now + 1600;
      const around = Math.random() < 0.5 && [{ x: spot.x - 200, y: spot.y }, { x: spot.x + 200, y: spot.y + rand(-60, 60) }];
      if (Math.random() < 0.2) this.setMood('curious', 2000);
      return {
        kind: 'wander', pull: 1.8, until: now + rand(3000, 6000),
        target: () => spot,
        look: (t) => (around && t > arrive ? around[Math.floor((t - arrive) / 700) % 2] : null),
      };
    }

    // Stays put and watches the cursor.
    watch(now) {
      const base = { ...this.pos };
      if (Math.random() < 0.35) this.setMood('suspicious', 2000);
      return { kind: 'watch', pull: 3, until: now + rand(2000, 3500), target: () => base };
    }

    // Nothing moving for a while: falls asleep, z's floating up.
    doze(now) {
      this.setMood('sleepy');
      const base = { ...this.pos };
      let n = 0;
      const snore = () => {
        const z = document.createElement('span');
        z.className = 'zzz';
        z.textContent = ['z', 'Z', 'z'][n % 3];
        z.style.setProperty('--zs', ['10px', '13px', '11px'][n++ % 3]);
        z.style.setProperty('--zx', `${rand(12, 26).toFixed(0)}px`);
        z.addEventListener('animationend', () => z.remove());
        this.el.appendChild(z);
      };
      snore();
      const timer = setInterval(snore, 950);
      return {
        kind: 'doze', pull: 1, until: now + 60000,
        target: () => (this.mode === 'home' ? this.homeSpot() : base),
        look: () => ({ x: this.pos.x, y: this.pos.y + 100 }),
        end: () => { clearInterval(timer); this.el.querySelectorAll('.zzz').forEach((z) => z.remove()); },
      };
    }

    // Hops away from the cursor, startled, then a bit cross.
    flee(now, c) {
      const len = Math.hypot(this.pos.x - c.x, this.pos.y - c.y) || 1;
      const away = { x: this.clampX(this.pos.x + ((this.pos.x - c.x) / len) * 130), y: this.clampY(this.pos.y + ((this.pos.y - c.y) / len) * 90) };
      this.setMood('surprised', 600, ['grumpy', 1600]);
      return { kind: 'flee', pull: 9, until: now + 1200, target: () => away };
    }
  }

  new Buddy($('.hero .home'), matchMedia('(prefers-reduced-motion: reduce)').matches);

  listen('settings-changed', load);
  load();
})();
