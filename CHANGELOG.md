# Changelog

What changed in each version. The section of a version is also the text of its GitHub release.

## 0.5.0 — 2026-09-30

### Talk to Kys

- **Kys's page has an input**, in the island (the little Kys next to the gear) and in the Kys tab of the settings. It answers in a bubble, and its face follows along. Talking to it earns a credit (10 a day).
- **Simple brain**, the default: it understands commands ("next song", "pause", "volume 30", "louder", "mute"), questions ("what time is it?", "what's playing?", "are you hungry?") and a bit of small talk, in English and French. Nothing to download, nothing running.
- **Light and Smart brains**, an option (settings, Kys tab, Brain): a small AI running on your PC, to really chat. **Light** (Qwen3 1.7B, 1.1 GB) answers in about a second; **Smart** (Qwen3 4B, 2.5 GB) takes about three and is much better company, with a real personality and a memory of the conversation. Download the one you want from the settings. It starts loading as soon as you click the input, and is freed a minute after you stop talking. Nothing leaves your PC. Commands still go through the simple brain: instant and reliable.
- **Emotions**: each answer comes with an emotion (happy, curious, surprised, suspicious, grumpy, worried, sleepy, sad), shown by Kys's own eyes: brows and eyelids on the face of its page, on the buddy of the settings, and on the island itself, where Kys drops in to show it when you talk to it from the settings. Be mean to it and its joy goes down.
- When Kys drops into the island, the time and the date now tip into a V around it.
- The installer includes llama.cpp, which runs the model with the best instructions your processor has (6 MB installer instead of 4.7 MB).

## 0.4.1 — 2026-09-30

- Fixed: on Kys's page in the expanded island, the buttons (give, play, wear) and the shop tiles had lost their look.
- A brand new README, with screenshots.

## 0.4.0 — 2026-09-30

### Kys, the eyes as a pet

The eyes have a name now: **Kys**. It has a belly and a joy gauge, which go down slowly while Kysland runs (never while the PC is off).

- **Credits ✦**, each capped per day: it peeks into the island (+1), you catch it while it peeks by coming slowly and clicking its eyes (+5), you make it dizzy (+2), it comes back from being thrown out (+3), you poke it while it roams (+1), time together (+1 every 10 minutes), and a daily bonus of 10, plus 2 per day in a row. A little "+N ✦" floats away from it.
- **Shop**: cookie, apple, candy and cake to feed it (the food drops onto it and it munches), a ball to play with, and a bow, a cap, glasses or a crown to wear.
- **Moods**: hungry, it peeks in twice as often with a cookie next to its eyes; starving or miserable, it looks sad.
- **Its page**: click the little Kys next to the gear in the expanded island, or open the **Kys** tab of the settings window (menu **Kys…**, or `kysland.exe --kys`).

## 0.3.5 — 2026-09-30

- **Peeking eyes**: now and then, the eyes drop in from the top into the middle of the resting island and knock the time and the date down and askew. Rush at them and they shoot back up and stay away for a while (option "peek", on by default).
- **Volume slider**: dragging it past the island no longer closes the island mid-drag, and the slider always goes back to the actual volume afterwards.
- **Updates**: the installer now waits until Kysland has really quit before replacing it (an update could be left half done).

## 0.3.4 — 2026-09-30

- **Dizzy**: circle the mouse around the eyes and they get dizzy: rolling eyes, little stars circling them, then a shake of the head.
- Back in the island after being thrown out, the eyes frown and squint to see where they are.

## 0.3.2 — 2026-09-30

- Fixed: the settings window opened from the island's gear stayed blank white and couldn't be closed.

## 0.3.1 — 2026-09-30

- **Auto-hide** (optional): the island tucks itself away while the mouse is far from it or on another screen, and comes back as the mouse gets near. Notifications and events still show.

## 0.3.0 — 2026-09-30

- **Settings window**: all the options with more room (screens, island, hiding from the cursor, features, advanced), with a little companion that follows you as you scroll. Open it from the menu, the gear of the expanded island, a click on the tray icon, or `kysland.exe --settings`.
- **Screens**: show the island on the main screen, on all of them, or on the ones you pick.
- **Hiding from the cursor**: approach the island slowly and it tucks itself into the screen edge to let you click behind it, with two little eyes watching the cursor. Stay close and it grows, and the eyes come alive: they explore, circle, come next to the cursor, doze off (Zzz), get thrown out in a drop of island and come back dizzy.
- **Outline**: a thin border keeps the black island visible over dark backgrounds.
- **Languages**: English and French, following Windows or picked in the menu.
- Fixed: the volume keys controlled the wrong device after a headset connected.

## 0.2.1 — 2026-09-27

- Fixed the build of the installer on GitHub.

## 0.2.0 — 2026-09-27

- Claude usage in the expanded island, a calendar on the date, themes and taskbar hiding removed.
