'use strict';
// Bridge between the page and the Rust engine (Tauri commands and events).
// Same API as the old Electron preload, so bar.js and island.js barely had to change.
(() => {
  const { invoke, convertFileSrc } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const label = window.__TAURI__.webviewWindow.getCurrentWebviewWindow().label;

  window.kysland = {
    label,
    init: () => invoke('init'),
    run: (cmd) => invoke('run_command', { cmd }),
    notifications: () => invoke('notifications'),
    action: (name, arg, extra) => invoke('action', { name, arg: arg ?? null, extra: extra ?? null }),
    // Kys, the eyes as a pet (kys.rs).
    kys: {
      state: () => invoke('kys_state'),
      earn: (source) => invoke('kys_earn', { source }),
      buy: (item) => invoke('kys_buy', { item }),
      feed: (item) => invoke('kys_feed', { item }),
      wear: (item) => invoke('kys_wear', { item }),
      play: () => invoke('kys_play'),
    },
    setHitRects: (rects, notch, dodgeable, grab, watch) => invoke('set_hit_rects', {
      rects, notch: notch ?? null, dodgeable: !!dodgeable, grab: !!grab, watch: !!watch,
    }),
    fileUrl: (file) => convertFileSrc(file),
    // Events meant for a single window carry its label ("pointer-left").
    on: (channel, cb) => listen(channel, (e) => {
      const p = e.payload;
      if (p && typeof p === 'object' && p.label && p.label !== label) return;
      if (channel === 'data') cb(p.topic, p.data);
      else cb(p);
    }),
  };
})();
