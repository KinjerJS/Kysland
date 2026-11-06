# Changelog

What changed in each version. The section of a version is also the text of its GitHub release.

## 0.6.14 — 2026-11-06

- **Kys in glass follows the island's kind of glass** (settings → Island → Glass, or `"glass"`): **Frosted**, milky and well blurred; **Balanced**, clearer with brighter rims; **Crystal**, nearly clear, a bright rim, a glow inside its edge, a sheen on its top and sides splitting the light like a prism. Everywhere Kys shows: its button and its page in the island, running free on the screen, the settings' buddy. With Kys in glass and the classic theme, the Glass setting stays available, for Kys.

## 0.6.13 — 2026-11-06

- **Fixed: "new track" announced again and again on Netflix (and other Chrome videos) when nothing changed.** With KemHome on, a Chrome video is told by two sources with different titles (KemHome: "Netflix", Windows: "Accueil - Netflix"). KemHome sometimes says "no session" for a second, and each time the island handed over to Windows and back, announcing two new tracks. Now KemHome's last word holds for 5 s (its blinks go unseen), it reconnects at once after a dropped connection, and a source taking over the same Chrome tab is no longer a new track: the title is swapped in place, without the announcement or the slide.

## 0.6.12 — 2026-11-06

- **Skins for Kys**: settings → Kys → Look (or `"kys-skin"`). Kys's body, wherever it shows (its button and its page in the island, running free on the screen, the settings' buddy), is black (**Classic**) or a capsule of smoked glass lit along its top (**Liquid Glass**). By default it's **Like the island**: of glass with the Liquid Glass theme, black otherwise.

## 0.6.11 — 2026-11-06

- **Liquid Glass: the light following the mouse can be turned off**: settings → Island → Light following the mouse (or the menu's Theme entry, or `"glass-light": false`). On by default, as before.

## 0.6.10 — 2026-11-06

- **Liquid Glass in screenshots**: a new option, settings → Island → Visible in screenshots (or the menu's Theme entry, or `"visible-in-captures"`), keeps the island in screenshots, recordings and screen sharing with the Liquid Glass theme. Its glass then no longer sees what's behind it (Windows would show it the island itself): while it's on, the island is a capsule of smoked glass, with its rim and its bubbles. Off (the default), it's as before: real glass, and left out of captures.

## 0.6.9 — 2026-11-05

- **Liquid Glass: the crystal rim all the way while the island opens and closes.**
  - The light on its rim (the bright line along the edge, the reflection along the bezel, the sheen on its dome) is now drawn so that it follows the island at every step of its animations, at any size: it no longer fades out while the island changes size. At rest, it looks the same as before.
  - The bend of the glass at its rim follows too: the island now has its glass ready for the sizes in between, and takes the right one at each moment, opening as well as closing.
  - The very first time it goes a way (a shape it never took), the glass stays flat for that moment while its bend is worked out, then it's remembered: from then on, and after Kysland restarts, it bends right all along.

## 0.6.8 — 2026-11-05

- **Liquid Glass, smooth when the island grows or shrinks**: opening it, closing it, a notification coming in.
  - The glass no longer vanishes for a moment at the start of the animation.
  - A ring of glass of the wrong shape no longer shows inside it halfway.
  - It no longer stutters while the bend of a new shape is worked out: that's done aside now, and the island waits for it with its glass going flat for an instant, rather than bent the wrong way.
  - The shapes it takes are remembered, and their glass is ready a moment after Kysland starts: from then on, opening it doesn't even go flat.
  - What's behind the island is now copied as soon as it starts growing, so its new room is glass right away, a notification's too.

## 0.6.7 — 2026-11-05

- **Things that change now move instead of jumping**:
  - Click the RAM or the network in the open island: the chip gives under the click, and the value rolls over to the other one (the old one up and away, the new one up from below). The network's arrow turns round between download and upload.
  - Play ↔ pause, muting and the volume's level: the old icon shrinks away and the new one springs in.
  - Paused, the equalizer's bars settle down from wherever they were; playing again, they rise one after the other.
  - Refreshing the Claude usage: the arrows finish their turn instead of snapping back upright.
  - On Kys's page, the belly and joy gauges slide to their new level.
  - The unread badge on the bell, Kys's hungry dot and the "not enough credits" message pop in.

## 0.6.6 — 2026-11-05

- **Liquid Glass: controls as bubbles of glass.** Each button is its own drop of glass, lit along its top with a shadow under it. It swells under the cursor and squashes when you click it. This covers Kys, the settings and the bell, previous / next, the headers of the notifications, the calendar and Kys's page, a notification's ✕, refreshing the Claude usage and talking to Kys. Play is a big bubble tinted with the album art's color. The chips, the Claude usage and Kys's tiles are raised plates of glass, and the gauges are grooves in it. The volume fills its groove, and its handle is a lozenge of glass that swells like a lens while you hold it. The classic theme doesn't change.

## 0.6.5 — 2026-11-05

- **Swipe a notification away**: drag it toward the screen edge (up, at the top; down at the bottom; sideways on a side) and it closes, like its ✕. It follows the cursor that way; let go before it went far enough and it springs back (a quick flick is enough). A notification dragged any other way is no longer taken for a click: it doesn't open its app.
- **Liquid Glass**: more room above and below what the island shows (open, Kys's page, the calendar, a notification), out of its curved rim; a notification's ✕ no longer sits in its rounded corner.
- Fixed: on an island set shorter than its time and date ("width"), Kys dropping in to show how it feels (or peeking, eating, playing) landed far off to the side of the island instead of next to its time.

## 0.6.4 — 2026-11-05

- **On a side of the screen**, the resting island no longer sticks out sideways: it's a **bubble**, a round ball floating just off the edge with the time in it (and the equalizer while something plays), or, if you prefer, it stands up **vertical**, its time and date turned with it (settings → Island → On a side, or `"side-shape"`). Hover it and it opens into the usual island; events and notifications show as before.
- **Move and resize the island, with one button**: settings → Island → Position and size → Adjust (or the menu's Dynamic Island → Move or resize the island…). It waits where it is, outlined, with a handle at its free corners. Drag it to any edge: let go, it stays right there against it. Pull one of its ends to make it longer or shorter (its other end stays put): too short for everything, the date goes first, then the album art and the equalizer, and only the time is left. Pull a corner to make it bigger or smaller, from half its size to twice as big (drawn to its normal size as you pass it): everything in it follows, text, album art, Kys and its eyes, and the room it takes on the screen too. Do both as many times as you like, then click beside it (or Enter, or Done) to keep it all; right click, Escape or Cancel puts it back as it was. A long press on the island still picks it up at once (let go: it's kept). "Normal size" (there, or in the settings) puts its size and length back; in the config, `"size"` (in %) and `"width"` (in px).
- **Hiding from the cursor on a side too**: come slowly and the island tucks itself into the side edge, a thin strip standing up with its two eyes, one above the other, watching the cursor. Stay close and it grows out of the side and the eyes roam, get dizzy, get thrown out and come back, and can be grabbed (option "Grab Kys"), as at the top.
- Fixed: opening or closing the island, what travels from one view to the other (the time, the album art...) could land beside its spot and jump into it at the end: on a side, or anywhere but in the middle of an edge. With Liquid Glass, closing no longer draws a ring of glass in the middle of the island. Standing up on a side, the closing bounce no longer cuts its text down the middle.
- Fixed: moving the island from a top or bottom edge to a side (or back), it went round to get there and its time could stay behind, out of it. It now changes shape right against the new edge, with what it shows inside it, and follows the cursor without lagging behind. Kys no longer drops in while it's being moved, nor once it's on a side.

## 0.6.3 — 2026-11-03

- **Claude usage on plans without the 5 h session** (like Ultra): only the week's gauge is shown, across the whole width, instead of an empty or 0 % session. The 80 % and limit-reached alerts then follow the week.
- **Liquid Glass theme**, inspired by iOS (settings → Theme, or the menu's Dynamic Island entry): the island floats off the screen edge as a capsule of glass. What's behind it is blurred, brightened and bent at its rim as through real glass (refraction computed for its shape, at every size it takes), with a rim light, a light that follows the mouse, and a tint that darkens over light backgrounds so the text stays readable. Hidden from the cursor, it's a drop of glass against the edge. To see what's behind it, Kysland copies that bit of the screen (only while it changes), so with this theme its windows don't show in screenshots, recordings or screen sharing.
- **Three kinds of glass** for that theme (settings → Glass, or the menu's Theme entry): **frosted**, well blurred and easy to read; **balanced**; and **crystal**, nearly clear, with a thick bulging rim that bends what's behind it like a lens (the whole height of the resting capsule), splits its colors like a prism, a band of reflection along the edge and a sheen on its dome.
- **Put the island anywhere**: along the top or the bottom of the screen, or on a side. Press and hold it, then drag it: it follows the cursor along the nearest edge (drawn to the middle as it passes it), and a click drops it there. Also from the menu (Dynamic Island → Move the island…) and the settings (Position, with a button to put it back in the middle of the top). On a side, it grows into the screen; it doesn't hide from the cursor there.
- **Bounce when closing**, an option (settings, and the menu's Dynamic Island entry), on by default: turn it off and the island closes smoothly, without the boing. Opening keeps its spring.

## 0.6.2 — 2026-10-01

- Fixed: opening the settings (from the island's gear, the menu...) could leave a blank window that wouldn't close, and Kysland stuck behind it. The settings window is now ready from the start, hidden, and only shown when you open it.

## 0.6.1 — 2026-10-01

- **Kys running free** (option "Grab Kys"): right-click it for the island's menu (settings, Kys's page...). And give it things from the settings: drag a cookie, the ball or a hat out of the settings window onto it; it comes to meet you, opens its mouth for food, and eats it, plays or puts it on. Meanwhile, the settings window's Kys steps aside: there's only one Kys. What you tell it in the chat shows on the Kys running free too: its emotions, and the 6 7.

- Fixed: a right-click in some spots opened the browser's menu (back, print, inspect...), whose print preview could cover the screen without any way to close it. That menu and printing are gone.

## 0.6.0 — 2026-10-01

- **Grab Kys** (an option, off by default, in the settings under "Hiding from the cursor"): come slowly so the island hides, grab Kys's eyes and pull. Kys pops out in a drop of island and runs off across your screen, taking the island with it: it wanders, comes to see your cursor, dozes off, gets dizzy, does the 6 7... Rush at it and it flees; come slowly and you can catch it, and it panics. Bring it back to its spot and the island forms again around it (and it earns you credits). Left alone long enough, it goes home by itself.

## 0.5.0 — 2026-09-30

### Talk to Kys

- **Kys's page has an input**, in the island (the little Kys next to the gear) and in the Kys tab of the settings. It answers in a bubble, and its face follows along. Talking to it earns a credit (10 a day).
- **Simple brain**, the default: it understands commands ("next song", "pause", "volume 30", "louder", "mute"), questions ("what time is it?", "what's playing?", "are you hungry?") and a bit of small talk, in English and French. Nothing to download, nothing running.
- **Light and Smart brains**, an option (settings, Kys tab, Brain): a small AI running on your PC, to really chat. **Light** (Qwen3 1.7B, 1.1 GB) answers in about a second; **Smart** (Qwen3 4B, 2.5 GB) takes about three and is much better company, with a real personality and a memory of the conversation. Download the one you want from the settings. It starts loading as soon as you click the input, and is freed a minute after you stop talking. Nothing leaves your PC. Commands still go through the simple brain: instant and reliable.
- **Emotions**: each answer comes with an emotion (happy, curious, surprised, suspicious, grumpy, worried, sleepy, sad), shown by Kys's own eyes: brows and eyelids on the face of its page, on the buddy of the settings, and on the island itself, where Kys drops in to show it when you talk to it from the settings. Be mean to it and its joy goes down.
- **Giving it things**: drag something from its inventory onto Kys, on its page in the island or onto the buddy of the settings (which comes to meet you). Hold food out to it and a mouth opens, white like its eyes, wider as the food comes near; drop it in and Kys chews, its mouth a little C going round and round. The ball starts a game, a hat or the crown goes on its head (click it in the inventory to take it off).
- While it eats, Kys stays happy: whatever else it would feel waits until it's done.
- Asleep, Kys no longer blinks or glances around. Sneak up on it very slowly and it opens one eye a crack, the one on your side, to watch you.
- **Credits**: making the settings' buddy dizzy now earns them too, catching Kys while it peeks is a little easier, and once today's cap is reached, "✦ max today" says so instead of nothing.
- In the expanded island, a click on the RAM switches it between % and GB used, and on the network between download and upload (remembered).
- **6 7**: now and then Kys does the "6 7", its eyes bobbing up and down in turn with a 6 and a 7 over them. It also does it when 67 comes up: the volume at 67, 6:07 or 18:07 on the clock, or "67" in the chat.
- When Kys drops into the island, the time and the date now tip into a V around it.
- Fixed: the shop tiles of Kys's page in the island had lost their look.
- Fixed: Kys's page could be taller than the room under the island and get cut off; its lower part now scrolls.
- Fixed: while Kysland was busy, the top of the screen could stop taking clicks, and the settings window could stay blank. Clicks outside the island now go through even then, and a settings window that doesn't load is opened again. What happens is written to `kysland.log` in `%LOCALAPPDATA%\com.kinjer.kysland`.
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
