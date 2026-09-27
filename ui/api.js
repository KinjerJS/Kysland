'use strict';
// Pont entre l'interface et le moteur Rust (commandes et événements Tauri).
// Même API que l'ancien preload d'Electron : bar.js et island.js n'ont presque rien à changer.
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
    setHitRects: (rects) => invoke('set_hit_rects', { rects }),
    fileUrl: (file) => convertFileSrc(file),
    // Les événements destinés à une seule fenêtre portent son label ("pointer-left").
    on: (channel, cb) => listen(channel, (e) => {
      const p = e.payload;
      if (p && typeof p === 'object' && p.label && p.label !== label) return;
      if (channel === 'data') cb(p.topic, p.data);
      else cb(p);
    }),
  };
})();
