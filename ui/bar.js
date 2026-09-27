'use strict';
const api = window.kysland;
const { t } = window.i18n;

let state = { config: null, data: {}, glaze: { connected: false, monitors: [] }, monitor: null };
let modules = [];

// --- Helpers --------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const typeOf = (name) => name.split(/[/#]/)[0];

function lookup(values, key) {
  if (typeof values === 'function') return values(key);
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), values);
}

// Keys whose value is already HTML (rendered icons).
const RAW_KEYS = new Set(['icon']);

// Format mini-language:  {key}  {i:lucide-icon-name}  {}=text  \n=line break
function tpl(format, values = {}) {
  if (format == null || format === false) return '';
  return String(format).replace(/\{([^{}]*)\}/g, (_, key) => {
    if (key.startsWith('i:')) return `<i class="icon icon-${esc(key.slice(2).trim())}"></i>`;
    const v = lookup(values, key === '' ? 'text' : key);
    if (v == null) return '';
    return RAW_KEYS.has(key) ? String(v) : esc(v);
  }).replace(/\n/g, '<br>');
}

// format-icons: array (picked from the percentage), object (per state) or string.
function pickIcon(icons, percent, key) {
  if (icons == null) return '';
  if (typeof icons === 'string') return icons;
  if (Array.isArray(icons)) {
    if (!icons.length) return '';
    return icons[clamp(Math.floor(((percent ?? 0) / 100) * icons.length), 0, icons.length - 1)];
  }
  const v = icons[key] ?? icons.default;
  return Array.isArray(v) ? pickIcon(v, percent) : v ?? '';
}

// states: { "warning": 70, "critical": 90 } → CSS class. inverse = "downward" thresholds (battery).
function stateClass(value, states, inverse = false) {
  if (!states || value == null) return null;
  const entries = Object.entries(states).sort((a, b) => (inverse ? a[1] - b[1] : b[1] - a[1]));
  for (const [name, threshold] of entries) if (inverse ? value <= threshold : value >= threshold) return name;
  return null;
}

// "@action arg" → internal action, otherwise a shell command.
function runCommand(cmd, module) {
  if (cmd.startsWith('@')) {
    const [action, ...rest] = cmd.slice(1).split(' ');
    const arg = rest.join(' ') || undefined;
    if (action === 'toggle') { module.alt = !module.alt; module.render(); return; }
    if (action === 'audio' && /^\d+$/.test(arg || '')) return api.action('audio', Number(arg));
    return api.action(action, arg, module?.conf['scroll-step']);
  }
  api.action('exec', cmd);
}

// --- Popup (rich tooltip / menu) ----------------------------------------------------
const popup = {
  el: document.getElementById('popup'),
  owner: null,
  content: null,
  showTimer: 0,
  hideTimer: 0,

  open(module, content) {
    if (!content) return this.close();
    clearTimeout(this.hideTimer);
    this.owner = module;
    this.content = content;
    this.el.className = content.className || '';
    this.el.innerHTML = content.html;
    content.mount?.(this.el);
    this.place();
    this.el.classList.add('visible');
  },

  // Re-render when the module's data changes while the popup is open.
  refresh() {
    const m = this.owner;
    if (!m) return;
    if (this.content?.update) return this.content.update(this.el);
    if (this.content?.interactive) return;
    const next = m.popupContent();
    if (!next) return this.close();
    this.content = next;
    this.el.innerHTML = next.html;
    this.place();
  },

  place() {
    const r = this.owner.el.getBoundingClientRect();
    const w = this.el.offsetWidth;
    this.el.style.left = `${clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8)}px`;
  },

  close() {
    clearTimeout(this.showTimer);
    this.owner = null;
    this.content = null;
    this.el.classList.remove('visible');
  },

  hover(module, entering) {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    if (entering) {
      if (this.owner === module) return;
      const delay = this.owner ? 0 : 300;
      this.showTimer = setTimeout(() => this.open(module, module.popupContent()), delay);
    } else {
      this.hideTimer = setTimeout(() => this.close(), this.content?.interactive ? 300 : 60);
    }
  },
};
popup.el.addEventListener('mouseenter', () => clearTimeout(popup.hideTimer));
popup.el.addEventListener('mouseleave', () => { popup.hideTimer = setTimeout(() => popup.close(), 250); });

// The window also covers the popup area, so clicks outside the bar must go through.
// Clickable areas are sent to the engine, which makes the window clickable above them only:
// anywhere else, clicks reach the windows below.
const HIT_SELECTOR = '.modules-left, .modules-center, .modules-right, #popup.visible, .notch';
let lastHitRects = '';
function reportHitRects() {
  const rects = [...document.querySelectorAll(HIT_SELECTOR)]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: Math.floor(r.left), y: Math.floor(r.top), w: Math.ceil(r.width), h: Math.ceil(r.height) }));
  const json = JSON.stringify(rects);
  if (json !== lastHitRects) { lastHitRects = json; api.setHitRects(rects); }
}
setInterval(reportHitRects, 100); // also follows animations (notch expanding, popups)

// Cursor exit detected by the engine: fire the "mouseleave" events the page missed.
api.on('pointer-left', () => {
  document.querySelectorAll('.module, .notch, #popup').forEach((el) => el.dispatchEvent(new MouseEvent('mouseleave')));
});

// --- Generic module --------------------------------------------------------------
class Module {
  constructor(name, conf, def) {
    this.name = name;
    this.type = typeOf(name);
    this.def = def;
    this.conf = { ...def.defaults, ...conf };
    this.alt = false;
    this.data = undefined;
    this.timers = [];
    this.dynClasses = [];
    this.tooltip = null;
    this.el = document.createElement('div');
    this.el.className = `module ${this.type}`;
    this.el.id = name.replace(/[^\w-]+/g, '-');
    this.bind();
  }

  bind() {
    const el = this.el;
    el.addEventListener('click', (e) => this.trigger('on-click', e));
    el.addEventListener('auxclick', (e) => e.button === 1 && this.trigger('on-click-middle', e));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.trigger('on-click-right', e); });
    let lastWheel = 0;
    el.addEventListener('wheel', (e) => {
      const now = Date.now();
      if (now - lastWheel < 60) return;
      lastWheel = now;
      this.trigger(e.deltaY < 0 ? 'on-scroll-up' : 'on-scroll-down', e);
    }, { passive: true });
    el.addEventListener('mouseenter', () => popup.hover(this, true));
    el.addEventListener('mouseleave', () => popup.hover(this, false));
  }

  trigger(evt, e) {
    const cmd = this.conf[evt];
    if (typeof cmd === 'string' && cmd) {
      runCommand(cmd, this);
      this.def.afterCommand?.(this);
      return;
    }
    const fn = this.def.actions?.[evt];
    if (fn) return fn(this, e);
    if (evt === 'on-click' && this.conf['format-alt']) { this.alt = !this.alt; this.render(); }
  }

  every(seconds, fn) {
    fn();
    this.timers.push(setInterval(fn, seconds * 1000));
  }

  fmt(key = 'format') {
    if (key === 'format' && this.alt && this.conf['format-alt'] != null) return this.conf['format-alt'];
    return this.conf[key] ?? this.conf.format;
  }

  tooltipFrom(values) {
    const format = this.conf['tooltip-format'];
    return this.conf.tooltip === false || !format ? null : tpl(format, values);
  }

  set({ html = '', tooltip = null, classes = [], hidden = false }) {
    if (html !== this.html) { this.el.innerHTML = html; this.html = html; }
    this.el.classList.toggle('hidden', hidden || html === '');
    if (this.dynClasses.length) this.el.classList.remove(...this.dynClasses);
    this.dynClasses = classes.filter(Boolean);
    if (this.dynClasses.length) this.el.classList.add(...this.dynClasses);
    this.tooltip = this.conf.tooltip === false ? null : tooltip;
    if (popup.owner === this) popup.refresh();
  }

  popupContent() {
    if (this.conf.tooltip === false) return null;
    if (this.def.popup) return this.def.popup(this);
    return this.tooltip ? { html: this.tooltip } : null;
  }

  render() {
    try {
      this.def.render(this, this.data);
    } catch (err) {
      console.error(this.name, err);
      this.set({ html: `<span class="module-error">${esc(this.name)}</span>`, tooltip: esc(err.message), classes: ['error'] });
    }
  }

  update(data) {
    this.data = data;
    this.render();
  }
}

// --- Module definitions ------------------------------------------------------------
function myGlazeMonitor() {
  const p = state.monitor.physical;
  let best = null, bestDist = Infinity;
  for (const m of state.glaze.monitors || []) {
    const d = Math.abs(m.x - p.x) + Math.abs(m.y - p.y);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return best;
}

function calendarHtml(month) {
  const today = dayjs();
  const start = month.startOf('month');
  const offset = (start.day() + 6) % 7; // weeks start on Monday
  let cells = t('bar.weekdays').split(',').map((d) => `<span class="wd">${d}</span>`).join('');
  cells += '<span></span>'.repeat(offset);
  for (let d = 1; d <= month.daysInMonth(); d++) {
    const date = start.date(d);
    const cls = ['day', date.isSame(today, 'day') && 'today', (date.day() === 0 || date.day() === 6) && 'weekend'].filter(Boolean).join(' ');
    cells += `<span class="${cls}">${d}</span>`;
  }
  return `<div class="cal-head"><span class="cal-nav" data-nav="-1"><i class="icon icon-chevron-left"></i></span>`
    + `<span class="cal-title">${esc(month.format('MMMM YYYY'))}</span>`
    + `<span class="cal-nav" data-nav="1"><i class="icon icon-chevron-right"></i></span></div>`
    + `<div class="cal-grid">${cells}</div>`;
}

const POWER_ITEMS = [
  { id: 'lock', icon: 'lock' },
  { id: 'sleep', icon: 'moon' },
  { id: 'logout', icon: 'log-out', confirm: true },
  { id: 'restart', icon: 'rotate-ccw', confirm: true },
  { id: 'shutdown', icon: 'power', confirm: true },
];
const powerLabel = (id) => t(`bar.power.${id}`);

const TYPES = {
  clock: {
    defaults: {
      format: '{:HH:mm}',
      'format-alt': '{i:calendar} {:dddd D MMMM YYYY}',
      interval: 1,
      calendar: true,
    },
    init(m) { m.every(m.conf.interval, () => m.render()); },
    render(m) {
      const now = dayjs();
      const values = (key) => (key.startsWith(':') ? now.format(key.slice(1)) : undefined);
      m.set({ html: tpl(m.fmt(), values), tooltip: m.tooltipFrom(values) });
    },
    popup(m) {
      if (!m.conf.calendar) return m.tooltip ? { html: m.tooltip } : null;
      let month = dayjs();
      return {
        interactive: true,
        html: calendarHtml(month),
        mount(el) {
          el.onclick = (e) => {
            const nav = e.target.closest('[data-nav]');
            if (!nav) return;
            month = month.add(Number(nav.dataset.nav), 'month');
            el.innerHTML = calendarHtml(month);
          };
        },
        update() {},
      };
    },
  },

  workspaces: {
    topic: 'glaze',
    defaults: {
      format: '{icon}',
      'format-icons': {},
      'format-disconnected': '{i:layout-grid}',
      'persistent-workspaces': [],
      'all-outputs': false,
      'on-scroll-up': '@glaze focus --prev-active-workspace-on-monitor',
      'on-scroll-down': '@glaze focus --next-active-workspace-on-monitor',
    },
    render(m) {
      const g = state.glaze;
      if (!g?.connected) {
        return m.set({
          html: tpl(m.conf['format-disconnected']),
          tooltip: `${esc(t('bar.glaze_missing'))}<br><span style="opacity:.6">${esc(t('bar.glaze_open_page'))}</span>`,
          classes: ['disconnected'],
        });
      }
      const list = m.conf['all-outputs'] ? g.monitors.flatMap((x) => x.workspaces) : myGlazeMonitor()?.workspaces || [];
      const byName = new Map(list.map((w) => [w.name, w]));
      for (const name of (m.conf['persistent-workspaces'] || []).map(String)) {
        if (!byName.has(name)) byName.set(name, { name, displayName: name, focused: false, visible: false, windows: [], persistent: true });
      }
      const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const icons = m.conf['format-icons'] || {};
      const html = all.map((w, i) => {
        const key = w.focused ? 'focused' : w.visible ? 'visible' : w.windows.length ? 'default' : 'empty';
        const vals = { name: w.displayName, id: w.name, index: i + 1, windows: w.windows.length };
        const icon = tpl(icons[w.name] ?? icons[key] ?? icons.default ?? '{name}', vals);
        const cls = ['ws', w.focused && 'focused', w.visible && 'visible', !w.windows.length && 'empty', w.persistent && 'persistent'].filter(Boolean).join(' ');
        return `<button class="${cls}" data-ws="${esc(w.name)}">${tpl(m.fmt(), { ...vals, icon })}</button>`;
      }).join('');
      m.set({ html, tooltip: null, classes: [!all.length && 'empty'] });
    },
    actions: {
      'on-click': (m, e) => {
        if (!state.glaze.connected) return api.action('open', 'https://github.com/glzr-io/glazewm');
        const b = e.target.closest('[data-ws]');
        if (b) api.action('glaze', `focus --workspace ${b.dataset.ws}`);
      },
    },
  },

  mode: {
    topic: 'glaze',
    defaults: { format: '{i:keyboard} {mode}' },
    render(m) {
      const modes = state.glaze.bindingModes || [];
      m.set({ html: modes.length ? tpl(m.fmt(), { mode: modes.join(' · ') }) : '', hidden: !modes.length });
    },
  },

  window: {
    topic: 'window',
    defaults: { format: '{title}', 'max-length': 60, icon: true, rewrite: {}, 'tooltip-format': '{title}\n{app}' },
    render(m, d) {
      if (!d || d.empty) return m.set({ html: '', hidden: true });
      let title = d.title;
      for (const [re, rep] of Object.entries(m.conf.rewrite || {})) {
        const r = new RegExp(re);
        if (r.test(title)) { title = title.replace(r, rep); break; }
      }
      const max = m.conf['max-length'];
      if (max && title.length > max) title = `${title.slice(0, max - 1)}…`;
      const values = { title, app: d.app };
      const icon = m.conf.icon && d.icon ? `<img class="app-icon" src="${d.icon}">` : '';
      m.set({ html: `${icon}<span class="label">${tpl(m.fmt(), values)}</span>`, tooltip: m.tooltipFrom({ title: d.title, app: d.app }) });
    },
  },

  cpu: {
    topic: 'cpu',
    defaults: { format: '{i:cpu} {usage}%', states: { warning: 70, critical: 90 }, get 'tooltip-format'() { return t('bar.cpu_tooltip'); } },
    render(m, d) {
      if (!d) return;
      m.set({ html: tpl(m.fmt(), d), tooltip: m.tooltipFrom(d), classes: [stateClass(d.usage, m.conf.states)] });
    },
  },

  memory: {
    topic: 'memory',
    defaults: { format: '{i:memory-stick} {percentage}%', states: { warning: 75, critical: 90 }, get 'tooltip-format'() { return t('bar.memory_tooltip'); } },
    render(m, d) {
      if (!d) return;
      m.set({ html: tpl(m.fmt(), d), tooltip: m.tooltipFrom(d), classes: [stateClass(d.percentage, m.conf.states)] });
    },
  },

  disk: {
    topic: 'disk',
    defaults: {
      get format() { return `{i:hard-drive} ${t('bar.disk_free')}`; },
      path: 'C',
      states: { warning: 85, critical: 95 },
      get 'tooltip-format'() { return t('bar.disk_tooltip'); },
    },
    render(m, d) {
      const key = String(m.conf.path).toUpperCase()[0];
      const disk = d?.[key];
      if (!disk) return m.set({ html: '', hidden: true });
      const values = { ...disk, path: `${key}:` };
      m.set({ html: tpl(m.fmt(), values), tooltip: m.tooltipFrom(values), classes: [stateClass(disk.percentage, m.conf.states)] });
    },
  },

  battery: {
    topic: 'battery',
    defaults: {
      format: '{icon} {capacity}%',
      'format-charging': '{i:battery-charging} {capacity}%',
      'format-icons': ['{i:battery-warning}', '{i:battery-low}', '{i:battery-medium}', '{i:battery-full}'],
      states: { warning: 30, critical: 15 },
      'tooltip-format': '{capacity}% {time}',
    },
    render(m, d) {
      if (!d || !d.present) return m.set({ html: '', hidden: true });
      const values = { ...d, icon: tpl(pickIcon(m.conf['format-icons'], d.capacity)) };
      const key = d.charging ? 'format-charging' : d.plugged ? 'format-plugged' : 'format';
      m.set({
        html: tpl(m.fmt(key), values),
        tooltip: m.tooltipFrom(values),
        classes: [d.charging && 'charging', d.plugged && 'plugged', !d.charging && stateClass(d.capacity, m.conf.states, true)],
      });
    },
  },

  network: {
    topic: 'network',
    defaults: {
      'format-wifi': '{icon} {essid}',
      'format-ethernet': '{i:ethernet-port} {down}',
      get 'format-disconnected'() { return `{i:wifi-off} ${t('bar.disconnected')}`; },
      'format-icons': ['{i:wifi-zero}', '{i:wifi-low}', '{i:wifi-high}', '{i:wifi}'],
      'tooltip-format': '{ifname} · {ipaddr}\n{i:arrow-down} {down}   {i:arrow-up} {up}',
      'on-click-right': '@open ms-settings:network',
    },
    render(m, d) {
      if (!d) return;
      const values = { ...d, icon: tpl(pickIcon(m.conf['format-icons'], d.signal ?? 100)) };
      const key = !d.connected ? 'format-disconnected' : d.type === 'wifi' ? 'format-wifi' : 'format-ethernet';
      const fmt = m.alt && m.conf['format-alt'] ? m.conf['format-alt'] : m.conf[key] ?? m.conf.format;
      m.set({ html: tpl(fmt, values), tooltip: d.connected ? m.tooltipFrom(values) : null, classes: [d.connected ? d.type : 'disconnected'] });
    },
  },

  audio: {
    topic: 'audio',
    defaults: {
      format: '{icon} {volume}%',
      get 'format-muted'() { return `{i:volume-x} ${t('island.muted')}`; },
      'format-icons': ['{i:volume}', '{i:volume-1}', '{i:volume-2}'],
      'scroll-step': 5,
      'on-click': '@audio mute',
      'on-click-right': '@open ms-settings:sound',
      'on-scroll-up': '@audio up',
      'on-scroll-down': '@audio down',
      slider: true,
    },
    render(m, d) {
      if (!d) return;
      const values = { ...d, icon: tpl(pickIcon(m.conf['format-icons'], d.volume)) };
      m.set({ html: tpl(m.fmt(d.muted ? 'format-muted' : 'format'), values), tooltip: m.tooltipFrom(values), classes: [d.muted && 'muted'] });
    },
    popup(m) {
      if (!m.conf.slider || !m.data) return m.tooltip ? { html: m.tooltip } : null;
      let dragging = false;
      const icon = () => (m.data.muted ? 'volume-x' : 'volume-2');
      return {
        interactive: true,
        html: `<div class="slider-row"><i class="icon icon-${icon()}" data-mute style="cursor:pointer"></i>`
          + `<input type="range" min="0" max="100" value="${m.data.volume}"><span class="value">${m.data.volume}</span></div>`,
        mount(el) {
          const input = el.querySelector('input');
          input.addEventListener('pointerdown', () => { dragging = true; });
          input.addEventListener('pointerup', () => { dragging = false; });
          input.addEventListener('input', () => {
            el.querySelector('.value').textContent = input.value;
            api.action('audio', Number(input.value));
          });
          el.querySelector('[data-mute]').onclick = () => api.action('audio', 'mute');
        },
        update(el) {
          const input = el.querySelector('input');
          if (!input) return;
          if (!dragging) { input.value = m.data.volume; el.querySelector('.value').textContent = m.data.volume; }
          el.querySelector('[data-mute]').className = `icon icon-${icon()}`;
        },
      };
    },
  },

  launcher: {
    defaults: { format: '{i:layout-grid}', 'on-click': '@start-menu', get 'tooltip-format'() { return t('bar.start_menu'); } },
    render(m) { m.set({ html: tpl(m.fmt()), tooltip: m.tooltipFrom({}) }); },
  },

  media: {
    defaults: { format: '{i:skip-back}  {i:play}  {i:skip-forward}' },
    render(m) {
      const html = tpl(m.fmt())
        .replace('icon-skip-back"', 'icon-skip-back" data-media="prev"')
        .replace('icon-play"', 'icon-play" data-media="play-pause"')
        .replace('icon-skip-forward"', 'icon-skip-forward" data-media="next"');
      m.set({ html });
    },
    actions: {
      'on-click': (_m, e) => {
        const b = e.target.closest('[data-media]');
        if (b) api.action('media', b.dataset.media);
      },
    },
  },

  power: {
    defaults: { format: '{i:power}' },
    render(m) { m.set({ html: tpl(m.fmt()) }); },
    popup() { return null; },
    actions: {
      'on-click': (m) => {
        if (popup.owner === m) return popup.close();
        let pending = null;
        const items = (m.conf.items || POWER_ITEMS.map((i) => i.id)).map((id) => POWER_ITEMS.find((i) => i.id === id)).filter(Boolean);
        popup.open(m, {
          interactive: true,
          html: `<div class="menu">${items.map((i) => `<div class="menu-item" data-power="${i.id}"><i class="icon icon-${i.icon}"></i><span>${esc(powerLabel(i.id))}</span></div>`).join('')}</div>`,
          mount(el) {
            el.onclick = (e) => {
              const item = e.target.closest('[data-power]');
              if (!item) return;
              const def = POWER_ITEMS.find((i) => i.id === item.dataset.power);
              if (def.confirm && pending !== item) {
                el.querySelectorAll('.confirm').forEach((x) => { x.classList.remove('confirm'); x.lastChild.textContent = powerLabel(x.dataset.power); });
                pending = item;
                item.classList.add('confirm');
                item.lastChild.textContent = t('bar.power.confirm', { label: powerLabel(def.id) });
                return;
              }
              popup.close();
              api.action('power', def.id);
            };
          },
          update() {},
        });
      },
    },
  },

  custom: {
    defaults: { format: '{}', interval: 0, 'return-type': 'text' },
    init(m) {
      if (!m.conf.exec) return m.render();
      const exec = async () => {
        const { output } = await api.run(m.conf.exec);
        let data = { text: output };
        if (m.conf['return-type'] === 'json') {
          try { data = { text: '', ...JSON.parse(output) }; } catch { data = { text: output }; }
        }
        m.update(data);
      };
      m.exec = exec;
      if (m.conf.interval > 0) m.every(m.conf.interval, exec); else exec();
    },
    afterCommand(m) { if (m.exec) setTimeout(m.exec, 300); },
    render(m, d = { text: '' }) {
      const values = { ...d, icon: tpl(pickIcon(m.conf['format-icons'], d.percentage, d.alt)) };
      const html = m.conf.exec && !d.text && !d.alt ? '' : tpl(m.fmt(), values);
      const tooltip = d.tooltip != null ? esc(d.tooltip).replace(/\n/g, '<br>') : m.tooltipFrom(values);
      const cls = Array.isArray(d.class) ? d.class : [d.class];
      m.set({ html, tooltip, classes: [...cls, stateClass(d.percentage, m.conf.states)] });
    },
  },
};

// --- Building the bar ---------------------------------------------------------------
// The user's style.css, served through Tauri's "asset" protocol; v forces a reload.
function applyStyles({ style, v }) {
  document.getElementById('user-css').href = `${api.fileUrl(style)}?v=${v}`;
}

function build() {
  const cfg = state.config;
  for (const side of ['left', 'center', 'right']) {
    const container = document.querySelector(`.modules-${side}`);
    for (const name of cfg[`modules-${side}`] || []) {
      const def = TYPES[typeOf(name)];
      if (!def) {
        container.insertAdjacentHTML('beforeend', `<div class="module"><span class="module-error">${esc(t('bar.unknown_module', { name }))}</span></div>`);
        continue;
      }
      const m = new Module(name, cfg[name] || {}, def);
      container.appendChild(m.el);
      modules.push(m);
      if (def.init) def.init(m);
      else if (def.topic && def.topic !== 'glaze') m.update(state.data[def.topic]);
      else m.render();
    }
  }
}

async function boot() {
  const init = await api.init();
  if (!init) return;
  i18n.setLang(init.lang);
  state = { ...state, ...init, data: init.data || {} };
  const cfg = state.config;
  applyStyles(init.styles);
  document.documentElement.style.setProperty('--bar-height', `${cfg.height}px`);
  document.body.classList.add(`pos-${cfg.position}`, `monitor-${init.monitor.index}`, init.monitor.primary ? 'primary' : 'secondary');
  build();
}

api.on('data', (topic, data) => {
  state.data[topic] = data;
  for (const m of modules) {
    if (m.def.topic === topic) m.update(data);
    if (m.def.topics?.includes(topic)) m.def.onData(m, topic, data);
  }
});
api.on('glaze', (g) => {
  state.glaze = g;
  for (const m of modules) {
    if (m.def.topic === 'glaze') m.render();
    m.def.onGlaze?.(m, g);
  }
});
api.on('island', (msg) => modules.forEach((m) => m.def.onMessage?.(m, msg)));
api.on('style', applyStyles);
api.on('reload', () => location.reload());

// island.js (and other modules) register themselves in TYPES before boot.
document.addEventListener('DOMContentLoaded', boot);
