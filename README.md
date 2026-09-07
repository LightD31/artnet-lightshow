# ArtNet Lightshow

Web-based light show controller speaking **Art-Net** to DMX fixtures, with an
automatic mode that analyses the music you're playing and builds a show from it.

Ships configured for **4× Cameo ROOT PAR 6**, but any fixture works — import a
GDTF profile and patch it in the UI.

Control surfaces: the web UI, a **Behringer X-Touch Compact** over MIDI, an
**Elgato Stream Deck** via **Bitfocus Companion**, and a REST API.

---

## Features

**Manual control**

- **BPM engine** — tap tempo, manual entry, beat subdivision (1/1 … 1/16)
- **25 patterns** — solid, chases, ping-pong, strobe, fade, colour cycle,
  rainbow, twinkle, sparkle, wave, runner, splits and halves/thirds/quarters
  variants for larger rigs
- **24 colour presets** and four colour slots (A–D) that patterns draw from
- **Per-fixture overrides** — independent RGBWAUV + dimmer + strobe, or an
  instant per-fixture blackout
- **Energy overrides** — one-touch panic effects that trump everything except
  master blackout
- **Master controls** — global dimmer, master blackout, play/stop
- **Live DMX monitor** — real-time channel values

**Automatic show**

- Analyses a track (librosa + a PANNs genre classifier) and generates a timed
  show: palette, pattern choices, drops, build-ups and accents
- Follows playback from **Spotify**, **PRO DJ LINK** (CDJs), the **Windows OS
  media session** (any player that reports to it), or the **Deezer web player**
  via the bundled browser extension
- Caches analyses on disk and **prefetches the next tracks in the queue**, so a
  track change flips instantly instead of stalling for a download

**Fixtures**

- **GDTF import** — drop in a `.gdtf` file, pick a DMX mode, patch it
- Save and load the whole patch as a show file

---

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:3000**. Fixture patching lives at **/settings.html**.

The auto-show needs Python and a few extras — see
[Auto show setup](#auto-show-setup). Manual control works without them.

---

## Network access

By default the server binds **127.0.0.1** and is reachable only from the machine
it runs on. Nothing more is needed for a normal single-machine setup.

To reach the UI from a phone or another machine, bind wider **and set a token**.
Both live in the settings page under **Server & Access**:

1. Press **Generate** next to *Access Token*, then **Apply**.
2. Set *Bind Address* to `0.0.0.0` and **Apply**.
3. Restart the server — both are read at startup.

The order matters, and the page enforces it: saving a non-loopback bind with no
token is refused, because the server would then refuse to start and there would
be no UI left to undo it from. (The same check runs at startup as a backstop for
a hand-edited config file.) Every control — blackout, strobe, the Art-Net
target — would otherwise be open to anyone on the network.

Then open the UI **once** per browser at
`http://<machine>:3000/?token=<the token>`. The page stores it and strips it
from the URL; later visits need nothing in the address bar.

The same token goes in:

- **Companion** → the connection's *Access token* field
- **Browser extension** → its preferences page (server URL and token)

Cross-origin requests are refused whether or not a token is set, so a website
you happen to have open in another tab cannot drive the rig.

---

## Fixture setup

### Default patch

| Fixture | Label | Start address |
|---------|-------|---------------|
| 1 | PAR 1 | 1 |
| 2 | PAR 2 | 13 |
| 3 | PAR 3 | 25 |
| 4 | PAR 4 | 37 |

### Cameo ROOT PAR 6 — 12-channel mode (D12CH)

| Ch | Function | Ch | Function |
|----|----------|----|----------|
| 1 | Dimmer | 7 | White |
| 2 | Dimmer fine | 8 | Amber |
| 3 | Strobe | 9 | UV |
| 4 | Red | 10 | Colour macros (keep at 0) |
| 5 | Green | 11 | Sound |
| 6 | Blue | 12 | DMX delay |

Set each fixture to **12-channel mode** and give it the start address above.

### Other fixtures — GDTF import

**Settings → Import GDTF**: upload a `.gdtf` file, pick a DMX mode, and the
channel map is derived automatically. Patch fixtures to the new profile in the
same page. The patch table flags address overlaps, and the server refuses a
fixture whose channels would run past the end of the universe.

---

## Energy overrides

Panic-button effects that instantly override patterns and per-fixture settings.
One at a time; they bypass the master dimmer and always output at full.

| ID | Name | Effect |
|----|------|--------|
| `white-strobe` | White Strobe | Full white + fast strobe |
| `blinder` | Blinder | Full white wall of light |
| `uv-strobe` | UV Strobe | Full UV + fast strobe |
| `color-strobe` | Colour Strobe | Colour A + fast strobe |
| `all-on` | All On | Every channel maxed |

Trigger from the UI, MIDI (encoder push 8 — hold to activate, release to clear),
REST, or Companion. Clear with `energyOverride: null`.

---

## Auto show setup

The analyser is Python. Manual control does not need any of this.

```bash
pip install -r requirements.txt
python scripts/setup-panns.py          # one-time, ~310 MB genre model
python scripts/setup-panns.py --check  # verify without downloading
```

**ffmpeg** and **yt-dlp** must be on `PATH`. `pip install -r requirements.txt`
covers yt-dlp; install ffmpeg with your package manager.

If `torch`/`panns_inference` are missing the analyser still runs, but genre
classification is skipped silently and palette selection falls back to a
mood-based path — so run `--check` if shows look off.

You do not have to run the setup script by hand: the analyser fetches whatever
is missing on its first analysis. `panns_inference` would otherwise try to
download its own files with `wget`, at *import* time — which fails on Windows,
and takes the import down with it — so the files are always fetched first, over
HTTPS with verified digests. The one-time ~310 MB checkpoint download happens on
the first track you analyse, not at startup.

### Which Python?

Having *a* Python is not the same as having the right one. `py` (the Windows
launcher) and `python` (whatever is first on `PATH`, often a conda env) are
routinely two different installations, and `pip install -r requirements.txt`
only ever populates one of them.

The server therefore picks the interpreter that can actually import the
analyser's dependencies, not merely the first one that answers, and prints what
it chose at startup:

```
Python  →  py → C:\Users\you\miniconda3\python.exe (3.12.7)
```

If nothing on the machine has them, it says so at startup — with the exact
command to fix it — rather than letting the failure surface minutes into a set
as a `ModuleNotFoundError` after a track has already downloaded:

```
[python] C:\Python312\python.exe is missing: librosa, numpy, soundfile
[python] Interpreters found:
[python]   py     → C:\Python312\python.exe (3.12.7) — missing librosa, numpy, soundfile
[python]   python → C:\Users\you\miniconda3\python.exe (3.12.7) — has everything
[python] Fix: install into this interpreter with
[python]   "C:\Python312\python.exe" -m pip install -r requirements.txt
```

To force a specific interpreter, set its full path in the settings page under
**Analysis → Python**. The page shows which one is live and what it is missing.
Changing it recycles the analyzer process; no restart needed.

### Playback sources

| Source | What it needs |
|--------|---------------|
| **Spotify** | A client ID and secret in the settings page, then visit `/auth/spotify`. Register the redirect URI the server prints at startup. |
| **PRO DJ LINK** | CDJs on the same network. Toggle it in the settings page or on the main page. |
| **Now playing (Windows)** | Nothing — reads the OS media session, so any player that reports to it works. Toggle it under *Playback Sources*. |
| **Deezer** | The extension in `browser-extension/` (see its README). Carries ISRC and the upcoming queue, so it prefetches. |
| **Timer** | Fallback: plays the analysed timeline against a wall clock. |

The Deezer ARL cookie (settings page → *Deezer*) is optional but recommended:
with it, audio is fetched by ISRC for an exact match instead of a yt-dlp search.

---

## MIDI — Behringer X-Touch Compact

Set the controller to **Standard MIDI mode** (Layer A). The server auto-detects
the first port matching `/x.?touch/i`; pick specific ports in the settings
page, and the choice is remembered.

| Control | MIDI | Action |
|---------|------|--------|
| Encoder 1 | CC 10 (relative) | BPM ±1 |
| Encoder 2 | CC 11 (relative) | Master dimmer |
| Encoders 3–6 | CC 12–15 (relative) | Fixture 1–4 dimmer |
| Encoder 7 | CC 16 (relative) | Strobe speed |
| Faders 1–4 | CC 1–4 (absolute) | Fixture 1–4 dimmer |
| Fader 9 | CC 9 (absolute) | Master dimmer |
| Encoder push 1 | Note 0 | Tap tempo |
| Encoder push 2 | Note 1 | Toggle blackout |
| Encoder push 3 | Note 2 | Toggle play/stop |
| Encoder push 4–7 | Note 3–6 | Fixture 1–4 blackout |
| Encoder push 8 | Note 7 | Energy override (hold) |
| Button row 1 | Notes 16–23 | Patterns |
| Button row 2 | Notes 24–31 | 2 patterns + Colour A presets 1–6 |

LEDs reflect current state. `DEBUG_MIDI=1` logs every incoming message — useful
when mapping a controller, far too noisy during a show.

---

## Stream Deck — Bitfocus Companion

See **[companion-module/INSTALL.md](companion-module/INSTALL.md)**. Requires
Companion **v4.3+** (the module uses the v2 connection API).

1. `npm install` inside `companion-module/`
2. Point Companion's *Developer modules* folder at it
3. Add an **ArtNet Lightshow** connection — host, port, and the access token if
   the server uses one
4. Drag presets onto buttons

Presets cover patterns, colours A–D, transport, per-fixture blackout and energy
effects, with feedback highlighting the active state.

---

## REST API

All endpoints return JSON. When a token is configured, send it as an
`X-Lightshow-Token` header or a `?token=` query parameter.

### State and transport

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state` | Full current state |
| POST | `/api/set` | Patch state fields (JSON body) |
| POST | `/api/tap` | Tap tempo |
| POST | `/api/play` · `/api/stop` | Start / stop the pattern engine |
| POST | `/api/bpm/:value` | Set BPM (20–300) |
| POST | `/api/bpm/adjust/:delta` | Nudge BPM |
| POST | `/api/master/:value` | Master dimmer (0–255) |
| POST | `/api/blackout/toggle` · `/api/blackout/on` · `/api/blackout/off` | Master blackout |
| POST | `/api/pattern/:id` | Set pattern (e.g. `chase`, `rainbow`) |
| POST | `/api/color/:slot/:index` | Set colour slot `a`–`d` (index 0–23) |
| POST | `/api/energy/:id` · `/api/energy/off` | Energy override |

### Fixtures, profiles and shows

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/fixture/:id/override` | Set a fixture override (JSON body) |
| POST | `/api/fixture/:id/blackout/toggle` · `/api/fixture/:id/clear` | Per-fixture blackout / clear |
| POST | `/api/fixtures` · DELETE `/api/fixtures/:id` | Add / remove a fixture |
| POST | `/api/gdtf/parse` | Parse an uploaded `.gdtf` (multipart `gdtf`) |
| POST | `/api/profiles` · DELETE `/api/profiles/:id` | Register / remove a fixture profile |
| GET · POST | `/api/show` | Export / import the patch |

### Auto show

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auto/analyze` | Analyse a file path, URL or search query |
| POST | `/api/auto/analyze-spotify` · `-nowplaying` · `-deezer` · `-prolink` | Analyse what's playing on that source |
| POST | `/api/auto/download-analyze` | Analyse a YouTube URL or search |
| POST | `/api/auto/analyze-upload` | Analyse an uploaded audio file (multipart `audio`) |
| POST | `/api/auto/start` · `/api/auto/stop` · `/api/auto/reset` | Playback control |
| GET | `/api/auto/state` · `/api/auto/timeline` | Status / generated timeline |
| GET · DELETE | `/api/auto/cache` | List / clear cached analyses |
| DELETE | `/api/auto/cache/entry` | Remove one cached analysis (`{ key }`) |

### MIDI, PRO DJ LINK, integrations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/midi/ports` | List MIDI ports |
| POST | `/api/midi/connect` | Connect ports `{ input, output }` |
| POST | `/api/prolink/enable` · `/disable` · `/toggle` | PRO DJ LINK |
| GET | `/auth/spotify` · `/auth/spotify/callback` | Spotify OAuth |
| GET | `/api/spotify/now-playing` · POST `/api/spotify/disconnect` | Spotify |
| POST | `/api/nowplaying/disconnect` | Drop the OS media session source |
| POST | `/api/deezer/state` · `/api/deezer/disconnect` | Used by the browser extension |

### Socket.IO

The UI uses Socket.IO rather than polling. Clients send `set`, `override`,
`fixture`, `tap` and `midi-connect`; the server emits `state` (full snapshot on
connect, changed fields thereafter), `dmx` (live channel values), `auto-position`,
`midi-status` and `error-msg`.

---

## Configuration

Everything is configured in the **settings page** (the *Settings* link in the
header, or `/settings.html`). There are no environment variables to set: the
server stores your choices in `config/settings.json` and reads them from there.

Open the page, change what you need, press **Apply**. Most settings take effect
immediately.

| Section | Settings |
|---------|----------|
| **ArtNet Output** | Node IP, port, universe |
| **MIDI** | Input and output port |
| **Playback Sources** | PRO DJ LINK, Windows now-playing (SMTC) |
| **Spotify** | Client ID, client secret, OAuth proxy, unverified-state escape hatch |
| **Deezer** | ARL cookie — exact ISRC-matched audio instead of a yt-dlp search |
| **Analysis** | Analyzer and download timeouts, library folder, Python interpreter |
| **Server & Access** | Bind address, port, access token, public URL |

The four **Server & Access** settings are read before the server starts
listening, so they are marked `restart` in the page and applied on the next
start. Everything else applies as soon as you press Apply.

### The config file

`config/settings.json` holds secrets — the Spotify client secret, the Deezer
ARL, the access token — so it is written `0600` and is gitignored. Nothing else
needs to be in it: any key you have not set uses the built-in default.

The settings page never shows a stored secret. It reports only whether one is
set, and lets you replace or clear it.

If the file is corrupt or fails validation at startup, it is moved aside as
`settings.json.invalid-<timestamp>` and the server starts on defaults rather
than refusing to boot mid-gig.

### Moving from .env

Environment variables are **no longer read**. If you have a `.env` from an
earlier version, the server names the variables it is ignoring at startup:

```
[settings] These environment variables are no longer read: ARTNET_HOST, DEEZER_ARL
[settings] Settings now live in the settings page (⚙ → Settings) and are stored
[settings] in config/settings.json. Set them there; you can delete them from .env.
```

Set those values once in the settings page and delete the file. (`DEBUG_MIDI=1`
is the one exception — it is a developer log toggle, not a setting, and is still
read from the environment.)

Art-Net target and universe are also editable from the main page's ArtNet
panel; changes there are persisted to the same file.

> **Why `--openssl-legacy-provider`?** The `start` and `dev` scripts pass it
> because Deezer track decryption uses Blowfish (`bf-cbc`), which OpenSSL 3
> moved to the legacy provider. Without the flag, Deezer downloads fail with
> `ERR_OSSL_EVP_UNSUPPORTED`; everything else works.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| **Space** | Tap tempo |
| **1** / **2** | Manual / Auto Show tab |

---

## Development

```bash
npm run lint        # ESLint
npm test            # node:test unit suite
npm run check       # both
npm run watch:client # rebuild the client bundle on change
npm run dev         # server with --watch
```

`public/app.bundle.js` is generated from `public-src/` by esbuild and is not
committed; `npm start` builds it automatically via `prestart`.

CI runs lint, tests, a client build and `npm audit --omit=dev` on every push and
pull request.

---

## Licence

MIT — see [LICENSE](LICENSE).
