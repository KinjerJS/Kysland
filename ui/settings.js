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
    'dodge-roam': true, 'dodge-roam-delay': 20, notifications: true, 'hide-windows-osd': true, claude: false,
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

  // The little island in the header watches the cursor and blinks now and then.
  const eyes = $('.hero .eyes');
  document.addEventListener('mousemove', (e) => {
    const r = eyes.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy) || 1, k = Math.min(1, len / 120);
    eyes.style.setProperty('--gx', `${((dx / len) * k * 6).toFixed(2)}px`);
    eyes.style.setProperty('--gy', `${((dy / len) * k * 4).toFixed(2)}px`);
  });
  (function blink() {
    setTimeout(() => {
      eyes.classList.add('blink');
      setTimeout(() => eyes.classList.remove('blink'), 120);
      blink();
    }, 2000 + Math.random() * 3500);
  })();

  listen('settings-changed', load);
  load();
})();
