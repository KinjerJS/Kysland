# Kysland

A **Dynamic Island** for Windows: a black notch attached to the top edge of the screen. At rest it shows the time and date. Hover it and it expands to show what's playing, your notifications and the state of your system.

Kysland is built with [Tauri](https://tauri.app): the interface is HTML/CSS (fully customizable, hot-reloaded) and the engine is Rust, calling Windows APIs directly (Core Audio, media controls, notifications, window management). The installer is about 4 MB.

It can also be a full **Waybar / Hyprland-style status bar**.

## Features

### The island

- **At rest**: time and date. When music is playing, the album art and an animated equalizer appear too.
- **On hover**: it expands into a card with album art, title, artist, a clickable progress bar, previous / play-pause / next controls, CPU, RAM, network throughput and a volume slider.
- **Shared-element transitions**: the time, date, album art and equalizer glide and scale between the compact and expanded layouts.
- **Adaptive colors**: the equalizer and progress bar take the dominant color of the album art.
- **Live events**: the island stretches for a few seconds on volume changes, track changes, charger plugged or unplugged, network lost or restored, and GlazeWM workspace switches.
- **Script messages**: `kysland.exe --island="Build finished" --icon=check-circle`.
- **Calendar**: click the date to open a month calendar (today highlighted, arrows or mouse wheel to change month).
- **Mouse**: the wheel changes the volume. Right-click opens the Kysland menu.
- **Gets out of the way**: move the cursor to the island quickly and it expands as usual; approach it slowly (aiming at something behind it) and it tucks itself into the screen edge and lets clicks through, with two little eyes that keep glancing at the cursor (and blink), then comes back once the cursor moves away.
- **Outline on dark backgrounds**: when what's around the island is mostly black, a thin outline keeps it visible.

### Windows notifications

- New notifications show up in the island as they arrive: app icon (or a colored initial), app name, title and text.
- **Click** opens the app. **✕** dismisses it. Hovering pauses it, and several notifications play one after another.
- **History**: the bell in the expanded view lists your last 30 notifications, with an unread badge. Click an entry to open it, use its ✕ to delete it, or clear everything with the trash button. Deletions also remove the notifications from the Windows notification center.

### Claude usage (optional)

If [Claude Code](https://claude.com/claude-code) is signed in on the PC, the expanded view can show your plan usage: the 5-hour session limit and the weekly limit, with reset times and the account email (masked, e.g. `jo****83@gmail.com`). The island warns you at 80% of the session and when the limit is reached. Enable it with `"claude": true` or from the menu.

### Volume and fullscreen

- **Instant volume**: Windows notifies Kysland the moment the volume changes, whatever the source (keys, mixer, an app, a Bluetooth headset).
- **No more Windows volume flyout**: the island replaces it. Set `"hide-windows-osd": false` to keep the Windows one. It comes back as soon as Kysland quits.
- **Fullscreen**: the island hides during games, fullscreen videos and F11 (`"hide-on-fullscreen"`, also in the menu).
- **Click-through**: outside the island, the top strip lets clicks go through to your windows.

### Music sources

- Any player that reports to Windows media controls (SMTC): Spotify, browsers, media players…
- An optional KemHome agent (`ws://localhost:8080/media/ws`), which provides album art for Chrome through its extension.

### Status bar mode

- Floating "island" bar, one per screen (or on the screens you choose), at the top or bottom.
- Can reserve screen space (Windows AppBar), so maximized windows stay below it.
- **GlazeWM** integration: clickable workspaces, scroll to switch, active binding mode.

## Install

Download `Kysland_x.y.z_x64-setup.exe` from the [Releases](../../releases) and run it.

- It installs for your user account, no admin rights needed.
- Kysland starts with Windows right after you sign in (through a scheduled task, which Windows doesn't delay the way it delays startup apps). Turn it off from the menu.
- To uninstall: Settings → Apps. Kysland quits cleanly first, so the volume flyout is restored. Your configuration in `~\.config\kysland` is kept.
- On first launch, an existing WinCustom configuration (`~\.config\wincustom`) is imported.

If something is left in a bad state after a crash, `kysland.exe --repair` restores the volume flyout and the taskbar, and frees the reserved screen space.

## Usage

Right-click the island, press **`Ctrl+Alt+W`** anywhere, or use the tray icon to open the menu. From there you can reload, open or edit the configuration, pick the language (automatic = Windows display language, English or French), toggle fullscreen hiding, Claude usage and start with Windows, and open the **CSS inspector** (DevTools).

| Option | Effect |
|---|---|
| `--quit` | Quit cleanly |
| `--repair` | Restore the volume flyout, the taskbar and the screen space, then exit |
| `--island="text" --icon=name` | Show a message in the island |
| `--autostart=on` / `--autostart=off` | Start with Windows or not |

## Configuration

Files live in `%USERPROFILE%\.config\kysland\`:

| File | Purpose |
|---|---|
| `config.jsonc` | Layout, modules, formats, mouse actions (documented with comments) |
| `style.css` | The look (CSS variables such as `--accent`, `--notch-bg`…) |

Island options (in the `"island"` section):

| Option | Default | Description |
|---|---|---|
| `time-format` / `date-format` / `date-long-format` | `HH:mm` / `ddd D MMM` / `dddd D MMMM` | Any [dayjs format](https://day.js.org/docs/en/display/format) |
| `expand-on-hover` | `true` | Expand when hovered |
| `hover-delay` / `collapse-delay` | `120` / `350` | Milliseconds before expanding / collapsing |
| `media-linger` | `15` | Seconds a paused track stays displayed |
| `outline` | `"auto"` | Thin outline when it's mostly black around the island; `true` / `false` to force it (color: `--notch-outline-color`) |
| `dodge` / `dodge-speed` | `true` / `450` | Hide when the cursor approaches slower than this many px/s |
| `kemhome` | `http://localhost:8080` | KemHome agent URL, `false` to disable |
| `hide-windows-osd` | `true` | Handle the volume keys and hide the Windows volume flyout |
| `volume-step` | `2` | Percent per volume key press |
| `notifications` | `true` | Show Windows notifications in the island |
| `notification-duration` | `6` | Seconds per notification |
| `claude` | `false` | Show Claude plan usage |
| `transients` | all `true` | Which events stretch the island: `volume`, `media`, `battery`, `network`, `workspace` |

Top-level options include `language` (`"auto"`, `"en"`, `"fr"`), `reserve`, `hide-on-fullscreen`, `monitors` and `wallpaper`. Status bar modules (`workspaces`, `window`, `clock`, `cpu`, `memory`, `disk`, `network`, `audio`, `battery`, `launcher`, `power`, `media`, `custom/<name>`…) are listed in the comments of `config.jsonc`.

## Privacy

Everything stays on your PC, with two optional exceptions:

- **Claude usage**: Kysland reads the Claude Code sign-in token and sends it only to `api.anthropic.com` to fetch your usage. It never refreshes the token itself, so it can't sign Claude Code out. The usage endpoint is the one behind Claude Code's `/usage` command. It isn't a documented public API and may change.
- **Weather**: the sample `custom/weather` module queries wttr.in.

Notifications are read locally from the Windows notification database.

## Development

Requirements: Node.js, Rust (stable, MSVC) and the Visual Studio C++ build tools.

```sh
npm install
npm run dev        # run Kysland with hot rebuild of the Rust engine
npm run check      # checks: interface script syntax, invisible control characters
npm run build      # build the NSIS installer into src-tauri/target/release/bundle/nsis/
```

Layout:

- `ui/`: the interface (HTML, CSS, JS), served by the WebView. `api.js` bridges it to the Rust commands and events, `i18n.js` holds the displayed strings.
- `src-tauri/src/`: the engine. `lib.rs` (windows, menu, commands, background loop), `audio.rs`, `media.rs`, `notifs.rs`, `system.rs`, `glaze.rs`, `win32.rs`, `config.rs`, `autostart.rs`, `i18n.rs` (menu strings).
- Code, comments and commits are in English; only displayed text is translated (`ui/i18n.js`, `src-tauri/src/i18n.rs`).
- `defaults/`: default configuration, bundled as a resource.

## Releasing

The GitHub Actions workflow runs the checks and builds the installer on every push and pull request. Pushing a version tag also publishes a GitHub Release with the installer attached:

```sh
git tag v0.1.0
git push origin v0.1.0
```

## License

MIT
