'use strict';
// What the island shows in each README screenshot (?scene=), played with the engine's events.
(async () => {
  const { scene, emit, wait, ready } = window.demo;
  const notch = () => document.querySelector('.notch');
  const rect = (el) => el.getBoundingClientRect();
  const center = (el) => { const r = rect(el); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  /** The island and some room around it. */
  const around = (w = 150, below = 70) => {
    const r = rect(notch());
    return { x: Math.max(0, r.left - w), y: 0, width: r.width + 2 * w, height: r.bottom + below };
  };

  await wait(1000); // boot, fonts, album art
  switch (scene) {
    case 'compact':
      return ready(around(220, 40));

    case 'expanded':
      notch().dispatchEvent(new MouseEvent('mouseenter'));
      await wait(1300);
      return ready(around(60, 40));

    case 'notification':
      emit('data', { topic: 'notification', data: {
        id: 1, nid: 1, app: 'Discord', title: 'Alex', body: 'Game tonight? I saved you a spot 🎮', at: Date.now(), icon: null,
      } });
      await wait(1100);
      return ready(around(80, 40));

    case 'kys': {
      notch().dispatchEvent(new MouseEvent('mouseenter'));
      await wait(700);
      document.querySelector('.n-kysbtn').click();
      await wait(1100);
      // A word with Kys, its answer in a bubble.
      const input = document.querySelector('.k-talk input');
      input.value = 'Can you skip to the next song?';
      input.form.requestSubmit();
      input.value = 'Are you hungry?';
      await wait(900);
      // A cookie from the inventory held out to it: its mouth opens.
      Element.prototype.setPointerCapture = () => {}; // no real pointer here
      const cookie = document.querySelector('[data-kys-item="cookie"]');
      const from = center(cookie), to = center(document.querySelector('.n-kys-face .mouth'));
      const at = (x, y) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true });
      cookie.dispatchEvent(new PointerEvent('pointerdown', at(from.x, from.y)));
      for (let i = 1; i <= 12; i++) {
        const u = i / 12;
        cookie.dispatchEvent(new PointerEvent('pointermove', at(from.x + (to.x + 34 - from.x) * u, from.y + (to.y + 26 - from.y) * u)));
        await wait(30);
      }
      await wait(300);
      return ready(around(60, 40));
    }

    case 'eat':
      emit('kys-feed', { item: 'cookie' });
      await wait(840); // the cookie about to land
      return ready(around(180, 60));

    case 'hiding':
      emit('dodge', { on: true });
      await wait(250);
      emit('gaze', { x: center(notch()).x + 110, y: 70 });
      await wait(250); // before it grows (roaming)
      return ready({ ...around(0, 0), x: center(notch()).x - 150, width: 300, height: 70 });

    case 'roaming': {
      emit('dodge', { on: true });
      await wait(1400);
      // Circling the cursor around the eyes: dizzy, stars.
      const c = center(document.querySelector('.notch-eyes'));
      for (let i = 0; i < 80; i++) {
        const a = (i / 80) * Math.PI * 2 * 3.5;
        emit('gaze', { x: c.x + Math.cos(a) * 70, y: c.y + Math.sin(a) * 70 });
        await wait(30);
      }
      await wait(300);
      return ready(around(160, 50));
    }

    default:
      return ready();
  }
})();
