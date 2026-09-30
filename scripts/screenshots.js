// README screenshots: renders the island and the settings window with sample data
// (docs/screenshots) in headless Chrome and saves the images in docs/images. No dependency: it
// drives Chrome through the DevTools protocol with Node's own WebSocket (Node 22+).
// Usage: npm run screenshots [name...]   (CHROME=path\to\chrome.exe to pick the browser)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs', 'images');
const SHOTS = [
  { name: 'island', page: 'island.html', scene: 'compact' },
  { name: 'expanded', page: 'island.html', scene: 'expanded' },
  { name: 'notification', page: 'island.html', scene: 'notification' },
  { name: 'kys-page', page: 'island.html', scene: 'kys' },
  { name: 'kys-eating', page: 'island.html', scene: 'eat' },
  { name: 'hiding', page: 'island.html', scene: 'hiding' },
  { name: 'roaming', page: 'island.html', scene: 'roaming' },
  { name: 'settings', page: 'settings.html', scene: 'settings', viewport: [600, 1000] },
  { name: 'settings-kys', page: 'settings.html', scene: 'kys', hash: 'kys', viewport: [600, 1000] },
];

function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome or Edge not found (set CHROME=path\\to\\chrome.exe)');
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tiny DevTools protocol client over the page's WebSocket. */
async function connect(port) {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not listening yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
  return { ws, send, evaluate };
}

async function main() {
  const only = process.argv.slice(2);
  const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  fs.mkdirSync(out, { recursive: true });
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kysland-shots-'));
  const chrome = spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--allow-file-access-from-files', '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  try {
    cdp = await connect(port);
    for (const shot of shots) {
      const [width, height] = shot.viewport || [1000, 580];
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
      const url = pathToFileURL(path.join(root, 'docs', 'screenshots', shot.page));
      url.search = `?scene=${shot.scene}`;
      if (shot.hash) url.hash = shot.hash;
      await cdp.send('Page.navigate', { url: url.href });
      let ready = false;
      for (let i = 0; i < 150 && !ready; i++) {
        await sleep(100);
        ready = await cdp.evaluate('window.demoReady === true').catch(() => false);
      }
      if (!ready) throw new Error(`${shot.name}: the page never got ready`);
      const clip = await cdp.evaluate('window.demoClip');
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      });
      fs.writeFileSync(path.join(out, `${shot.name}.png`), Buffer.from(data, 'base64'));
      console.log(`✓ docs/images/${shot.name}.png`);
    }
  } finally {
    cdp?.ws.close();
    chrome.kill();
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
