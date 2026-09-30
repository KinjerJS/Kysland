'use strict';
// Stand-in for Tauri in the README screenshots: the real island and settings pages run in headless
// Chrome (scripts/screenshots.js) with sample data instead of the engine's. `window.demo.emit`
// plays the engine's events; `?scene=` picks what the page shows (see scenes.js).
(() => {
  const now = Date.now();
  const handlers = {};
  const scene = new URLSearchParams(location.search).get('scene') || 'compact';

  // Album art: a gradient with a record, as an SVG.
  const cover = 'data:image/svg+xml,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>"
    + "<stop offset='0' stop-color='#ff7eb3'/><stop offset='.55' stop-color='#7a5cff'/><stop offset='1' stop-color='#2dd4ff'/></linearGradient></defs>"
    + "<rect width='120' height='120' fill='url(#g)'/><circle cx='60' cy='60' r='30' fill='none' stroke='#fff' stroke-opacity='.85' stroke-width='3'/>"
    + "<circle cx='60' cy='60' r='6' fill='#fff'/></svg>");

  const kys = {
    credits: 142, food: 64, joy: 88, streak: 4, canPlay: true,
    inventory: { cookie: 3, cake: 1 }, owned: ['ball', 'bow', 'crown'], wearing: 'crown',
    items: [
      { id: 'cookie', price: 5, kind: 'food', food: 15, joy: 0 },
      { id: 'apple', price: 8, kind: 'food', food: 20, joy: 5 },
      { id: 'candy', price: 6, kind: 'food', food: 5, joy: 15 },
      { id: 'cake', price: 20, kind: 'food', food: 50, joy: 20 },
      { id: 'ball', price: 60, kind: 'toy' },
      { id: 'bow', price: 50, kind: 'wear' },
      { id: 'cap', price: 80, kind: 'wear' },
      { id: 'glasses', price: 120, kind: 'wear' },
      { id: 'crown', price: 200, kind: 'wear' },
    ],
    sources: [
      { id: 'peek', credits: 1, cap: 15, today: 7 },
      { id: 'catch', credits: 5, cap: 10, today: 2 },
      { id: 'dizzy', credits: 2, cap: 10, today: 3 },
      { id: 'flight', credits: 3, cap: 5, today: 1 },
      { id: 'poke', credits: 1, cap: 10, today: 4 },
      { id: 'talk', credits: 1, cap: 10, today: 5 },
      { id: 'time', credits: 1, cap: 30, today: 12 },
    ],
  };

  // Kys's answers (brain.rs), by what it's told.
  const replies = [
    [/next|skip/i, { say: 'Next one coming up! ⏭️ This one’s a banger.', mood: 'happy' }],
    [/hungry|eat/i, { say: 'A little… that cake looks amazing though. 🍰', mood: 'curious' }],
    [/crown/i, { say: 'Right? I feel like the king of the island. 👑', mood: 'happy' }],
  ];
  const brain = {
    available: true, downloading: null, loaded: null,
    models: [{ id: 'light', size: 1107409472, ready: false }, { id: 'smart', size: 2497281120, ready: true }],
  };

  const responses = {
    init: () => ({
      config: {
        position: 'top', height: 32, 'popup-space': 420, monitors: 'primary',
        'modules-left': [], 'modules-center': ['island'], 'modules-right': [],
        island: { claude: true, 'dodge-roam-delay': scene === 'roaming' ? 0.3 : 20 }, // grows at once for that scene
      },
      lang: 'en',
      styles: { style: '../../defaults/style.css', v: 0 },
      monitor: { index: 0, primary: true, scaleFactor: 1, physical: { x: 0, y: 0, width: 1920, height: 1080 } },
      glaze: { connected: false, monitors: [] },
      near: true,
      backdropDark: false,
      data: {
        media: {
          has: true, playing: true, title: 'Midnight City', artist: 'M83', app: 'Spotify.exe', thumb: cover,
          key: 'demo', position: 84, duration: 243, at: now,
        },
        audio: { volume: 62, muted: false },
        cpu: { usage: 14 },
        memory: { percentage: 47 },
        network: { connected: true, type: 'wifi', essid: 'Home', down: '2.4 MB/s', up: '180 KB/s' },
        battery: { present: false },
        claude: {
          ok: true, plan: 'pro', account: 'yo****me@example.com', fetchedAt: now - 120000,
          session: { percent: 34, resetsAt: now + 3.2 * 3600e3 },
          week: { percent: 21, resetsAt: now + 4 * 86400e3 },
        },
      },
    }),
    kys_state: () => kys,
    kys_talk: async ({ text }) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const reply = replies.find(([re]) => re.test(text))?.[1] || { say: 'Hehe. 👀', mood: 'happy' };
      setTimeout(() => window.demo.emit('kys-mood', { mood: reply.mood })); // as the engine does
      return { ...reply, brain: 'smart', ms: 2400, action: 'None' };
    },
    kys_brain: () => brain,
    notifications: () => [],
    settings_state: () => ({
      lang: 'en', version: '0.5.0', language: 'auto', monitors: 'primary', hideOnFullscreen: true, autostart: true,
      claudeInstalled: true, island: { claude: true, 'kys-brain': 'smart' }, brain,
      screens: [
        { index: 0, name: 'DELL U2723QE', width: 3840, height: 2160, primary: true },
        { index: 1, name: 'LG ULTRAGEAR', width: 2560, height: 1440, primary: false },
      ],
    }),
  };

  window.demo = {
    scene,
    emit(name, payload) { (handlers[name] || []).forEach((cb) => cb({ event: name, payload })); },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    /** Done: what to capture (CSS pixels), or the whole page. */
    ready(clip = null) {
      window.demoClip = clip;
      window.demoReady = true;
    },
  };

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => (responses[cmd] ? responses[cmd](args) : null),
      convertFileSrc: (file) => file,
    },
    event: {
      listen: async (name, cb) => {
        (handlers[name] ||= []).push(cb);
        return () => {};
      },
    },
    webviewWindow: { getCurrentWebviewWindow: () => ({ label: 'demo' }) },
  };
})();
