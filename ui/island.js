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
      this.el.style.width = `${this.current.offsetWidth}px`;
      this.el.style.height = `${this.current.offsetHeight}px`;
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
      notifications: true,           // Windows notifications in the island
      claude: false,                 // Claude plan usage (if Claude Code is installed)
      'notification-duration': 6,    // seconds
      transients: { volume: true, media: true, battery: true, network: true, workspace: true },
    },

    init(m) {
      m.el.remove(); // the island lives outside the bar, stuck to the edge
      if (m.conf.monitor === 'primary' && !state.monitor.primary) return;
      const S = (m.island = {
        notch: new Notch(), expanded: false, transient: null, transientTimer: 0,
        data: { ...state.data }, pausedAt: 0, tint: null, tintKey: null, workspace: null, dragging: false,
        queue: [], notif: null, notifTimer: 0, claudeOn: m.conf.claude === true, unread: 0, page: 'main', history: null,
      });
      const notch = S.notch.el;
      applyOutline(m, state.backdropDark);
      let enterT = 0, leaveT = 0;
      if (m.conf['expand-on-hover']) {
        notch.addEventListener('mouseenter', () => {
          clearTimeout(leaveT);
          if (S.notif) return clearTimeout(S.notifTimer); // reading the notification: pause
          enterT = setTimeout(() => setExpanded(m, true), m.conf['hover-delay']);
        });
        notch.addEventListener('mouseleave', () => {
          clearTimeout(enterT);
          if (S.notif) return startNotifTimer(m, 2500);
          leaveT = setTimeout(() => setExpanded(m, false), m.conf['collapse-delay']);
        });
      }
      notch.addEventListener('click', (e) => {
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
        if (e.target.closest('input, .n-history')) return; // the history scrolls, not the volume
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
        if (!S.notif && !S.expanded) showNextNotif(m);
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

  function setExpanded(m, v) {
    const S = m.island;
    if (S.expanded === v) return;
    S.expanded = v;
    if (!v) S.page = 'main';
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
    if (S.expanded) return; // the expanded view already shows everything
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
    if (!S) return;
    S.notch.show(S.expanded ? expandedView(m) : S.notif || S.transient || compactView(m));
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
    const md = S.data.media?.has ? S.data.media : null;
    const now = dayjs();
    return {
      key: `expanded|${md ? 'media' : 'none'}|${claudeState(S)}`,
      size: 'expanded',
      html: `<div class="n-expanded">
        <div class="n-head"><span class="n-date-long" data-morph="date"></span><div class="n-head-right">
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
        range.addEventListener('pointerdown', () => { S.dragging = true; });
        range.addEventListener('pointerup', () => { S.dragging = false; });
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
          if (!S.dragging) {
            el.querySelector('.n-vol input').value = d.audio.volume;
            el.querySelector('.n-vol b').textContent = d.audio.volume;
          }
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
