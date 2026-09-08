# ArtNet Lightshow

Web-based light show controller speaking **Art-Net** and **sACN (E1.31)** to DMX
fixtures, with an automatic mode that analyses the music you're playing and
builds a show from it.

Ships configured for **4× Cameo ROOT PAR 6**, but any fixture works — import a
GDTF profile and patch it in the UI.

Control surfaces: the web UI, **any MIDI controller** (with MIDI learn; a
Behringer X-Touch Compact is mapped out of the box), an **Elgato Stream Deck**
via **Bitfocus Companion**, and a REST API.

---

## Features

**Manual control**

- **BPM engine** — tap tempo, manual entry, beat subdivision (1/1 … 1/16)
- **25 patterns** — solid, chases, ping-pong, strobe, fade, colour cycle,
  rainbow, twinkle, sparkle, wave, runner, splits and halves/thirds/quarters
  variants for larger rigs
- **24 colour presets** and four colour slots (A–D) that patterns draw from
- **Palettes** — the auto show's sixteen hand-tuned looks, pickable by hand: one
  press fills all four slots with colours that were chosen to sit together
- **Per-fixture overrides** — independent RGBWAUV + dimmer + strobe, or an
  instant per-fixture blackout
- **Per-fixture maximum brightness** — scale down a lamp that is too close to
  the audience without taking it out of the show
- **Energy overrides** — one-touch panic effects that trump everything except
  master blackout
- **Master controls** — global dimmer, master blackout, play/stop
- **Cue stack** — save the look on stage under a name and recall it in one press
- **Live DMX monitor** — real-time channel values

**Automatic show**

- Analyses a track (librosa + a PANNs genre classifier) and generates a timed
  show: palette, pattern choices, drops, build-ups and accents
- Follows playback from **Spotify**, **PRO DJ LINK** (CDJs), the **Windows OS
  media session** (any player that reports to it), or the **Deezer web player**
  via the bundled browser extension
- Caches analyses on disk and **prefetches the next tracks in the queue**, so a
  track change flips instantly instead of stalling for a download
- **Set-list warming** — paste tonight's tracks (or point it at a Spotify
  playlist) at load-in and have the whole night analysed before doors open

**Before the show**

- **Preflight** — one command that checks Art-Net reachability, the patch,
  Python, ffmpeg, yt-dlp and the genre model before doors open
- **Set-list warming** — analyse the whole night up front, from a pasted list or
  a Spotify playlist, rather than relying on the live queue lookahead

**Fixtures**

- **GDTF import** — drop in a `.gdtf` file, pick a DMX mode, patch it
- **Multiple universes** — every fixture names the universe it lives on, so a
  rig is no longer capped at one node's 512 channels
- **Art-Net and sACN (E1.31)** — run either, or both at once while a venue is
  migrating from one to the other
- Save and load the whole patch as a show file

---

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:3000**. Fixture patching lives at **/settings.html**.

Before a show, run `npm run preflight` — see [Pre-show check](#pre-show-check).

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

| Fixture | Label | Universe | Start address |
|---------|-------|----------|---------------|
| 1 | PAR 1 | 0 | 1 |
| 2 | PAR 2 | 0 | 13 |
| 3 | PAR 3 | 0 | 25 |
| 4 | PAR 4 | 0 | 37 |

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

### Output protocols

Frames go out over **Art-Net**, **sACN (E1.31)**, or both — each universe is
sent on every protocol that is enabled, so a rig can run one node on Art-Net
and a console on sACN at the same time.

| | Art-Net | sACN (E1.31) |
|---|---|---|
| Settings section | *ArtNet Output* | *sACN (E1.31)* |
| Default | on | off |
| Port | 6454 | 5568 |
| Addressing | broadcast or unicast to the node IP | multicast to `239.255.x.y` per universe, or unicast to a node IP |
| Universe numbering | from 0 | from 1 |

sACN is off until you turn it on. Once it is, leave *Node IP* blank for the
normal deployment — each universe multicasts to its own group and receivers
subscribe to what they need.

**Universe offset.** Art-Net counts universes from 0 and sACN from 1, so the
default offset of `+1` lines them up: a fixture patched on universe 0 goes out
as sACN universe 1. Change it if your console numbers universes differently.

**Component ID.** A receiver tells sACN sources apart by CID, so a fresh one
every boot would look like a second source arriving and start the console
arbitrating between two of us. One is generated on first start and stored in
`config/settings.json` from then on. Change it only if two servers on the same
network ended up sharing one.

**Priority** (0–200, default 100) decides who wins when two sources drive the
same universe.

To run sACN *only*, turn **ArtNet Output → Enabled** off.

### Universes

Each fixture carries a **universe** alongside its DMX address, so a rig can be
larger than one node's 512 channels. Set it per fixture in the patch table (or
in the fixture card on the live page) — addresses only collide with other
fixtures on the *same* universe.

The **Universe** field in *ArtNet Output* is the rig's **default** universe: it
seeds new fixtures, and fixtures sitting on it follow when you change it, which
is what that field used to do when there was only one universe to be on. A
fixture you deliberately patched somewhere else stays put.

Universes with nothing patched on them are transmitted for one final all-zero
frame and then dropped, so a node never sits holding the look it had when its
last fixture moved away. The server transmits at most **32** universes.

---

## Set-list warming

Live prefetch only looks one to five tracks down the queue, and only once a
source is playing. That makes a track change instant *during* a set, and is no
help at all for the first track of the night, for a DJ who does not queue ahead,
or for a venue whose network you would rather not depend on once the room is
full.

Analysing a track takes tens of seconds. Doing forty of them at load-in costs
nothing but time you already have.

**Auto Show → Set-list warming**: paste one `Artist - Title` per line and press
**Warm this list**. Blank lines, `#` comments and leading track numbers are
ignored, so a list copied out of rekordbox or a notes app works as-is.

```
1. Daft Punk - Around the World
02) Justice - Genesis
# encore
A-Trak - Ray Ban Vision
```

**Warm the Spotify queue** does the same for everything Spotify has queued,
rather than only the next few.

**Warm a Spotify playlist** takes the set list you already have. Pick one of the
connected account's playlists from the dropdown, or paste a link to anyone's —
a share link, a `spotify:playlist:…` URI or the bare id all work. Unlike the
queue, a playlist exists before anything is playing, which is the case warming
was built for.

Tracks keep their Spotify id, so a warmed playlist track is already cached under
the exact key the live path looks up when it plays. Podcast episodes and tracks
pulled from the catalogue are skipped; local files in a playlist are warmed by
name, the same way a pasted line is.

Private and collaborative playlists need the `playlist-read-private` and
`playlist-read-collaborative` scopes, which are requested at login. A Spotify
connection made before this feature existed does not carry them — Spotify then
reports your own playlist as simply not found — so reconnect Spotify in the
settings page. Public playlists work either way.

Progress is live — each track shows *queued*, *analysing*, *cached* or *failed*.
Tracks already on disk are skipped without touching the analyser, so re-running
a list is nearly instant. A track yt-dlp cannot find is recorded and the rest of
the list continues.

Warming runs at normal priority, so a track change during a set (which submits
at high priority) never sits behind an hour of it. **Stop** ends the queue; the
track being analysed at that moment finishes, since abandoning it would mean
throwing away work that was nearly done.

Up to 200 tracks per run.

---

## Pre-show check

Everything in this stack degrades quietly on purpose. Art-Net send failures are
logged and the render loop carries on. A missing PANNs checkpoint drops genre
classification and falls back to a mood palette. An absent ffmpeg only surfaces
when the first track downloads. Individually that is right — none of it should
take the show down mid-set. Collectively it means the first sign of a broken rig
is the rig not working, in front of an audience.

```bash
npm run preflight
```

It asks every one of those questions while there is still time to fix the
answer, and exits non-zero if something will not work:

```
  [ok]   Art-Net output     2 nodes answered: DMX-1 at 192.168.1.50 (universe 0), …
  [--]   sACN output        Disabled. Turn it on in Settings → sACN (E1.31) …
  [ok]   Fixture patch      8 fixtures on universes 0, 1, no overlaps.
  [warn] MIDI               "X-TOUCH COMPACT" is not among the available inputs (none).
                            → Plug the controller in and reconnect it in Settings → MIDI.
  [FAIL] ffmpeg             Not usable — not found on PATH. …
                            → Install ffmpeg with your package manager …
```

| Status | Meaning |
|--------|---------|
| `ok` | Working. |
| `warn` | Works, but degraded — or we could not prove it either way. Does not fail the run. |
| `FAIL` | Will not work. Exits 1. |
| `--` | Nothing to verify, just worth seeing. |

What it checks: Art-Net reachability (it sends an ArtPoll and lists the nodes
that answer), the sACN configuration and universe mapping, the fixture patch
for overlaps and out-of-universe addresses, the bind address and token, the
MIDI controller, the Python interpreter and the analyser's imports, ffmpeg,
yt-dlp, the PANNs checkpoint, the analysis cache, and which playback sources
are connected.

The same report is in the settings page under **Pre-show Check** — run there,
it also sees the *live* MIDI and playback-source connections rather than only
what is configured.

A node that never answers an ArtPoll is a warning, not a failure: plenty of
them do not implement it, and a broadcast rig works fine without ever replying.

---

## Palettes

Sixteen named looks — the same bank the auto show locks a song to, offered by
hand. One press writes all four colour slots with colours that were picked to
sit together, which is the fiddly part of driving the rig manually.

Pick a size first: **2** for a small rig (two strongly contrasting hues that
still read from the back of the room), **3** for three well-separated hues, or
**4** for the full hand-tuned tetrad. Each size is its own bank rather than a
slice of the four-colour one — a tetrad's two analogous colours look like one
colour when there are only two lamps. A palette smaller than four slots wraps to
fill them all, so the four-colour patterns still have something in every slot.

The picker lives at the top of the *Colours* card. The active look stays named
until you edit a slot by hand, at which point the rig is no longer showing that
palette and the name goes.

Palettes are also a bindable MIDI action (**Select palette**) and reachable over
REST at `POST /api/palette/:id`.

---

## Fixture maximum brightness

Every fixture carries a **brightness trim** — the *Max* slider on its card. It
**scales** that fixture's output rather than clipping it: at 50% the fixture is
half as bright at *every* level, not merely capped at half. A clamp would leave a
fixture already sitting below the line untouched and only bite at the top, so the
bottom of the throw would go dead and two fixtures on different trims would
converge as they dimmed.

It is a trim, not a look:

- It applies to whatever is driving the fixture: the pattern engine, a
  per-fixture override, or an energy override.
- It does **not** put the fixture into override mode. Trimming a lamp that is
  hanging a metre from someone's face should not also take it out of the show.
- It is not captured in a cue, and recalling a cue does not change it. A trim
  belongs with the patch — it describes where the lamp is hung, not what the
  show is doing.
- It survives clearing the override, and it rides the show file so a rig loads
  back trimmed the way it was left.

The grand master and the trim both multiply, so they compose: a fixture trimmed
to 50% with the master at 50% comes up at 25%.

Set it from the fixture card, from MIDI (**Fixture max brightness** on a fader,
**Nudge fixture max brightness** on an encoder), or over REST at
`POST /api/fixture/:id/max/:value`.

---

## Cues

A **cue** is the look on stage saved under a name: tempo and beat division,
pattern, all four colour slots, master dimmer, blackout, strobe, the active
energy override, and every fixture's override. Build something you like, press
**Save current look**, and it is one press away for the rest of the night.

Cues live in the *Cues* card on the live page.

- **Recall** — click the cue.
- **✎** rename. Renaming never touches the stored look.
- **⟳** overwrite the cue with what is on stage now.
- **×** delete — with an **Undo** that puts the same cue back in the same slot.

A cue holds no patch data — no addresses, no universes, no Art-Net target, and
no per-fixture brightness trim — so recalling one can never re-address the rig,
move a fixture to another universe, or undo a trim mid-show. Fixtures the cue
says nothing about are cleared rather than left holding the previous look: a cue
is the whole rig, not a partial edit.

They are stored in `config/cues.json` and survive restarts. Up to 128.

---

## Energy overrides

Panic-button effects that instantly override patterns and per-fixture settings.
One at a time. They are scaled by the grand master and each fixture's maximum
brightness — the master is the one hand you keep on the whole rig, and it should
still mean something at the moment you hit the blinder.

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

### Shaping the generated show

Two controls sit in the *Look* panel and decide how the generated show reads:

- **Palette** — how many colours a song locks to (2, 3 or 4).
- **Intensity** — 0–100, how hard the show pushes: accent density, drop effects,
  strobe bursts and beat-division scaling. 50 is normal.

Both are live: changing either rebuilds the timeline from the analysis already
in hand, so the new setting takes effect on the next tick without re-analysing
the track. Neither touches the master dimmer — that slider stays yours.

Intensity is also on the control surface (**Auto-show intensity** on a fader,
bound to fader 8 by default; **Nudge auto-show intensity** on an encoder) and
over REST at `POST /api/auto/intensity/:value`, so it can be driven from a
Stream Deck or a script mid-set rather than only from the browser.

---

## MIDI

Any MIDI controller works. Pick its ports in the settings page (the choice is
remembered), then map it — either keep the built-in layout, or relearn the
bindings you want onto the controls you have.

### MIDI learn

**Settings → MIDI Mapping**: pick an action, press **Learn**, and move the
control you want it on. The next message that arrives is bound to it and saved.

- **Learn** next to an existing row *moves* that action to another control — it
  does not leave the old one firing as well.
- **×** unbinds a control.
- **Reset to default** goes back to the X-Touch layout below and forgets your
  file.

Learning an action that takes a parameter (a pattern, a colour, a cue, a
fixture) asks for it first, so *Recall cue → Chorus* and *Recall cue → Verse* are
two separate bindings on two separate buttons.

Bindings can name a **MIDI channel**, which a controller whose second layer
repeats the same note numbers on another channel needs; leave it out and any
channel matches.

Your mapping is stored in `config/midi-map.json`. Until you change something the
file does not exist and the default below is used.

LED feedback follows the map: a button bound to the live pattern lights up
wherever you put it, rather than wherever the X-Touch originally had it.

### Motorised faders and encoder rings

The X-Touch Compact's nine faders are motorised and its eight encoders have LED
rings, and both move the same way — the server sends the controller the CC it
would have sent you. So the surface tracks the show: change the master dimmer in
the browser and the physical fader follows, instead of staying where it was and
snapping the rig back on the next touch.

A control you are touching is left alone for a moment afterwards, so you never
fight the motor, and a position already sent is not sent again, because a motor
re-driven to where it already is hums. Connecting drives the whole surface to
the current show.

On by default — a controller without motors just ignores the CC. Turn it off in
**Settings → Control → MIDI** if a MIDI loopback echoes the feedback back in as
input.

A 7-bit fader has 128 positions for 281 tempo values, so a BPM fader sits at the
nearest step (~2.2 BPM) rather than exactly on the beat count.

`DEBUG_MIDI=1` logs every incoming message — useful when mapping an unfamiliar
controller, far too noisy during a show.

### Default mapping — Behringer X-Touch Compact

Set the controller to **Standard MIDI mode** (Layer A). The server auto-detects
the first port matching `/x.?touch/i`.

| Control | MIDI | Action |
|---------|------|--------|
| Encoder 1 | CC 10 (relative) | BPM ±1 |
| Encoder 2 | CC 11 (relative) | Master dimmer |
| Encoders 3–6 | CC 12–15 (relative) | Fixture 1–4 dimmer |
| Encoder 7 | CC 16 (relative) | Strobe speed |
| Faders 1–4 | CC 1–4 (absolute) | Fixture 1–4 dimmer |
| Fader 8 | CC 8 (absolute) | Auto-show intensity |
| Fader 9 | CC 9 (absolute) | Master dimmer |
| Encoder push 1 | Note 0 | Tap tempo |
| Encoder push 2 | Note 1 | Toggle blackout |
| Encoder push 3 | Note 2 | Toggle play/stop |
| Encoder push 4–7 | Note 3–6 | Fixture 1–4 blackout |
| Encoder push 8 | Note 7 | Energy override (hold) |
| Button row 1 | Notes 16–23 | Patterns |
| Button row 2 | Notes 24–31 | 2 patterns + Colour A presets 1–6 |

### Bindable actions

| Control | Actions |
|---------|---------|
| **Buttons** | Tap tempo · Play/stop · Master blackout · Select pattern · Set colour slot A–D · Select palette · Set beat division · Energy override (hold) · Cycle the held energy effect · Cycle strobe function · Fixture blackout · Recall cue |
| **Encoders** (relative) | Nudge BPM · Nudge master dimmer · Nudge strobe speed · Nudge fixture dimmer · Nudge fixture max brightness · Nudge auto-show intensity |
| **Faders** (absolute) | Master dimmer · Strobe speed · BPM · Fixture dimmer · Fixture max brightness · Auto-show intensity |

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
| GET | `/api/palettes` | The named looks, their colours at each size, and the one on stage |
| POST | `/api/palette/:id` | Write all four slots from a look (`{ size }` — 2, 3 or 4; default 4) |
| POST | `/api/energy/:id` · `/api/energy/off` | Energy override |

### Fixtures, profiles and shows

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/fixture/:id/override` | Set a fixture override (JSON body) |
| POST | `/api/fixture/:id/blackout/toggle` · `/api/fixture/:id/clear` | Per-fixture blackout / clear |
| POST | `/api/fixture/:id/max/:value` | Fixture maximum brightness (0–255) — scales the fixture's output; not an override |
| POST | `/api/fixtures` · DELETE `/api/fixtures/:id` | Add / remove a fixture (`{ universe }` optional on add; DELETE answers with the fixture and its index) |
| POST | `/api/fixtures/restore` | Put a deleted fixture back (`{ index, fixture }`) |
| POST | `/api/gdtf/parse` | Parse an uploaded `.gdtf` (multipart `gdtf`) |
| POST | `/api/profiles` · DELETE `/api/profiles/:id` | Register / remove a fixture profile |
| GET · POST | `/api/show` | Export / import the patch |

### Cues

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cues` | Every cue, with its full stored look |
| POST | `/api/cues` | Save a cue (`{ name }`, capturing the live look, or `{ name, look }`) |
| PUT | `/api/cues/:id` | Rename (`{ name }`), overwrite from the live look (`{ recapture: true }`), or replace outright (`{ look }`) |
| DELETE | `/api/cues/:id` | Delete a cue |
| POST | `/api/cues/:id/recall` | Put a cue on stage |
| POST | `/api/cues/restore` | Put a deleted cue back (`{ cue, index }` — what DELETE answered with) |
| POST | `/api/cues/reorder` | Reorder the stack (`{ ids }`); ids left out keep their relative order |

### Auto show

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auto/analyze` | Analyse a file path, URL or search query |
| POST | `/api/auto/analyze-spotify` · `-nowplaying` · `-deezer` · `-prolink` | Analyse what's playing on that source |
| POST | `/api/auto/download-analyze` | Analyse a YouTube URL or search |
| POST | `/api/auto/analyze-upload` | Analyse an uploaded audio file (multipart `audio`) |
| POST | `/api/auto/start` · `/api/auto/stop` · `/api/auto/reset` | Playback control |
| POST | `/api/auto/intensity/:value` | Generated-show energy, 0–100 |
| POST | `/api/auto/palette-size/:value` | Colours per song: 2, 3 or 4 |
| GET | `/api/auto/state` · `/api/auto/timeline` | Status / generated timeline |
| GET · DELETE | `/api/auto/cache` | List / clear cached analyses |
| DELETE | `/api/auto/cache/entry` | Remove one cached analysis (`{ key }`) |

### Set-list warming

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/warm` | Progress: per-track status, counts, what is running |
| POST | `/api/warm` | Start a run (`{ text }` — one `Artist - Title` per line — or `{ tracks }`) |
| POST | `/api/warm/spotify-queue` | Warm everything Spotify has queued |
| POST | `/api/warm/spotify-playlist` | Warm a playlist (`{ playlist }` — link, URI or id) |
| DELETE | `/api/warm` | Stop a run, or clear a finished one |

### MIDI, PRO DJ LINK, integrations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/midi/ports` | List MIDI ports |
| POST | `/api/midi/connect` | Connect ports `{ input, output }` |
| GET | `/api/midi/map` | The live map, the action catalogue, and whether it is customised |
| PUT | `/api/midi/map` | Replace the whole map |
| POST | `/api/midi/map/reset` | Back to the built-in X-Touch layout |
| PUT | `/api/midi/map/binding` | Bind or clear one message (`{ kind, number, binding }`) |
| POST | `/api/midi/learn` | Arm learn; the request is held open until a control moves |
| POST | `/api/midi/learn/cancel` | Disarm learn |
| POST | `/api/prolink/enable` · `/disable` · `/toggle` | PRO DJ LINK |
| GET | `/auth/spotify` · `/auth/spotify/callback` | Spotify OAuth |
| GET | `/api/preflight` | Run the pre-show check against the live subsystems |
| GET | `/api/spotify/now-playing` · POST `/api/spotify/disconnect` | Spotify |
| GET | `/api/spotify/playlists` | The connected account's playlists, for the warming picker |
| POST | `/api/nowplaying/disconnect` | Drop the OS media session source |
| POST | `/api/deezer/state` · `/api/deezer/disconnect` | Used by the browser extension |

### Socket.IO

The UI uses Socket.IO rather than polling. Clients send `set`, `override`,
`fixture`, `tap` and `midi-connect`; the server emits `state` (full snapshot on
connect, changed fields thereafter), `dmx` (live channel values, keyed by
universe), `auto-position`, `midi-status`, `midi-map`, `midi-learn` and
`error-msg`.

The `fixture` message carries
`{ id, address?, universe?, label?, profileId?, maxBrightness? }`.

---

## Mistakes and feedback

Anything the server refuses says so, in a toast in the corner — a DMX address
past the end of a universe, a profile you cannot delete because fixtures are
patched to it, a patch that is full. These used to be silent: the control just
snapped back on the next broadcast.

Deleting is undoable. Removing a **cue**, a **fixture** or a **fixture
profile**, or resetting the **MIDI mapping**, offers an **Undo** for twelve
seconds that puts the thing back where it was — a cue keeps its id and its
position in the stack, a fixture keeps its address, universe and override.

Undo is held to the same rules as the original action: if the patch changed
while the toast was up, restoring a fixture that would now overlap or overflow
a universe is refused and says why.

---

## Configuration

Everything is configured in the **settings page** (the *Settings* link in the
header, or `/settings.html`). There are no environment variables to set: the
server stores your choices in `config/settings.json` and reads them from there.

The page is grouped into tabs by when you reach for each thing — **Pre-show**,
**Rig**, **Output**, **Control**, **Music**, **Server** — and remembers which one
you were on.

Open the page, change what you need, press **Apply**. Most settings take effect
immediately.

| Section | Settings |
|---------|----------|
| **ArtNet Output** | Enabled, node IP, port, default universe |
| **sACN (E1.31)** | Enabled, node IP, priority, source name, universe offset, component ID |
| **MIDI** | Input and output port, motorised fader feedback |
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
npm run lint         # ESLint
npm test             # node:test unit suite
npm run check        # both
npm run preflight    # pre-show check (exits 1 if something will not work)
npm run watch:client # rebuild the client bundle on change
npm run dev          # server with --watch
```

`public/app.bundle.js` is generated from `public-src/` by esbuild and is not
committed; `npm start` builds it automatically via `prestart`.

CI runs lint, tests, a client build and `npm audit --omit=dev` on every push and
pull request.

---

## Licence

MIT — see [LICENSE](LICENSE).
