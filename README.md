# ArtNet Lightshow

Web-based light show controller speaking **Art-Net**, **sACN (E1.31)** and the
**Philips Hue Entertainment API** to DMX fixtures and Hue lamps, with an
automatic mode that analyses the music you're playing and builds a show from
it.

Ships configured for **4× Cameo ROOT PAR 6**, but any fixture works — import a
GDTF file, or find the fixture in the Open Fixture Library, and patch it in the
UI.

Control surfaces: the web UI, **any MIDI controller** (with MIDI learn; a
Behringer X-Touch Compact is mapped out of the box), an **Elgato Stream Deck**
via **Bitfocus Companion**, and a REST API.

---

## Features

**Manual control**

- **Musical clock** — patterns step on the song's own beats: the auto show's
  analysed grid, a CDJ's rekordbox grid, the cached analysis of whatever is
  playing, or the beat the live input hears — else tap tempo or a BPM typed to a
  tenth. Beat subdivision 1/1 … 1/16. It also goes out as **MIDI clock**
- **18 patterns** — solid, chases, ping-pong, strobe, fade, colour cycle,
  rainbow, twinkle, sparkle, wave, runner, splits and sections; each one takes
  its colour count from the palette rather than needing a variant per size
- **LED bars** — every cell of a bar is a light of its own: import one from
  GDTF or build its profile from the manual, lay it on the stage plot, and the
  wave, ribbon, rainbow and five pixel effects (gradient, comet, burst, plasma,
  meter) draw across its cells
- **15 colour presets** — a nine-hue wheel with nothing closer than 30° on it,
  plus two whites, two pale washes and UV — and four colour slots (A–D) that
  patterns draw from
- **Palettes** — the auto show's sixteen hand-tuned looks, pickable by hand: one
  press fills all four slots with colours that were chosen to sit together
- **Per-fixture overrides** — independent RGBWAUV + dimmer + strobe, or an
  instant per-fixture blackout
- **Per-fixture maximum brightness** — scale down a lamp that is too close to
  the audience without taking it out of the show
- **Energy overrides** — one-touch panic effects that trump everything except
  master blackout
- **Master controls** — global dimmer, master blackout, play/stop
- **Cue stack** — save the look on stage under a name and recall it in one
  press; deleting or overwriting one can be undone
- **Live DMX monitor** — real-time channel values

**Running it from a tablet**

- **Perform view** — the live controls laid out for a thumb: now and next,
  sync health, big pads for blackout and every energy effect (held, or
  latched), tap tempo, one-tap palettes, and the master and show-intensity
  faders. Open it at `/#perform`, or press **3**
- **Stage view** — the rig in 3D, in a hazy room: beams from the pars, every
  cell of every bar, the Hue lamps around the room, from the audience, from
  above or from the side. Live, it shows what is going out; rehearsing, the
  planned show at any moment of the track — see [The Stage view](#the-stage-view)
- **Installable** — a web app manifest and icons, and a service worker that
  keeps the app shell so a tablet reloading while the server restarts gets the
  page back rather than a browser error (on HTTPS or localhost, where browsers
  allow one)
- **Keep awake and full screen** — from the header: the screen stays on through
  the set, over plain HTTP too
- **Themes** — dark, light, and a red night mode that draws the whole page in
  red alone, for a dark room; or follow the system
- **Accessible** — keyboard throughout, labelled controls, 4.5:1 text contrast
  in every theme, 44 px targets on a touch screen, reduced motion honoured;
  checked with axe-core on every view in CI

**Automatic show**

- Analyses a track and generates a timed show: palette, pattern choices, drops,
  build-ups and accents. The pipeline finds tempo, metre and downbeats, splits
  the track into named sections (intro, verse, chorus, drop, breakdown, bridge,
  outro), and describes seven frequency bands by what they are *doing* rather
  than how loud they are — see [Audio analysis](docs/audio-analysis.md)
- **Paces itself** — an accent budget per minute, quiet before and after a drop,
  and sections that deliberately rest, so the big moments stay big; and across
  the night, too — no palette or look twice in a row, colours carried over
  when the keys mix, the blinder saved for the tracks that peak — see
  [Remembering the night](#remembering-the-night)
- **Pars and bars as two layers** — with LED bars in the patch the pars carry
  the colour and the bars the movement: a gradient through a verse, a fill
  rising through a build, a mirrored chase on the chorus, a burst sparking on
  every kick at the drop
- **Accents on the drums as played** — on the kick or snare that marks the bar,
  none on a bar nothing was hit on, one on the last hit of a fill
- **Timeline view** — the loaded track laid out wide: its sections, curves,
  drops and the planned looks and accents, to zoom into and scrub. Press on it
  to rehearse from there, on the stage preview and the 3D stage — see
  [The Timeline view](#the-timeline-view)
- **Track edits that stick** — lock a track's palette, swap a section's look,
  add or take away an accent; kept with the track and put back every time it
  plays — see [Track edits](#track-edits)
- **Flash limit** — a switch that holds the whole rig to three large-area
  flashes a second, the photosensitivity threshold — see
  [Flash limit](#flash-limit)
- **Reads the buildup** — measures how far the snare roll subdivides and whether
  the tempo genuinely ramps into the drop, and drives the beat division and the
  beat clock from that rather than a fixed escalation
- Follows playback from **Spotify**, **PRO DJ LINK** (CDJs), the **Windows OS
  media session** (any player that reports to it), or the **Deezer web player**
  via the bundled browser extension
- **CDJs, properly** — follows the deck the room hears (on air, not just the
  tempo master), to the millisecond on a CDJ-3000; analyses the exact file off
  the USB stick rather than searching for it; takes rekordbox's beat grid and
  phrases (intro, up, down, chorus…) as the show's; and follows a DJ's mix
  from one deck to the other, blending onto the incoming drop or the incoming
  track's next phrase — see [PRO DJ LINK](#pro-dj-link)
- **Live input** — hears the music as it plays (what this PC plays, or a line-in
  off the booth), lines a known track's show up with what the room hears, and
  plays music nothing has analysed **by ear** — see [Live input](#live-input)
- **Spotify + OS clock** — a hybrid that takes the track, the ISRC and the queue
  from Spotify and the *position* from the OS media session, which is read
  locally rather than polled over the network. Around 11 ms of mean sync error
  against Spotify's own 189 ms, and never a backward jump — see
  [Spotify + OS clock](#spotify--os-clock-the-hybrid-source)
- Caches analyses on disk (up to 4 GB, dropping the least recently played
  first) and **prefetches the next tracks in the queue**, so a
  track change flips instantly instead of stalling for a download
- **Set-list warming** — paste tonight's tracks (or point it at a Spotify
  playlist) at load-in and have the whole night analysed before doors open

**Before the show**

- **Preflight** — one command that checks Art-Net reachability, the patch,
  Python, ffmpeg, yt-dlp and the analysis models before doors open
- **Set-list warming** — analyse the whole night up front, from a pasted list or
  a Spotify playlist, rather than relying on the live queue lookahead

**Setting up**

- **A first-run setup** — a fresh install walks through where the DMX goes,
  what is hung, where it hangs and what the lights follow, and ends on the
  pre-show check; it can be run again from Settings
- **The plan** — the Rig view's pixel map: drag fixtures to where they hang, and
  map an LED bar by drawing it on the plan from its first cell to its last while
  it lights up on the rig to show which end is which
- **Identify** — any fixture, universe, Art-Net node, WLED or Hue lamp shows
  itself on the rig: a par blinks, a bar lights its first cell green and its
  last red with a dot running between them
- **Finding the rig** — Art-Net nodes (and their locate LEDs), other sACN
  sources and the universes they share with you, WLEDs and Hue bridges
- **Rig, Sources, Settings and Preflight views** — every setting in the same app
  as the controls, a tab away (keys **4**–**7**)

**Fixtures**

- **GDTF and Open Fixture Library import** — drop in a `.gdtf` file or an OFL
  `.json`, or search the Open Fixture Library from the Rig view; pick a
  DMX mode, patch it
- **Multiple universes** — every fixture names the universe it lives on, so a
  rig is no longer capped at one node's 512 channels; a pixel strip longer than
  a universe runs on into the next ones, 170 RGB pixels to each
- **WLED** — find WLED strips and panels on the network and add one in a click;
  it is sent its pixels over DDP
- **Panels** — an LED matrix is a grid of cells on the stage plot, and the pixel
  effects draw across and down it
- **Art-Net and sACN (E1.31)** — run either, or both at once while a venue is
  migrating from one to the other. Art-Net finds the nodes on the network and
  sends each its universes directly, with ArtSync if you want it; sACN ends its
  streams properly and announces its universes
- **Its own thread** — the engine renders on a thread of its own at 44 frames a
  second, so planning a track or serving the UI never holds up the rig
- **16-bit dimming** where the fixture has it, and a software strobe for
  fixtures that have no strobe channel
- **Philips Hue** — Hue lamps follow rig fixtures through the Entertainment API,
  so they respond to every pattern, palette and cue the pars do
- Save and load the whole patch as a show file

---

## Quick start

Needs **Node.js 22.18 or newer**: the server is TypeScript, and Node runs it as
it is. `npm start` says so plainly on an older Node.

```bash
npm install
npm start
```

Open **http://localhost:3000**. A fresh install opens the setup, which walks
through the outputs, the fixtures, where they hang and the music — see
[Setting up the rig](#setting-up-the-rig). Everything it touches lives in the
**Rig**, **Sources** and **Settings** views afterwards.

Before a show, run `npm run preflight` — see [Pre-show check](#pre-show-check).

The auto-show needs Python and a few extras — see
[Auto show setup](#auto-show-setup). Manual control works without them.

---

## Network access

By default the server binds **127.0.0.1** and is reachable only from the machine
it runs on. Nothing more is needed for a normal single-machine setup.

To reach the UI from a phone or another machine, bind wider **and set a token**.
Both live under **Settings → Server & access**:

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

A browser that arrives without the token — including the one you generated it
in, which has nothing stored until you do this — is told so and asked for it:
the page covers itself with an **Access token required** prompt, and typing the
token there connects on the spot, no reload and no hand-built URL. That is worth
knowing because a refused handshake is never retried by the browser, so nothing
recovers on its own until the token is entered.

The same token goes in:

- **Companion** → the connection's *Access token* field
- **Browser extension** → its preferences page (server URL and token)

Cross-origin requests are refused whether or not a token is set, so a website
you happen to have open in another tab cannot drive the rig — over HTTP or over
the live socket.

The server also only answers to names it knows: any IP address, `localhost`, and
this machine's own host name (bare or with `.local`). That stops a web page from
pointing its own domain at your machine to get around the origin check. If you
reach the rig by some other name — `lights.lan`, a reverse proxy — set that
address as the **Public URL** in *Server & access*.

---

## Setting up the rig

The app has nine views. The first five run a show — **Manual**, **Auto Show**,
**Perform**, **Timeline** (**4**, [below](#the-timeline-view)) and **Stage**
(**5**, [below](#the-stage-view)) — and the other four set one up:

| View | Key | What is there |
|------|-----|---------------|
| **Rig** | 6 | *Plan & patch*: the plan, the patch table and the selected fixture. *Profiles*: the fixture library. *Outputs*: Art-Net, sACN, WLED, Hue, and the universes |
| **Sources** | 7 | The players the show may follow, Spotify, Deezer, the live input, and the analysis and its models |
| **Settings** | 8 | How the show behaves over a night, the MIDI controller and its mapping, MIDI clock, the engine, the server and access token, and the setup again |
| **Preflight** | 9 | The [pre-show check](#pre-show-check) |

A view with tabs of its own names them in the address: `/#rig/outputs` opens the
Rig view on its outputs. The old `/settings.html` and its tabs (`#music`,
`#output`…) land on the view that holds them now.

### The first-run setup

A fresh install — no `config/settings.json` yet — opens the setup over the app:

1. **Outputs** — Art-Net to a broadcast address (the ones this machine is on are
   offered) or to one node found on the network, sACN on or off, and any WLEDs
   found, added to the patch in a click.
2. **Fixtures** — each kind of fixture: its profile, how many, and where the
   first is addressed; the rest follow on, into the next universe when one
   fills. Each can be identified from the list.
3. **Placement** — the plan, to drag each fixture to where it hangs (see below).
4. **Music** — PRO DJ LINK, this computer's player, the live input, Spotify's
   client ID and secret.
5. **Check** — the pre-show check, run there and then.

It changes nothing it does not ask about, and leaving part way keeps what was
done. **Settings → Setup → Run the setup again** brings it back. A rig set up
before the setup existed is not offered it.

### The plan — placing the rig and mapping pixels

**Rig → Plan & patch** is the rig from above, the audience at the bottom. Where
each fixture is drawn is where the patterns find it: a chase travels across the
rig as it is placed here, and an LED bar's cells are where its line puts them.

- **Select** a fixture by clicking it, or its row in the patch table below
  (Shift or Ctrl adds). Drag across empty floor to pick several. The inspector
  beside the plan shows the one selected — label, universe, address, where it
  stands, a bar's length and angle, its trim — and changes any of it.
- **Move** by dragging (the selection moves together) or with the arrow keys
  (Shift for bigger steps). **Snap** keeps positions to a 2.5% grid and angles
  to 15°.
- **Turn and stretch** a selected bar by dragging the handle at its far end, or
  with `[` `]` and `-` `=`; `0` puts it back to its default line.
- **Draw bar** maps a bar in one gesture: select it and press *Draw bar*. It
  lights up on the rig — first cell green, last cell red, a white dot running
  from one to the other — and you drag on the plan from where its green end
  hangs to its red end. A bar hung backwards is drawn backwards, and runs that
  way. The next bar in the patch is then picked and lit, so a truss of bars is
  mapped one drag at a time; Esc stops.
- **Row** lines the selection up evenly; **End to end** puts the selected bars
  in one long line, in patch order; **Reset** forgets where they stand.

The patch table below the plan patches each fixture (label, profile, universe,
address), marks any two that share a channel, and adds a run of one profile in
one go: *how many*, *universe* and *from address*.

### Identify

Every fixture in the patch, every universe, every Art-Net node, WLED and Hue
channel has an **Identify** button. What it does on the rig, for eight seconds:

- **a par** blinks white, slowly;
- **a bar or panel** lights its first cell green and its last red, with a white
  dot running from the first to the last in wiring order — so a strip hung the
  other way round, or a panel wired in a snake, shows itself.

It goes over whatever the look is doing and through the master and a blackout
(it is asked for on purpose, and a lamp that stays dark answers nothing), at
the fixture's own trim. A Hue lamp that follows the fixture flashes with it.
Identify is shown on the plan and in the patch table on every open page.

- **An Art-Net node** is sent ArtAddress *locate*, which flashes its own
  indicators if it implements it, and everything patched on the universes it
  outputs flashes too.
- **A universe** (Rig → Outputs → Universes) flashes everything on it — the way
  to find an sACN receiver, which never announces itself.
- **A WLED** in the patch flashes through it; one not in the patch yet is sent
  the same picture directly over DDP and goes back to what it was doing when
  it stops.
- **A Hue channel** flashes with the fixture it follows; one that follows none
  is asked to identify itself by the bridge.

### Finding what is on the network

**Rig → Outputs** lists what answers:

- **Art-Net nodes** — who answered a poll, their universes, *Identify*, and
  *Send only here* to stop broadcasting and talk to that node alone.
- **Other sACN sources** — *Listen for other sources* listens for twelve seconds
  to the universe discovery every source sends and to the rig's own universes,
  and lists any console or server there with its priority. A universe this rig
  sends that another source sends too is called out: the higher priority wins.
- **WLEDs** — found over mDNS, identified, added in a click.
- **Hue bridges** — found, paired, and each channel bound to a fixture.

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

### Generic Hue Lamp profiles

Two profiles ship for Philips Hue lamps. A Hue channel follows a rig *fixture*
(see [Philips Hue](#philips-hue)), so a Hue-only lamp still needs one in the
patch — these exist so that fixture describes a light bulb instead of standing
in as a twelve-channel par. The patch then reads as what the rig really is, and
the DMX monitor shows four channels moving rather than twelve with eight of them
permanently dark.

| Profile | Channels | For |
|---------|----------|-----|
| **Philips Hue — Generic Lamp** | Dimmer, Red, Green, Blue, Warm White, Cool White, UV | White and Color Ambiance bulbs, light strips, Play bars |
| **Philips Hue — Generic White Ambiance Lamp** | Dimmer, Warm White, Cool White | Tunable-white bulbs, no colour |
| **Philips Hue — Generic White Lamp** | Dimmer | Plain white bulbs that only dim |

**Why the colour lamp is RGBWW.** A Hue colour bulb is not RGB: it has red,
green and blue dies *plus* a warm white and a cool white one, which is how the
same bulb does saturated colour and tunable white from 2000K to 6500K. Modelling
only RGB is not merely imprecise, it throws show content away — the colour
presets carry most of their white in the white and amber components, so *Cool
White* (`r0 g30 b80` with white at full) arrived as a dim dark blue and *Warm
White* as a dim dark orange. The white dies have to be in the patch for that
content to survive.

The show's colour model has no fourth and fifth primary to drive them with, so
the two dies are fed from the components that already carry exactly that
meaning: **warm white** from the warm (amber) content, **cool white** from the
neutral white content. Every existing preset, palette and pattern therefore
drives a Hue lamp correctly with no changes.

Patch one fixture per Hue channel, then bind them in **Settings → Philips Hue**.
The address hardly matters for a Hue-only lamp — nothing receives that universe
— but it still has to be unique, and the patch table flags overlaps as usual.

**UV yes, strobe no.** Two channels on the colour lamp are not emitters the bulb
has, and the difference between them is the rule. UV is carried because it
produces something: a Hue lamp cannot emit ultraviolet, but the deep violet a UV
wash looks like is a real stand-in, and without the channel every Hue lamp would
go black for the length of a UV look while the pars glowed. Strobe is left out
because it produces nothing — the bridge interpolates between frames and
discards a strobe value on arrival. Strobe and blinder effects still reach Hue
lamps as colour and brightness, they simply do not flash.

**What the bridge actually receives is still RGB.** The Entertainment stream
carries one of exactly two colour spaces — RGB, or xy plus brightness — and
neither has a white, warm white, cool white or colour temperature component.
Every channel is seven bytes: one of channel id and three 16-bit colour values.
So the white dies and UV fold into the colour that goes out, and the lamp's own
firmware decides which dies to light. The profile describes the lamp; the
transport is a separate question.

This server streams RGB, which gives the widest range per bulb. The xy
alternative is hardware-independent and would let brightness travel separately
from hue, at the cost of being mapped into each bulb's own gamut.

Where a mix sums past what one lamp can show, all three primaries are scaled
together rather than clamped one by one. Clamping moves the hue — amber
overflows on red and green but not blue, so it would arrive yellow. Scaling
keeps the colour and gives up brightness instead, which is the right way round
when there is a dimmer for brightness and nothing that can put a lost hue back.

The plain white profile needs no special handling anywhere: a fixture with no
emitters at all is already read as neutral white at its dimmer level.

Both are **built in**, so they cannot be deleted and loading a show file never
removes them.

### Other fixtures — GDTF import

**Settings → Import GDTF**: upload a `.gdtf` file, pick a DMX mode, and the
channel map is derived automatically. Patch fixtures to the new profile in the
same page. The patch table flags address overlaps, and the server refuses a
fixture whose channels would run past the end of the universe.

The import reads what GDTF says about the fixture's shape too:

- **A fixture with a geometry per cell** — an LED bar's `Pixel 1` … `Pixel 16`,
  either as geometries of their own or as one template placed N times by
  `GeometryReference`s — imports as a bar with cells (see below). The mode list
  says how many.
- **16-bit channels** (`Offset="1,2"`) count their fine byte in the footprint,
  and a 16-bit dimmer's fine byte is mapped.
- **Virtual channels** (no `Offset`) take no DMX address.
- A lamp with **warm and cool white** dies drives both; GDTF's amber,
  `ColorAdd_RY`, is amber.
- **Shutters and strobes** are read from their channel functions. A strobe
  channel is the show's strobe only when it is open at rest and strobes across
  the show's standard range (128–250); otherwise the show flashes the fixture
  itself. A shutter closed at rest is held open, a dimmer the show does not
  drive is held at full, and every other channel it does not drive sits at the
  file's default (`InitialFunction`, or GDTF 1.0's `Default`). Before this, a
  moving head whose shutter is closed at 0 imported dark.
- A channel on a **second DMX break**, or past channel 512, is left out, and the
  import says so beside the channel list.

A bar imported before cells existed is still one light. Import it again: the
profile is replaced under the same id, and every fixture on it becomes a bar of
cells on the next frame.

### Other fixtures — the Open Fixture Library

The [Open Fixture Library](https://open-fixture-library.org) describes
thousands of fixtures, most of the cheap LED bars and pars among them, which
rarely ship a GDTF file. Two ways in, both under **Settings → Fixture
Profiles**, both ending in the same mode picker as a GDTF import:

- **Search the Open Fixture Library**: type a name ("pixel bar", "root par") and
  pick a result. Needs the internet; the server fetches the fixture from
  open-fixture-library.org and nowhere else.
- **Import OFL File**: a fixture's `.json`, downloaded from its page on the
  library. Works offline. The file does not say who makes the fixture, so type
  the maker into the picker's *Manufacturer* field.

What a mode becomes:

- **Dimmer and colours** are what the show drives: red, green, blue, white,
  amber and UV (warm and cold white each when a lamp has both). A dimmer with
  its fine channel in the mode is 16-bit. Cyan, magenta, yellow, lime and indigo
  are not mixed, and the picker says so.
- **Pixels become cells.** A pixel bar's per-pixel mode imports as a bar with a
  cell per pixel, and a mode that drives halves or quarters as a bar with a cell
  per group. Cells go in the order they sit along the bar, which is not always
  the order they are numbered. A group of every pixel (OFL's "Master") is the
  whole fixture. A grid of pixels is laid along one line, row by row.
- **The strobe channel** becomes the show's strobe when it is open at rest and
  flashes across the show's standard strobe range (128–250). Otherwise the show
  flashes the fixture itself, as for a fixture without one.
- **Every other channel** sits at the library's default value, except that a
  shutter closed at 0 is held open and a dimmer the show does not drive is held
  at full, so an imported fixture is never dark for a reason you cannot see. The
  channel preview highlights what the show drives and shows `=value` on what it
  holds.
- A channel that **changes meaning with another** (a speed that becomes a sound
  sensitivity once a program runs) is read as what it is while that other
  channel sits where the import holds it.

Modes the show cannot use (more than 512 channels) are left out, and the picker
says why.

### LED bars

A bar is eight, sixteen or more lights in one fixture, each cell with its own
red, green and blue (and white, amber, UV or a cell dimmer). Every cell is
rendered as a light of its own: a wave rolls along a bar, a comet runs down it,
and a gradient spreads across all of them.

**Getting one into the patch**

- From **GDTF** or the **Open Fixture Library**, as above.
- Without either, **Settings → Fixture Profiles → Make an LED bar
  profile**: the number of cells, the channel the first cell starts on, the
  order of each cell's channels (`RGB`, `RGBW`, `DRGB` with a cell dimmer
  first…), the spacing between cells if the bar leaves gaps, and the channels
  the whole bar shares (a master dimmer, a strobe). The channels preview as you
  type; the numbers are on the back of the bar's manual.

**On the stage plot** a bar is drawn as its cells, along a line centred on its
position. In **Position fixtures** mode, drag the handle at its far end to turn
it and to lengthen or shorten it; with the bar focused, `[` and `]` turn it,
`-` and `=` change its length, and `0` puts it back to a straight line across
the stage. That line is where the cells are for every pattern, so draw it where
the bar hangs.

**How patterns use the cells.** The pictures — Wave, Ribbon, Ensemble, Rainbow,
Twinkle, Sparkle and the five pixel effects — are drawn across every cell. The
stepped patterns — the chases, Split, Sections and the like — travel through
*fixtures*, and a bar takes its step's colour on every cell, so a chase across
four pars and two bars has six stops, not thirty-six.

**Levels.** Each cell is driven so it looks exactly as a par with the same
channels would at the same level: the bar's dimmer follows its brightest cell,
and each cell makes up the rest. A look that is the same on every cell drives a
bar with exactly a par's values; a kill or a silence closes the bar's dimmer
as well. A bar without a strobe channel is flashed in software (see
[Strobe](#strobe-without-a-strobe-channel)). A Hue lamp bound to a bar shows the
mean of its cells.

**Panels.** A profile can put its cells in rows and columns — an LED matrix —
with `grid: { columns, rows }`, each cell's place in it given by `at: { x, y }`
or, without, row by row in the order the cells are listed (so a panel wired as
a serpentine says so cell by cell). On the stage plot a panel is a rectangle of
square cells: its line, turned and stretched like a bar's, is its top edge, and
its rows run below it. The pictures cross it in two dimensions, and with **Per
bar** each panel draws the whole picture across and down itself. An Open
Fixture Library matrix of two axes imports as a panel, and so does a WLED set up
as one.

**Strips longer than a universe.** A profile longer than 512 channels must be a
plain strip — equal cells one after another, nothing for the whole fixture —
patched at channel 1. It runs on into the next universes with whole pixels to
each, as pixel controllers (and WLED over Art-Net) expect: 170 RGB pixels, or
128 RGBW, to a universe. The patch table shows where it ends ("1–390 on 2"),
and everything that reads the rig — the monitor, the previews, the Hue lamps,
the overlap checks — follows each pixel to its universe. The bar maker builds
one when it is plain pixels from channel 1.

**How much.** The engine renders up to 4,096 cells, up to 1,024 to a fixture
(a 1,024-pixel strip, or a 32 × 32 panel). Measured on the engine's thread,
4,096 cells cost 0.5–2 ms a frame for most patterns and 6–7 ms for the heaviest
(Plasma, Gradient), out of the 22.7 ms each frame has.

### WLED

[WLED](https://kno.wled.ge) strips and panels are sent their pixels over
[DDP](https://kno.wled.ge/interfaces/ddp/) — one run of bytes per frame, 480
RGB pixels to a packet — rather than as universes of Art-Net.

**Settings → Output → WLED → Find WLEDs** asks the network (mDNS, which does not
cross routers or VLANs) and lists every WLED that answers with its LED count;
**Add to patch**, or **Add by address** for one mDNS cannot see. Adding one asks
it for its name, how many LEDs it has, whether they have a white channel, and —
set up as a 2D panel in WLED — its width and height, and builds its profile from
that. It is patched on the first free universes from 1, from channel 1, and is
then a fixture like any other: on the stage plot, in the patterns, in the
monitor.

- Its universes go to it and nowhere else, so nothing else may be patched on
  them; the patch says so if you try.
- Its row in the patch table shows its address. Change it when the WLED moves;
  empty it to send the fixture on Art-Net and sACN instead.
- Removed from the patch, it is sent one dark frame. WLED then hands the strip
  back to its own effects after its realtime timeout (Settings → Sync
  Interfaces in WLED), so set a preset of "off" there if it should stay dark.
- The pre-show check asks every WLED in the patch: one that does not answer
  fails, and one whose LED count has changed since it was added warns.
- A WLED with more than 1,024 LEDs is more than one fixture takes: split it into
  segments in WLED and give each its own address, or drive it over Art-Net.

### Output protocols

Frames go out over **Art-Net**, **sACN (E1.31)**, or both — each universe is
sent on every protocol that is enabled, so a rig can run one node on Art-Net
and a console on sACN at the same time.

| | Art-Net | sACN (E1.31) |
|---|---|---|
| Settings section | *ArtNet Output* | *sACN (E1.31)* |
| Default | on | off |
| Port | 6454 | 5568 |
| Addressing | broadcast, or straight to the nodes it finds; or unicast to the node IP | multicast to `239.255.x.y` per universe, or unicast to a node IP |
| Universe numbering | from 0 | from 1 |
| Frame sync | ArtSync (optional) | — |
| On stop | a black frame | a black frame, then stream-terminated packets |

**Finding Art-Net nodes.** While *Node IP* is a broadcast address — the default
`2.255.255.255`, or anything ending in `.255` — and **Find Nodes** is on (the
default), the server polls every network it is on every three seconds and
sends each universe a node outputs straight to that node. That is what makes a
first night on a `192.168.x` network light up without typing anything, and it
keeps the rig's traffic off every other device on the network. A universe no
node claims still goes to the broadcast address, so a node that never answers
polls — plenty don't — is driven exactly as before. The nodes that answered are
listed under *ArtNet Output*, with *Send to this node* to talk to one node and
nothing else. With *Node IP* set to one node, or to this machine (a visualiser
running here), nothing is polled and nothing changes.

**ArtSync.** With it on, every frame ends with an ArtSync, and a node that
supports it changes all its universes at that instant — a wall of LED bars
across several universes moves as one instead of in a ripple. Leave it off for
nodes that don't support it.

**Ending a stream.** A universe that leaves the patch, and every universe when
the server stops, gets one black frame; over sACN that is followed by three
stream-terminated packets, so a receiver lets go at once instead of holding
the last frame until it times out. Changing sACN's settings (another offset,
another node, turning it off) ends the old streams the same way. Every ten
seconds the server also lists the universes it is sending on sACN's discovery
group, so a console can show this source without being told.

**Network.** On a machine that is on two networks — the show network and the
house one — pick the show network under *sACN (E1.31) → Network*, so the
multicast groups go out where the nodes are.

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

### The engine

Every frame is rendered on a thread of its own, forty-four times a second —
the fastest a full DMX line refreshes, and the most E1.31 lets a source send.
The main thread runs the server, the UI, the auto show's planning, the uploads
and the integrations; any of those can hold it for tens of milliseconds, and
the moment a new track starts is exactly when it does. The engine's thread
keeps rendering through that: a few milliseconds before each frame the main
thread fires the auto show's cues and hands the engine the look and where the
music is, and when that hand-off is late the frame still goes out on time, with
the beat carried forward.

Each frame is due at a fixed time, so a late frame does not push the rest later
and the rig does not drift. **Settings → Engine** shows where the engine is
rendering and how its frames have gone over the last minute; the pre-show check
warns about frames that went out late. *Render On → The main thread* is how it
ran before, and is only worth choosing to rule the thread out when chasing a
problem. If the thread cannot start, or stops three times in a minute, the
engine renders on the main thread instead and says why.

**16-bit dimming.** A fixture whose profile has a *Dimmer Fine* channel is
dimmed with sixteen bits, so a slow fade to black glides where it used to step.

#### Strobe without a strobe channel

A fixture with a strobe channel strobes itself. One without — plenty of LED bars
and cheap pars — is flashed in software through the strobe pattern and every
strobing burst: one to twenty flashes a second from the strobe speed, each a
frame to 50 ms long, all such fixtures together (the random strobe functions
flash each on its own). A Hue lamp, or a fixture a Hue channel follows, is never
flashed: a bridge cannot keep up, and Hue's own guidance is to keep effects
slower than that.

### Philips Hue

Hue lamps can run from the same show as the pars, through the **Hue
Entertainment API**. Unlike Art-Net and sACN this is not a universe transport —
a bridge has no idea what a universe is. Instead each channel of an
entertainment area **follows one rig fixture** and shows whatever colour that
fixture is showing, so every pattern, palette, cue and auto-show decision
reaches the Hue lamps without anything being written twice.

The colour is read from the rendered DMX frame, which means it arrives with the
fixture dimmer, the per-fixture trim, the grand master, any override and master
blackout already applied. Black out the rig and the Hue lamps go out with it.

**Setting it up**

1. Build an **entertainment area** in the Philips Hue app and put your lamps in
   it. Areas are made there because that is where the lamps are already placed
   on a room plan; this server only reads them.
2. Open **Settings → Philips Hue** and press **Find Bridges**, or type the
   bridge IP in. Discovery uses Philips' cloud service, so a show network with
   no route to the internet will need the address typed in.
3. Press the round button on the bridge, then press **Pair** within 30 seconds.
   The bridge issues an application key and a client key, which are stored as
   secrets in `config/settings.json` and never shown again. The client key is
   only ever returned once, so a lost pairing has to be made again.

   A third value, the **application id**, is fetched at the same time. It is the
   identity the encrypted stream authenticates with, and it is what the Hue app
   shows as the holder of an entertainment area. It is not a secret, so it stays
   readable in the settings. A pairing made before this was stored resolves
   it on the first connection and saves it then.
4. Pick the **entertainment area**. A bridge streams one area at a time.
5. Bind each Hue channel to a fixture in the **Channels** table, then **Apply**.
   Each row names the lamp as you named it in the Hue app, so you bind *Right*
   rather than counting round the room to work out which lamp channel 3 is. A
   lamp that renders several channels, such as a gradient strip or a Play bar,
   has them numbered in the order the area lists them. A channel left as *not
   used* is never sent, so the bridge keeps its own colour for that lamp.

Until at least one channel is bound, the server does not contact the bridge at
all. Opening a stream puts the area into entertainment mode, which takes those
lamps out of normal Hue control — worth doing only once something is actually
driving them.

**Fixtures for Hue-only lamps.** A Hue channel follows a fixture, so lamps with
no DMX equivalent still need one to follow. Patch one for each — on a spare
universe if you like, since nothing has to receive it — and the show drives it
exactly as it drives a par. Two built-in
[Generic Hue Lamp profiles](#generic-hue-lamp-profiles) are there for this, so
the fixture describes a bulb rather than standing in as a twelve-channel par.

**How emitters are translated.** A Hue lamp has red, green and blue and nothing
else, so the other emitters are folded in rather than dropped:

| Fixture emitter | On the Hue lamp |
|---|---|
| Red, green, blue | as-is |
| White | lifts all three equally |
| Warm white | tungsten, around 2700K — less saturated than amber, because a warm white still has real blue in it |
| Cool white | daylight, around 6500K — near neutral with a faint blue lean |
| Amber | warm — full red, three-quarter green |
| UV | deep violet, because Hue cannot emit UV and black would read as a dead lamp |
| No emitters at all | the dimmer, as neutral white |

A mix that sums past full is scaled as a whole so the hue survives; see
[Generic Hue Lamp profiles](#generic-hue-lamp-profiles).

Values are widened from 8-bit to the 16-bit the bridge takes, so fades that
would band on a DMX par do not here.

**Things worth knowing before a show**

- A bridge allows **one** entertainment stream at a time. If the Hue app's sync
  feature, Hue Sync Box or another tool is streaming, this cannot connect — the
  pre-show check reports it. The area's `active_streamer` field names whoever
  is holding it.
- An area carries at most **20 channels**, which is also the most a single
  stream message can address, so that is the cap on channel bindings.
- The stream is DTLS 1.2 with a pre-shared key on UDP 2100, and the bridge drops
  it after about ten seconds of silence. The show's own frames are the
  keepalive, going out at the render rate of 44 Hz against Hue's recommended
  50-60 Hz. Note that is the *message* rate: the bridge relays over ZigBee at a
  maximum of 25 Hz, so Hue's guidance is to keep effects themselves below about
  12.5 Hz, which is a property of the show rather than of this transport.
- The bridge needs software version 1948086000 or newer for the Entertainment
  API to exist at all.
- A bridge that is off, unreachable or busy is retried with a backoff rather
  than on every frame, so nothing stalls the render loop. Turning the show off
  sends one black frame and closes the session, so the lamps do not sit holding
  the last look.
- Deleting a fixture leaves any Hue channel bound to it pointing at nothing.
  That lamp simply stops being sent, which on the night looks like a dead lamp —
  the pre-show check catches it, so run it after editing the patch.
- **Forget** clears the credentials here but does not unregister this server on
  the bridge. Remove it in the Hue app under linked devices.

**Lining the pars up with the lamps**

Art-Net reaches a node in about a millisecond; a Hue lamp hears the same frame
through the bridge and a ZigBee hop, tens of milliseconds later. On a mixed rig
every hit therefore lands on the pars first and the lamps after, which on a
snare reads as two events. **Pars Delay (ms)** in Settings → Philips Hue holds
the Art-Net and sACN output back by that much; Hue is sent each frame as soon
as it is rendered. It defaults to 0 and only applies while Hue output is on.

To tune it, press **Flash for 10 s** under the stream status: every fixture
flashes white once a second. Film a par and a lamp together in slow motion,
raise the delay until the two flashes land on the same frame, and save. Start
around 50 ms. The shutdown blackout skips the delay, so the rig still goes
dark the moment the server stops.

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
last fixture moved away. The server transmits at most **64** universes.

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
connected account's playlists from the dropdown, or paste a link — a share link,
a `spotify:playlist:…` URI or the bare id all work. Unlike the queue, a playlist
exists before anything is playing, which is the case warming was built for.

Since Spotify's February 2026 API changes, it only lists the tracks of playlists
the connected account **owns or collaborates on**. To warm someone else's, add
its tracks to one of your own playlists first (*Add to other playlist* in the
Spotify app), or paste them as a set list.

Tracks keep their Spotify id, so a warmed playlist track is already cached under
the exact key the live path looks up when it plays. Podcast episodes and tracks
pulled from the catalogue are skipped; local files in a playlist are warmed by
name, the same way a pasted line is.

Private and collaborative playlists need the `playlist-read-private` and
`playlist-read-collaborative` scopes, which are requested at login. A Spotify
connection made before this feature existed does not carry them — Spotify then
reports your own playlist as simply not found — so reconnect Spotify under
Sources. Public playlists work either way.

Progress is live — each track shows *queued*, *analysing*, *cached* or *failed*.
Tracks already on disk are skipped without touching the analyser, so re-running
a list is nearly instant. A track yt-dlp cannot find is recorded and the rest of
the list continues.

Warming runs at normal priority, so a track change during a set never sits
behind an hour of it. The song that starts playing is submitted as the current
track: it jumps the queue and interrupts the warm job already running, which
keeps its audio and is re-analysed as soon as the live track is served.
**Stop** ends the queue; the track being analysed at that moment finishes, since
abandoning it would mean throwing away work that was nearly done.

Up to 200 tracks per run.

---

## Pre-show check

Everything in this stack degrades quietly on purpose. Art-Net send failures are
logged and the render loop carries on. A missing MuQ-MuLan checkpoint drops
genre classification and falls back to a mood palette. An absent ffmpeg only surfaces
when the first track downloads. Individually that is right — none of it should
take the show down mid-set. Collectively it means the first sign of a broken rig
is the rig not working, in front of an audience.

```bash
npm run preflight
```

It asks every one of those questions while there is still time to fix the
answer, and exits non-zero if something will not work:

```
  [ok]   Engine             Rendering on its own thread. 44 frames a second; 0.8 ms to render a frame (p95), …
  [ok]   Art-Net output     2 nodes answered: DMX-1 at 192.168.1.50 (universe 0), …
  [--]   sACN output        Disabled. Turn it on in Settings → sACN (E1.31) …
  [ok]   Philips Hue        "Living Room" on 192.168.1.40, 3 of 5 channels bound to fixtures.
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

What it checks: the engine (where it is rendering, and whether its frames have
gone out on time), Art-Net reachability (it sends an ArtPoll and lists the nodes
that answer), the sACN configuration, universe mapping and network, the Hue bridge (that
it answers, that the entertainment area still exists, and that every channel is
bound to a fixture that is still patched), the fixture patch
for overlaps and out-of-universe addresses, the bind address and token, the
MIDI controller, the Python interpreter and the analyser's imports, ffmpeg,
yt-dlp, the analysis model weights, the optional PANNs checkpoint, the analysis
cache, and which playback sources are connected.

The same report is the **Preflight** view (key **7**) — run there,
it also sees the *live* MIDI and playback-source connections rather than only
what is configured. If a model the show needs is missing, it starts downloading
it in the background and says so; the show keeps running, and the progress is
under Sources → Analysis models. **Model stack** imports torch, torchaudio,
torchvision and the models for real, which catches a torch build mismatch that a
plain "is it installed" check cannot see, and names the device they run on.

A node that never answers an ArtPoll is a warning, not a failure: plenty of
them do not implement it, and a broadcast rig works fine without ever replying.

---

## Keeping time — the musical clock

Every pattern keeps time by one clock: a continuous beat position, 0 on the
first beat of the song, 1 on the second, 2.5 halfway between the third and the
fourth. Each chase step, the fade's eight-beat breath, the hit's decay and the
sweep of the expressive patterns are worked out from it every frame, so nothing
accumulates and nothing drifts: a chase is on the same step whether the show
played into the moment or was seeked there.

What the clock follows, best first — the badge under the BPM says which:

| Badge | Following |
|---|---|
| **Auto** | The auto show is running: the track's analysed beat grid at the show's position, sync offset included. A drummer who pushes the chorus or a DJ who pitches the track is followed beat by beat. |
| **CDJ** | PRO DJ LINK is on and a deck is playing: the position of the deck the room hears, through rekordbox's own beat grid. |
| **Track** | The auto show is off, but the song playing (Spotify, the hybrid source, the OS media session or the Deezer extension) has an analysis in the cache: manual patterns lock to its beats. A song that is not analysed yet locks as soon as a prefetch, a warm or an analyse request writes one. |
| **Live** | The live input hears the music and has found its beat: for a track nothing else knows. See [Live input](#live-input). |
| **Tap** | None of those: a free-running clock at the BPM you tap, type, nudge or send over MIDI. |

The BPM read-out follows the clock, to a tenth: a 123.7 BPM song shows 123.7,
and ± nudges from there. **Tapping or setting a BPM takes the tempo back from a
locked song** until the next song, which locks again; the take-over starts from
the beat the music is on, and a single tap keeps the song's tempo until a second
tap measures a new one. Recalling a cue while the clock follows a song brings
back the look and leaves the song's tempo in charge.

When a song pauses, the clock carries on at its tempo rather than freezing the
rig on one step, and locks again when the music resumes. Stopping the auto show
hands over to the song or the free clock mid-beat, without restarting the chase.

A scene from the auto show counts its steps from the beat it was scheduled on,
not from the frame that fired it, and cues fire from the render loop itself, so
each lands in the frame it is due. Walked against the analysed beats of the
test tracks, every step shows within one 22.7 ms render frame of its beat for the
whole track. The timer-driven chase this replaced ran at a whole-number BPM from
whenever its scene happened to fire; modelled on the same tracks, it was 80–200
ms off the beat by the end of a sixteen-bar scene.

---

## Colours, patterns and palettes

### The colour presets

A party rig is watched from across a dark room, through haze, on lamps that are
usually moving or flashing. Two colours a screen shows as clearly different — a
260° violet and a 264° "actinic", say — arrive at the audience as the same
colour, so a long list of near-neighbours is a list where most of the buttons do
the same thing.

The table is built the other way round: the fewest colours that are all
*obviously* different from one another, with the four slots left to do the
combining. Nine saturated hues, none closer than 30° on the wheel:

| | | | |
|---|---|---|---|
| Red 0° | Amber 37° | Lime 85° | Green 140° |
| Cyan 187° | Blue 220° | Congo Blue 258° | Violet 288° |
| Magenta 325° | | | |

Then five things a hue cannot do: **Warm White** and **Cool White** (warm-vs-cool
is the one white distinction that carries across a room), **Lavender** and
**Moonlight** (the pale tier — deliberately desaturated washes to leave up under
everything else, for the quiet end of the night), and **UV**, which no RGB mix
approximates. Plus **Blackout**, which stays last.

Everything that used to sit between two of these — Coral, Flame, Gold, Sun,
Yellow, Rose, Fuchsia, Teal, Mint, Sky, Indigo, Actinic, Acid — collapsed into
its nearest neighbour. Nothing was lost that a pair of slots cannot rebuild.

Yellow is the one that may look missing. The amber emitter puts Amber at 37° and
an RGB yellow at 60°: a difference on a screen, not one across a dark room. Amber
is also the more useful half of that pair on a party rig, since an RGB yellow
tends to arrive as dirty white once there is any haze in the air.

### The patterns

Eighteen, grouped by what the rig actually *does* — which is what an audience
tells apart:

| | |
|---|---|
| **Whole rig** | Solid · Fade · Hit · Strobe · Colour Cycle · Rainbow |
| **Travelling** | Chase → · Chase ← · Ping Pong · Runner · Pairs · Wave · Stack Up |
| **Sectional** | Split · Sections |
| **Random** | Twinkle · Sparkle · Random Flash |

There used to be twenty-five, but several were one pattern wearing different
names. `split`, `split-3` and `split-4` were the same renderer picked three
ways; so were `chase` / `chase-3` / `chase-4`, `alt-halves` / `alt-thirds` /
`alt-quarters`, and `pairs` / `pairs-4`. The only thing the suffix changed was
how many colours the pattern reached for, which meant an operator on a
two-colour palette had to know not to press the `-4` button.

A pattern now reads that off the look itself: the four slots wrap a smaller
palette (a duo fills them A/B/A/B), so counting the distinct ones recovers the
size that was picked. One `split` covers all three. `alt-halves` became
**Sections** — the rig divides into one block per palette colour and the blocks
rotate each beat — because with a variable block count the old name was wrong
two thirds of the time.

**Rainbow** is the one pattern that ignores the palette, spreading a full
spectrum across the rig; no set of solid presets approximates that, which is
why it survives the fold and why the auto show never picks it. **Colour Cycle**
used to ignore the palette too and was excluded for the same reason — it now
steps the whole rig through the look's colours, so it has joined the pool.

**Pixel effects** — pictures drawn across every cell of the rig's LED bars.
They run on pars too, as a handful of samples of the same picture, but they are
made for bars. The auto show uses four of them on a rig of pars as well —
Gradient, Plasma, Comet and Burst read on a row of lamps — and Drums when the
track's drum lanes can be trusted (below):

| | |
|---|---|
| **Gradient** | The look's colours as a gradient across the rig, scrolling a full cycle every sixteen steps |
| **Comet** | A head crossing the rig every four steps with a tail that is long in slow music and short when it drives; each lap in the next colour |
| **Burst** | A ring thrown out from the centre of the stage on every step |
| **Plasma** | Three slow interfering waves in the look's colours |
| **Meter** | A level meter filled by the low end and kicked on every step |
| **Drums** | The kit as it is hit: the kick fills each bar from its middle, the snare cracks at its ends, the hats scatter along it |
| **Stems** | Voice, band, drums and bass in zones out from the centre, each as loud as it is playing |

**Drums** and **Stems** play the analysis's *pulse*. That is every kick, snare
and hat read off the separated drum stem, and each stem's level fifty times a
second, sampled at the playback position every frame. The auto show uses them
on a rig with bars, for tracks analysed since they arrived, and Drums on a rig
of three or more pars too — the kick in the middle lamps, the snare at the
ends — when the lanes were found by the rules measured on real drumming.
Chosen by hand without an analysed track, they fall back to the clock: a kick
on every step, a snare on every other.

**Hit** follows the drums the same way. With those lanes it flashes the rig on
each kick (and, on the separated drum stem, each snare) as hard as it was hit,
with the step's own pulse still there underneath at half height — so a
breakbeat, a half-time groove or a live drummer flashes where the drums do and
not only on the grid. Without them, it pulses on every step as it always has.

With three or more fixtures in the patch, the pattern card also offers how the
look lies over the rig: **Across stage** (as the lamps stand on the plot) or
**Mirrored** (about the centre of the stage: a chase runs from the middle out
to both ends at once, a stack builds out from the centre). With bars there is
also **Per bar** (each bar draws the whole picture along itself). Cues remember
the choice.

### The palettes

Sixteen named looks — the same bank the auto show locks a song to, offered by
hand. One press writes all four colour slots with colours that were picked to
sit together, which is the fiddly part of driving the rig manually.

Every four-colour look is four slots with four different jobs, in this order:

| Slot | Job |
|------|-----|
| **A** | **dominant** — the colour the look is named for, the one most on stage |
| **B** | **contrast** — its opposite. A and B carry `split`, `alt-halves` and the two-colour chases, so this pair has to survive being the only two colours in the room |
| **C** | **accent** — a third well-separated hue for the 3- and 4-colour patterns |
| **D** | **lift** — a white, a pale wash or UV. Not a fourth hue: without a brightness break, a four-colour chase reads as a rainbow rather than as a look |

No two *saturated* colours in one look sit within 30° of each other. Where a look
does hold two from the same family they are on different saturation tiers on
purpose — `violetDream` puts its violet over a pale lavender — which the eye
reads as depth rather than as a repeat.

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

These rules are enforced by `tests/unit/color-design.test.js`, so a new preset
that lands three degrees from an existing one fails the build rather than quietly
making two buttons do the same thing.

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

## Fixture groups

Each fixture card has a **Group**: Front, Back, Room or Floor. The auto show
uses them to split a look in two. In a driving passage on a travelling pattern
(a chase, a runner, a sparkle), one group holds a steady wash in colour B while
the rest of the rig runs the pattern in stage order among themselves. The same
chorus splits the same way each time it returns; which group washes is picked
from the groups actually in use.

Nothing splits with fewer than two groups in use, so an ungrouped rig runs
exactly as before. Resting passages, drops, build-ups and whole-rig looks
(solid, strobe, fade, hit, ribbon, ensemble) always use the whole rig, and
ungrouped fixtures always run the pattern. The rehearsal preview shows the
split too. Groups are saved with the patch.

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
is the whole rig, not a partial edit. The saved tempo applies when the clock is
running free; while it follows a song, the song's tempo stands.

They are stored in `config/cues.json` and survive restarts. Up to 128.

Cues saved before the colour table was rebuilt do not carry over: they store
colour *indices*, and every index now names a different colour. A stored index
of 15 or above no longer exists at all, so such a file fails validation and is
moved aside to `config/cues.json.invalid-<timestamp>` on the first start after
the upgrade — nothing is deleted, but the set list has to be built again.

---

## Energy overrides

Panic-button effects that instantly override patterns and per-fixture settings.
One at a time. They are scaled by the grand master and each fixture's maximum
brightness — the master is the one hand you keep on the whole rig, and it should
still mean something at the moment you hit the blinder.

| ID | Name | Effect |
|----|------|--------|
| `white-strobe` | White Strobe | Cold white, fastest strobe |
| `color-strobe` | Colour Strobe | Colour A, fastest strobe |
| `blinder` | Blinder | Every emitter at full — the brightest the rig goes |
| `uv-wash` | UV Wash | Blacklight — UV alone, no strobe |
| `kill` | Kill | Everything out for as long as it is held |

Five effects covering four separate jobs, so no two buttons do the same thing: a
strobe punch that is either cold or in the look's own colour, a held wall of
light, and a held *dark* moment that is either blacklight or nothing at all.

`blinder` and `all-on` used to be two entries that both meant "a white wall at
full", differing only in whether amber and UV joined in — which from the floor is
not a difference. They are now one effect driving every emitter that makes
visible light, which is brighter than either was. `uv-strobe` gave way to
`uv-wash`: a third strobe was the one thing the list already had.

`kill` is not master blackout. The master is a latching switch on the whole rig;
this is momentary and auto-clears, which is what you want under a thumb on a drop.

Trigger from the UI, MIDI (encoder push 8 — hold to activate, release to clear),
REST, or Companion. Clear with `energyOverride: null`.

---

## Auto show setup

The analyser is Python. Manual control does not need any of this.
[docs/audio-analysis.md](docs/audio-analysis.md) covers what it does, which
numbers you can turn and where to extend it.

With [uv](https://docs.astral.sh/uv/), one command builds the environment from the lockfile. Pick the
torch build for the machine:

```bash
uv sync --extra cpu        # no GPU
uv sync --extra cu128      # an NVIDIA card
uv sync --extra rocm       # an AMD card on Linux
```

The server finds the `.venv` this makes by itself. The lock keeps torch,
torchaudio and torchvision on one build. A torchvision from another build
installs without complaint and then fails every model with
`operator torchvision::nms does not exist`. Without uv,
`pip install -r requirements.txt` into a Python of your own still works: install
torch, torchaudio and torchvision together from one index first.

**The model weights** come next, before the show and not at load-in on venue
wifi. The analysis never downloads them itself. Settings → **Analysis Models**
lists each one: what it is for, whether it is here, its size and licence. It
fetches the missing ones with a progress bar, and restarts the analyser to use
them. From a terminal:

```bash
python scripts/download-models.py --list   # what is here
python scripts/download-models.py          # what the show needs (~4 GB with MuQ)
python scripts/download-models.py --only songformer,panns
```

**ffmpeg** and **yt-dlp** must be on `PATH`. The Python environment covers
yt-dlp; install ffmpeg with your package manager.

yt-dlp needs to be **2025.11.12 or newer**: YouTube now requires a JavaScript
runtime to download at all. You do not need to install one — the server hands
yt-dlp the Node it is itself running on. The pre-show check warns about an older
yt-dlp; `pip install -U "yt-dlp[default]"` updates it.

**torch is required.** The beat grid, the metre and the instrument roles come
from models — a beat-tracking transformer and a source separator — and there is
no signal-processing fallback for the beat grid. The chain that used to be there
reported a 99 BPM pop song at 198, because reasoning about periodicity cannot
tell a song counted at 99 from the same song counted at 198. An analyser that
cannot load the model says so and names the install command, rather than quietly
returning a worse answer under the same field name.

CUDA is used when it is there and threads when it is not; `ARTNET_ANALYSIS_DEVICE=cpu`
forces threads, which is worth setting on a one-machine rig whose GPU is already
driving a visualiser. On CPU expect roughly 0.6× realtime, most of it separation
— set `separate_sources=False` in `src/analysis/config.py` to trade the
stem-derived instrument roles for a 4× faster analysis.
`python scripts/bench-analyze.py track.wav` shows where a machine spends its
time, stage by stage.

**Structure.** Settings → Analysis → **Structure** decides who names the
sections. [SongFormer](https://huggingface.co/ASLP-lab/SongFormer) was trained
on thousands of annotated songs. It knows a pre-chorus, a chorus that is not the
loudest part, and an instrumental break. Without it, the sections come from where
the music repeats, and arrangement rules supply the names. **Auto** uses SongFormer
when the analyser has a GPU and its weights (2.9 GB) are downloaded. On a CPU it
takes most of the track's length, so there it is only used when set to
**SongFormer**. Its memory grows with the square of how much of the track it
reads at once, so it reads in windows sized to the memory that is free: a long
track in a machine with little to spare is read in shorter windows, and one
that has not enough for even a minute falls back to the arrangement rules.
Scored against human annotations of ten live recordings, the sections it
produces match the annotated names over 68 % of the track, where the
arrangement rules manage 33 % (`scripts/eval-structure.py` runs that check).
Try it on the show machine first:
`python scripts/bench-analyze.py track.wav --structure songformer`.

**Separator.** Settings → Analysis → **Separator** picks the model that splits
each track into stems. **Demucs** is the default and keeps up with a live set.
**BS-RoFormer** takes about seven times as long, so the playing track is rarely
ready in time. On a Radeon 890M, a 3½-minute track takes about 60 s with Demucs
and about 400 s with BS-RoFormer. Changing it restarts the analyzer; tracks
already analysed keep their cached result.

**AMD GPUs** run through ROCm. Install torch from AMD's index before
`requirements.txt`; the comment above `torch` there has the command and the
version pairing. The analyser turns AMD's MIOpen library off, because
the Windows nightlies cannot compile its BatchNorm kernel. It also handles a
known ROCm fault: when a GPU FFT fails mid-track, that track finishes on the
CPU and the analyzer restarts itself before the next one.

PANNs (the AudioSet tagger) stays optional. Genre no longer depends on it:
genre comes from MuQ-MuLan, scored zero-shot against the subgenres by name. What
PANNs still supplies is the instrument-role priors, and a genre fallback for a
rig that has it but no MuQ-MuLan checkpoint. Without either, palette selection
falls back to a mood-based path. Fetch it under Analysis Models or with
`python scripts/setup-panns.py` (~310 MB, over HTTPS with verified digests). A
track never waits for it: without its weights the analysis simply goes untagged.

### Which Python?

The environment `uv sync` made (`.venv` in the project folder) comes first when
it exists: it was built for this project from its lockfile. Otherwise, having
*a* Python is not the same as having the right one. `py` (the Windows
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

To force a specific interpreter, set its full path under **Sources → Analysis →
Python**. The page shows which one is live and what it is missing.
Changing it recycles the analyzer process; no restart needed.

### Playback sources

| Source | What it needs |
|--------|---------------|
| **Spotify + OS clock** | Both of the two below. The best option when you play Spotify on this machine — see [Spotify + OS clock](#spotify--os-clock-the-hybrid-source). |
| **Spotify** | A client ID and secret under Sources → Spotify, then *Connect Spotify*. Register the redirect URI the server prints at startup — see [Spotify authorisation](#spotify-authorisation). |
| **PRO DJ LINK** | CDJs on the same network. Toggle it under Sources → Playback sources, or on the main page. See [PRO DJ LINK](#pro-dj-link). |
| **Now playing (Windows)** | Nothing — reads the OS media session, so any player that reports to it works. Toggle it under *Playback Sources*. |
| **Deezer** | The extension in `browser-extension/` (see its README). Carries ISRC and the upcoming queue, so it prefetches. |
| **Live input (by ear)** | The [live input](#live-input) on. Needs no analysis: the show answers what it hears. *Auto-detect* falls back to it before the timer. |
| **Timer** | Fallback: plays the analysed timeline against a wall clock. |

The Deezer ARL cookie (Sources → *Deezer*) is optional but recommended:
with it, audio is fetched by ISRC for an exact match instead of a yt-dlp search.

### PRO DJ LINK

Turn it on under *Playback Sources* (or on the main page) with the CDJs and the
mixer on the same network as this machine. It uses
[alphatheta-connect](https://github.com/chrisle/alphatheta-connect), installed
with the rest by `npm install` — it builds a native SQLite module, so an install
that cannot build it leaves PRO DJ LINK reporting why and everything else
working.

- **Which deck.** The show follows the deck the room hears: the tempo master
  while it is on air, else the deck it already follows, else the one that has
  been on air longest. *On air* is the DJM's: its channel is up. Without a DJM
  on the network every playing deck counts. A change waits three quarters of a
  second, so a fader flicked through a scratch does not throw the show across.
- **Where it is.** Each deck is placed by its status packets, pinned on every
  beat by its beat packets, and on a CDJ-3000 set outright every 30 ms by its
  absolute-position packets — through loops, hot cues, scratching and reverse
  play. The *PRO DJ LINK* panel shows each deck, which is on air, the master,
  and which the show follows.
- **The exact file.** A track on a USB stick or SD card in a player is fetched
  off it over the network and analysed as it is: the recording the DJ plays, so
  the analysis lines up with the deck to the millisecond. It is cached apart from
  a search result, which is only the fallback (rekordbox over the link, a CD, or
  a fetch that fails). Every loaded track is prefetched this way.
- **rekordbox's grid and phrases.** The deck's beat grid becomes the analysis's
  beats, and rekordbox's phrase analysis its sections — for club tracks
  Intro/Up/Down/Chorus/Outro as intro/verse/breakdown/drop/outro, for songs
  intro/verse/bridge/chorus/outro — so the looks change where the DJ's rekordbox
  says the chorus starts, and a returning chorus gets the same look.
- **Through a mix.** When the show moves to the incoming deck, the outgoing
  track's show plays on, on its own deck, until the incoming track is ready.
  Then the lights blend into it as an operator watching the mix would:
  - after a cut, they cut;
  - with a drop in the incoming track within ten seconds, they blend until
    the drop and let it land as a cut;
  - otherwise the blend ends on the incoming track's next phrase — its next
    section or its next eight bars, at least two bars on;
  - brought in already in a chorus or a drop, a bar's blend;
  - with nothing within reach, two bars.

  Times follow the deck's own tempo, so a track pitched up gets there sooner.
  The server log says which it chose.

### Spotify + OS clock (the hybrid source)

Neither Spotify nor the OS media session is good at both halves of the job, and
this source takes each from whichever has it.

**Spotify knows what is playing.** The track id, the ISRC that fetches the exact
recording rather than a search result, the real duration, and — the part nothing
else has — the *upcoming queue*, which is what lets the next few tracks be
analysed before anyone hears them. What it is bad at is *where* playback is: it
answers about once a second, over the network, with a position that was already
a round trip old when it was measured.

**The OS media session knows where playback is.** It is read locally with no
network in the path, so its position is fresher and far steadier. What it does
not expose is any track id or ISRC — only the artist and title strings the
player chose to publish, which is not enough to fetch the right recording or to
see what is coming next.

So: content and queue from Spotify, clock from the OS. Measured against a
simulated 1 Hz Spotify poll with ±350 ms of jitter, and a 2 Hz local session
with ±60 ms:

| | Mean error | 95th percentile | Backward jumps per 2 min |
|---|---|---|---|
| Spotify alone, interpolated | 189 ms | 337 ms | 27 |
| Hybrid | 11 ms | 25 ms | 0 |

The backward jumps matter as much as the error: a cursor that moves backwards
re-crosses timeline events it has already fired, so the rig flashes twice for
one beat. The hybrid clock is monotonic by construction — corrections go into
its *speed*, capped at five percent, never into its position. See
`src/playback-clock.js`.

**It is never worse than plain Spotify.** The OS session only drives the clock
while it is reporting the track Spotify says is playing — matched on title,
artist and duration. When it is not (a different app took the media keys, the
session went stale, you are playing on another device) the clock falls back to
Spotify's own position, which is exactly what the Spotify source would have
done. On a machine with no media session at all — anything but Windows today —
hybrid still runs; it just runs on the Spotify clock.

The *Follow* selector's **Auto-detect** picks it whenever both halves are live.
The source strip shows which clock is driving, with the current drift in its
tooltip.

### Spotify authorisation

Spotify requires HTTPS for OAuth redirect URIs, with one exception: **loopback
IP literals**. `http://127.0.0.1:PORT` is accepted, and `http://[::1]:PORT` for
IPv6. `http://localhost:PORT` is not — Spotify dropped it in February 2025
because localhost resolution varies between machines.

That exception is enough to authorise without any third party, so **the OAuth
proxy is optional and off by default**. Leave *OAuth Proxy* blank and the flow
goes straight to `accounts.spotify.com`; register the redirect URI the server
prints at startup, which is:

```
http://127.0.0.1:<port>/auth/spotify/callback
```

Use the literal `127.0.0.1` in the dashboard whatever `server.host` is set to —
it is the redirect Spotify checks, not the address you browse the UI on.

**When you still want a proxy.** The loopback redirect only works if the browser
doing the authorisation is on the same machine as the server: a phone on the LAN
that follows it would land on its *own* `127.0.0.1`. So if the rig is headless
and you drive it from a tablet, either

- do the connect once from a browser on the server machine — the session is
  saved, so this really is once and not once per boot (see below), or
- set *OAuth Proxy* to a relay, which is the original behaviour — the proxy
  takes Spotify's callback and forwards the code to this server's LAN address.

### The connection survives a restart

Connecting stores the Spotify **refresh token** in `settings.json` under
`spotify.refreshToken`, and the server signs back in with it at startup. The
banner says `reconnected from the saved session` when it works.

Only the refresh token is kept. Access tokens last an hour, so one saved at
shutdown would be stale by the next show, while the refresh token mints a fresh
one on demand. Spotify sometimes hands back a *new* refresh token during a
refresh; that is stored too, so the saved session cannot quietly go stale.

It is a credential — anyone holding it can read the connected account until it
is revoked — so it is treated like the client secret and the Deezer cookie:
`settings.json` is written `0600`, and the app is only ever told
*whether* one is set, never its value. There is no field for it; it is written
by the server, not typed.

Two things clear it: pressing **Disconnect**, and Spotify itself rejecting the
stored token (revoked in your account, or the client ID changed underneath it) —
in which case the server says so and leaves you to reconnect. A network failure
at boot does *not* clear it, because a headless rig routinely comes up before
its network does; it is simply retried on the next start.

Going direct is also the safer of the two: the authorization code never passes
through anyone else's server, and the OAuth `state` nonce round-trips through
Spotify intact, so the *Allow Unverified State* escape hatch (which exists for
relays that strip `state`, and which disables OAuth CSRF protection) is not
needed at all.

### Shaping the generated show

Two controls sit in the *Look* panel and decide how the generated show reads:

- **Palette** — how many colours a song locks to: 2, 3, 4, or **Auto**. On Auto
  the show sizes it per track — one colour per distinct passage, capped at four,
  and one fewer when the music cannot carry the separation, because four hues on
  a track with two ideas read as arbitrary rather than as rich. The button shows
  what the current track resolved to. Picking a number yourself always wins.
- **Intensity** — 0–100, how hard the show pushes: accent density, drop effects,
  strobe bursts and beat-division scaling. 50 is normal.

Both are live: changing either rebuilds the timeline from the analysis already
in hand, so the new setting takes effect on the next tick without re-analysing
the track. Neither touches the master dimmer — that slider stays yours.

With LED bars in the patch, the look comes apart in two. The pars carry the
colour and the wash, and the bars carry the movement: the pars no longer chase
underneath bars that are chasing too. The bars' picture follows what the music
is doing:

| Where | The bars | Laid out |
|---|---|---|
| verse, intro | a slow gradient | across the stage |
| pre-chorus, build-up | **Rise**: a fill that climbs through it, full as the drop lands | mirrored, from the middle out |
| chorus | a comet: a mirrored chase | mirrored |
| drop | **Impact**: a ring thrown out from the centre on every step, sparks on every kick | across the stage |
| breakdown, outro | low plasma | across the stage |
| bridge, a solo | the kit as it is played, when the analysis has the drum hits | per bar |

- **The pars.** A wash by how hard the passage drives: held colour, a
  split, a pulse on every step, a colour cycle.
- **A drop's first instant** is the one whole-rig moment: every fixture on
  the hot colour at once.
- **The group split** is left off on such a rig: the pars and the bars are
  the two layers now.
- **The Patterns panel** says what each is on ("Pars on Hit, bars on
  Impact"). A pattern picked by hand runs on the whole rig again, and so
  does a cue saved before this.
- **Replanning.** Adding or removing the last bar replans the track.

On a rig of pars there are no bars to carry the movement, so the pars carry
all of it, and the show gives them shape:

| Where | The pars | Laid out |
|---|---|---|
| chorus, drop | the passage's travelling look — a chase, pairs, a runner, a stack | mirrored, from the middle out to both ends at once |
| a drop's first bars | the movement it lands into | mirrored |
| build-up | a stack that builds out from the middle on every step, the steps quickening to the peak | mirrored |
| verse, intro, breakdown, outro | as chosen for the passage; resting on a ribbon, a fade, a wave, a rolling gradient or a slow plasma | across the stage |

- **A long passage comes round.** Inside a chorus the look turns every two to
  eight bars, through three others and back to the passage's own, so the look
  the chorus opened on returns at the top of every phrase — where it used to
  swap between the same two for as long as the chorus lasted.
- **Every scene says how it is laid out**, so the verse after a mirrored
  chorus crosses the stage again, and stopping the show puts the rig back
  across the stage.

Past 70, intensity also lifts a calm or rock track out of its tier *for drops
only*. A fader that did nothing on a ballad is a fader you stop trusting; it
buys the drops, never accent density, so the track still does not strobe through
its verses.

### Where the show rests

The generated show spends a budget rather than reacting to everything. Contrast
is the product: a show that flashes constantly has no big moments, because
everything is one.

- Accents are capped per rolling minute, from the track's style and the
  intensity fader. Over budget, the weakest candidates are dropped — weakest
  meaning least confident *and* smallest: a big energy spike outranks a small
  one the analyser was equally sure of.
- Nothing fires in the bar before a drop, so the build-up's own arc has the room
  to itself, and nothing in the drop's first bar — the drop is the statement.
  Counted in bars so it scales with the tempo, and never inside a burst the
  drop itself fired.
- Intros, breakdowns and outros carry no accents at all and stay on quarter-note
  movement. That is what makes the chorus after them land.
- Passages the analyser recognises as the same get the same pattern and the same
  palette rotation every time they return, so the second chorus reads as the
  chorus rather than as a new idea. Recognition is the structure labeller's
  clustering where it has an answer, and the timbre embeddings where it does not
  — which catches a returning chorus the labeller split in two.
- The last time a passage comes round is the biggest: it keeps its look but
  steps up one beat subdivision where the pulse can carry it, and wins the
  accent budget when it competes for it.
- Looks arrive the way the music does. Into a breakdown or an outro the rig
  crossfades over two bars (never more than four seconds), into a verse over
  half a bar, and into a chorus or a drop it cuts on the downbeat. Colour moves
  and rotations inside a section blend over a beat. The rehearsal preview shows
  the same fades, and steps its chases on the same analysed beats as the rig.

Accents land on the drums as they were played, where the analysis has them:

- **Bar accents** go on the kick or snare that marks the bar, not on the
  grid's idea of it. A bar line nothing was hit on gets none.
- **A drum fill into a new section** is marked on its last hit.

Only strong hits count, and only from lanes found by the rules measured on
real drumming ([How well the lanes work](docs/audio-analysis.md#how-well-the-lanes-work)).
On the separated drum stem those kicks are right nine times in ten and those
snares four in five. Without separation only the kick is trusted. A track
analysed before these rules keeps its accents on the grid until it is analysed
again.

The show also *reads the track continuously*, not only at section boundaries.
Twice a second it takes the separated stems' levels — how much low end, whether
a voice is present, how much air is on top, how fast the music is moving — and
the rig follows them underneath whatever pattern is running. A chase through a
breakdown and the same chase through the chorus after it are the same pattern in
the same colours, and they do not look remotely the same. None of it touches the
master dimmer.

### Remembering the night

Every track is planned on its own, and on its own each plan is a good one.
Played back to back they could be the same plan twice: two house records an
hour apart in one palette, the same chase on every chorus, a blinder at every
drop from the first track to the last. The show now remembers the tracks it
has played tonight:

- **No repeats.** The palette the last track played in is never used straight
  after, and no section opens on the look the same section opened on last
  track.
- **Keys that mix keep colours.** When a track mixes harmonically out of the
  last one — the same number on the Camelot wheel, or a step round it — the
  palette leans towards banks that share its colours. A key change that did
  not blend is free to change them all. Over the test tracks this changes the
  pick for about half the pairs.
- **An arc across the night.** A track that drives harder than the last few is
  a peak: more accents, and the blinder. A breather after them spends less,
  and the first twenty minutes warm up. After a blinder, the next track that
  is no peak trades its blinders for the white strobe.

The *Look* panel says how many tracks the night has had and where this one
sits. A track starting more than an hour after the last one started begins a
new night. **Settings → Show → Remember the Night** turns it off.

### Track edits

The show replans a track whenever anything it reads changes: the intensity,
the palette size, the rig, the tracks before it. **Track edits**, on the
[Timeline view](#the-timeline-view), are the changes of yours that survive that:

- **Lock** the palette the track is playing in.
- **Add** an accent at the playhead — or, rehearsing, at the rehearsal mark
  (blinder, white or colour strobe, UV wash, kill or glow) — or **remove** the
  one nearest it. An added accent fires whatever the budget says.
- **Swap a section's look**: for the whole rig, or for the pars and the bars
  apart. The section holds it, and its rotation stops too. Each row shows the
  show's own choice beside yours.

They are kept beside the track's analysis in the cache, and put back every
time the track plays. Analysing the track again keeps them: sections match
within two seconds and accents within 150 ms. Clearing the cache takes them.
`GET` and `PUT /api/auto/overlay` read and replace them from a script.

### The Timeline view

**Timeline** (**4**, `/#timeline`) is the loaded track's show laid out to be
read and rehearsed: the analysis (sections, the energy and band curves, beats,
drops and build-ups) with the planned looks and accents under it, the analysis
in numbers, the stage preview and the [track edits](#track-edits).

- **Zoom** to 2×, 4× or 8× and the timeline scrolls; it keeps the mark in view
  as it moves, and leaves it where you scrolled it otherwise.
- **Press or drag** on it, or use **←** **→** on it (**Shift** for ten
  seconds, **Home** / **End** for the ends), to rehearse from there. The
  section buttons under it jump to a section's start.
- **Rehearsing** plays the planned show on the stage preview and the
  [Stage view](#the-stage-view) — nothing goes out to the rig — from the same
  position on both. **Back to live** returns them to the output. The white
  line is where the music is now; the amber one is the rehearsal.

### The Stage view

**Stage** (**5**, `/#stage`) draws the rig in 3D, in a hazy room, from where
the audience stands, from above or from the side. Drag to look around, scroll
or pinch to move closer; with the stage focused, the arrow keys turn and tilt
and **+** / **−** move closer. **Haze** thickens the beams and the fog.

Fixtures hang where the plan puts them, by their group: *front*, *back* and
ungrouped ones on the truss, aimed down at the stage and a little towards the
audience; *floor* ones on the deck, aimed up; *room* ones as lamps at head
height around the room. A Philips Hue lamp is a bulb wherever it is. A bar's
cells hang in a line where the plan draws it, and a panel stands upright.

- **Live**, it shows what is going out: the DMX feed read through each
  fixture's profile, every light of every bar, after the masters, overrides
  and identify.
- **Rehearse track** plays the loaded track's planned show at any moment of it
  — scrub to the drop and see it — sampled by the same shared code the engine
  renders with (`src/shared/preview.ts`), at the display's frame rate.

three.js is fetched the first time the view opens, not with the page, and kept
by the service worker with the rest of the app. A browser with WebGL turned
off is told so; the plan in the Manual and Rig views shows the same rig from
above.

### Flash limit

**Settings → Show → Flash Limit** holds the whole rig to three large-area
flashes a second. That is the photosensitivity threshold broadcast and web
guidance share (WCAG 2.3.1, ITU-R BT.1702). A flash is a pair of opposing
changes of a tenth of full brightness or more, the darker side under 80 %.
It is measured over the rig as a whole: every fixture's mean light, after the
masters.

- **A look that flashes faster** — a Hit at sixteenths, a run of kills — is
  held, once the second has had its three, to a flicker of under a tenth
  around where the light last turned. It is dimmed, never blacked out.
- **Strobe channels and the software strobe** are capped at three flashes a
  second.

It applies to every output (Art-Net, sACN, WLED, Hue) and to manual looks,
cues and overrides as much as to the auto show. The header shows **Flash ≤ 3/s**
while it is on. It is off by default: most of what a party rig does is above
this line.

### Seeing what the analyser heard

```bash
python src/analyze.py track.wav --report report.html
```

writes a standalone page — no plotting library, no network — with the waveform
and detected sections, beat markers scaled by per-beat confidence, all seven
frequency bands, the impact curve with drops and build-ups over it, and every
musical event on its own lane. It is the fastest way to answer "why did it do
that there".

### Buildups — following what the music actually does

The eight seconds before a drop used to get the same treatment every time: beat
division 1, then 2, then 4, whatever the track was doing. That is right often
enough to look deliberate and wrong often enough to look mechanical. Those eight
seconds are now measured.

Two separate things happen in there, and they are independent — a track can do
either, both or neither.

**The roll.** Standard production practice is to double the *subdivision* at
constant tempo: a snare on quarters, then eighths, then sixteenths, sometimes
thirty-seconds. That is what an audience hears as "speeding up", and it never
touches the BPM. The analyser counts it and reports it as the buildup's
`subdivision`, and the rig's beat division follows how far it actually goes. For
documents written before the analyser counted it, onset density stands in — the
onsets in the last third of the buildup against the first third:

| Onset density ratio | Peak beat division |
|---|---|
| under 1.4× | 2 — a riser with no roll under it; the rig does not sprint |
| 1.4–3× | 4 — one doubling, the common case |
| 3× and up | 8 — two doublings, all the way to thirty-seconds |

A buildup that starts from silence has nothing in its early third, which would
make the ratio a division by roughly zero; that case is detected and left on the
default rather than slamming the rig to its fastest division. In 3/4 the
division stays at 1 whatever the roll does, because subdividing a triple metre
by two puts the rig on the off-beats of the bar.

**The ramp.** Some tracks genuinely change tempo into a drop. Rarer than the
roll, but when it happens the beat clock has to follow or the rig drifts out of
time exactly when it is most exposed. The analyser's tempo curve is clamped to
±15% of the global BPM and smoothed over ~2 s, so what survives is real: a
change of 3 BPM or more across the buildup, moving mostly one way, is followed
with stepped BPM patches.

What happens *at* the drop is decided by the track, not by a guess — the tempo
curve for the few seconds after the drop says whether the ramp resolved or
stuck:

- a push that falls back is undone at the drop, or every pattern after it runs
  at the buildup's peak tempo;
- a genuine tempo change is kept, for the same reason.

On a track the analyser already considers unstable (`tempoStability` below 0.60)
the periodic BPM path is emitting across the whole track from the same curve, so
buildups leave the tempo alone — two sources of truth for the beat clock would
fight each other.

### Sync — lining the lights up with the room

There is always a gap between the audio a room hears and the light that answers
it, and none of it is under this program's control. The player buffers. A
position API like Spotify's is polled and quantised, so the number it reports is
already a little stale. Art-Net crosses a network. The fixture has its own
processing delay. And the PA is metres away from the audience, which is a few
more milliseconds by itself. It adds up to a fixed error for a given rig — but a
different one for every rig, so it cannot be derived, only dialled in.

The **Sync** control in the *Look* panel does that. It shifts the whole
generated show against the reported track position:

- **Positive** runs the lights **ahead** — use it when the rig feels late. It
  moves the pattern clock with the cues: the chase steps on the shifted beats.
- **Negative** holds them back.
- Range is ±2000 ms, in 5 ms steps.

The `−` and `+` buttons move it 5 ms at a time, which is how it actually gets
dialled in; the slider is for coarse jumps, and clicking the read-out puts it
back to zero.

Unlike palette and intensity, this one is **saved with your settings**
(`auto.syncOffsetMs`), because the right value belongs to the rig and the room
rather than to tonight's set — you calibrate it once and it is there next time.

Nudging it mid-set never replays the show. Stepping the offset forward over an
event skips that event rather than firing it: a backwards nudge could not
un-fire what already played, and a forwards one that caught up would empty every
event it crossed into the room in a single frame. The cost is a beat of the
previous look; the alternative is a burst of strobe.

It is on the control surface too — **Light/music sync offset** on a fader
(centre is zero), **Nudge light/music sync** on an encoder at 5 ms a detent —
and over REST at `POST /api/auto/sync-offset/:value`.

Intensity is also on the control surface (**Auto-show intensity** on a fader,
bound to fader 8 by default; **Nudge auto-show intensity** on an encoder) and
over REST at `POST /api/auto/intensity/:value`, so it can be driven from a
Stream Deck or a script mid-set rather than only from the browser.

---

## Live input

The live input hears the music as it plays: **what this computer plays** (any
player, straight from the sound card, no cable) or **an input** — a line off the
booth output, the only way to hear a set played on other equipment. Turn it on in
*Settings → Live Input*; it needs the Python packages in `requirements.txt`
(`soundcard`, with `sounddevice` as a fallback for inputs).

A Python process (`src/live_input.py`) reads the audio a 12 ms hop at a time and
tracks the beat with no look-ahead; the server reads it onto its own clock, so the
beat it reports for *now* was within 9–13 ms of the true beat on a test track
played in real time. What it is used for:

- **Keeping the beat.** The pattern clock follows it (**Live** badge) whenever
  nothing better knows the music.
- **Auto-sync.** With a known track's show running from Spotify, the hybrid
  source, the OS media session or Deezer, the last 16 seconds of what it hears
  are compared with the track's analysed onsets once a second, and the show is
  moved by however far the source is off — typically the few hundred
  milliseconds a polled position is out, different for every track. A lag is
  only taken when it clearly beats the lag one beat along, and only when two
  measurements agree; the auto panel says what it corrected. The **Sync** slider
  is then left to cover the lights' own delay. Not used for CDJs, whose position
  is exact.
- **Playing by ear.** With the auto show on and no analysed track to play — the
  source is *Live input (by ear)*, or the next track is still being analysed —
  the show answers what it hears: a new look at each change of section (cut on
  the way up, faded on the way down), the pattern doubling through a build-up, a
  burst on the drop, and darkness in the silences. The auto panel shows **By ear**.

*Room latency* (ms) covers the distance between the sound card and the room:
positive when the room hears the music later than this machine does, negative
for a line-in that arrives after the room has heard it.

---

## MIDI

Any MIDI controller works. Pick its ports under Settings → MIDI controller (the choice is
remembered), then map it — either keep the built-in layout, or relearn the
bindings you want onto the controls you have.

### MIDI clock out

*Settings → MIDI Clock Out* sends the tempo the lights keep — the show's, a
CDJ's, the live input's or a tap — as MIDI clock (24 pulses a beat, with start
and stop) to a port of its own, so a drum machine, a DAW or a visuals app plays
in the same time. To reach software on this machine, create a loopback port
(loopMIDI on Windows, IAC on macOS) and pick it. The pulses are counted off the
clock's beat position, so they cannot drift; when the music jumps, the count
starts again from there rather than sending a burst.

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
| **Encoders** (relative) | Nudge BPM · Nudge master dimmer · Nudge strobe speed · Nudge fixture dimmer · Nudge fixture max brightness · Nudge auto-show intensity · Nudge light/music sync |

An endless encoder sends "moved a bit, this way", and there are two ways to
spell that — two's complement (1 up, 127 down) and binary offset (65 up, 63
down). Which one a controller uses is a setting on the device, and nothing in
the MIDI message says which you are being sent, so the encoding is worked out
from the values themselves: a value next to 64 can only be binary offset, one
next to 0 or 127 can only be two's complement. The first detent settles it, per
encoder, so a surface may mix the two. Nothing needs configuring, and a
controller you reconfigure is re-learned on the next restart.
| **Faders** (absolute) | Master dimmer · Strobe speed · BPM · Fixture dimmer · Fixture max brightness · Auto-show intensity · Light/music sync offset |

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
| POST | `/api/bpm/:value` | Set BPM (20–300, fractions allowed) |
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
| POST | `/api/fixtures` · DELETE `/api/fixtures/:id` | Add / remove fixtures. With no body, one generic par behind whatever is on the default universe; with `{ profileId?, count?, universe?, address?, label? }`, `count` (up to 64) of that profile one after another, on into the next universe when one fills (a strip on universes of its own); answers `{ fixtures: [ids], placed: [{ universe, address }] }`. DELETE answers with the fixture and its index |
| POST | `/api/fixtures/restore` | Put a deleted fixture back (`{ index, fixture }`) |
| POST | `/api/gdtf/parse` | Parse an uploaded `.gdtf` (multipart `gdtf`) |
| POST | `/api/ofl/parse` | Parse an uploaded Open Fixture Library `.json` (multipart `ofl`, optional `manufacturer`) |
| GET | `/api/ofl/search?q=` | Search the Open Fixture Library online: `{ results: [{ manufacturerKey, fixtureKey, manufacturer, name, categories }] }` |
| GET | `/api/ofl/fixture/:manufacturer/:fixture` | Fetch a fixture from the Open Fixture Library and parse it, as `/api/ofl/parse` answers |
| POST | `/api/profiles` · DELETE `/api/profiles/:id` | Register / remove a fixture profile (`cells` makes it an LED bar, `grid` a panel; `defaults: [{ offset, value }]` holds undriven channels off 0) |
| POST | `/api/profiles/bar` | Build and register an LED bar profile from `{ id, name, cells, firstChannel, order, stride?, dimmer?, strobe? }`; `?dryRun=1` answers with it without registering |
| GET · POST | `/api/show` | Export / import the patch |
| GET | `/api/wled/discover` | Ask the network for WLEDs (mDNS): `{ devices: [{ host, name, leds, rgbw, matrix, version, patched }] }` |
| POST | `/api/wled/add` | Add a WLED to the patch from `{ host, label? }`: its profile from `/json/info`, on free universes, sent DDP |

### Outputs

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/artnet/nodes` | The Art-Net nodes that answered, with the universes each outputs, and whether frames are being routed by them; `?scan=1` asks the network now |
| GET | `/api/network/interfaces` | This machine's IPv4 addresses and their broadcast addresses, for sACN's network and the Art-Net target |
| POST | `/api/artnet/identify` | `{ address, universes?, seconds? }`: send the node ArtAddress *locate* (and *normal* after), and identify the fixtures on the universes it outputs |
| GET | `/api/sacn/sources` | The other sACN sources heard, and `conflicts`: universes this rig sends that one of them sends too; `?listen=1&seconds=` listens (again) |

### Identify

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/identify` | `{ fixtures?: [ids], universes?: [n], seconds? }` — those fixtures, and everything on those universes, show themselves for `seconds` (default 8, up to 60; 0 stops). Answers `{ ids, remainingMs }`; the live state carries it as `identify` |
| POST | `/api/identify/stop` | Stop identifying, a streamed WLED included |
| POST | `/api/wled/identify` | `{ host, seconds? }`: through the patch when the WLED is in it (`via: 'patch'`), else its picture streamed over DDP (`via: 'device'`) |
| POST | `/api/hue/identify` | `{ channel, seconds? }`: the fixture the channel follows (`via: 'fixture'`), else the bridge's own identify (`via: 'bridge'`) |

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
| POST | `/api/auto/sync-offset/:value` | Light/music sync offset in ms, −2000 to 2000 |
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
| GET | `/api/live/devices` | The audio outputs and inputs the live input can hear, and its capture library |
| GET | `/auth/spotify` · `/auth/spotify/callback` | Spotify OAuth |
| POST | `/api/preflight` | Run the pre-show check against the live subsystems |
| GET | `/api/spotify/now-playing` · POST `/api/spotify/disconnect` | Spotify |
| GET | `/api/spotify/playlists` | The connected account's playlists, for the warming picker |
| POST | `/api/nowplaying/disconnect` | Drop the OS media session source |
| POST | `/api/deezer/state` · `/api/deezer/disconnect` | Used by the browser extension |

### Philips Hue

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/hue/status` | Bridge address, whether it is paired, the bindings, and what the stream is doing |
| GET | `/api/hue/discover` | Bridges Philips' cloud service has seen on this network |
| POST | `/api/hue/pair` | Pair with `{ host }` — the bridge link button must have been pressed in the last 30 seconds. Answers `409` with `pressLink: true` if it has not |
| GET | `/api/hue/areas` | Entertainment areas on the paired bridge, with their channel ids and lamp names |
| POST | `/api/hue/disconnect` | Forget the bridge and turn the output off |
| POST | `/api/hue/sync-test` | Flash every fixture white once a second for 10 s, to tune `hue.latencyMs` |

Credentials are never returned by any of these — `/api/hue/status` reports only
whether a pairing exists. The channel bindings themselves are ordinary settings,
saved through `PUT /api/settings` under `hue.channels`.

### Socket.IO

The UI uses Socket.IO rather than polling. Clients send `set`, `override`,
`fixture`, `tap`, `energy-hold` and `midi-connect`; the server emits
`auto-position`, `midi-status`, `midi-map`, `midi-learn` and `error-msg`, and
the state in one of two forms, chosen when the client connects:

- **Protocol 2** — asked for with `auth: { protocol: 2 }`; what the live page
  uses. A `snapshot` on connect (`{ protocol, versions, state }`), then
  `patch` events carrying only the keys that changed, grouped by domain (`look`,
  `rig`, `show`, `sources`, `catalogs`, `system`) and numbered per domain:
  `{ d, v, set, del? }`. A client that sees a gap in a domain's numbers sends
  `sync` (with an ack) for a new snapshot. DMX goes out as `dmx-frame`, binary
  (`src/shared/dmx-frame.ts`: per universe its number, its length and its
  bytes), thirty times a second while it changes — volatile, and only to
  clients that sent `subscribe: ['dmx']` (and until `unsubscribe`).
- **Protocol 1** — anything that does not ask, such as the Bitfocus Companion
  module: `state` (the full snapshot on connect, the
  whole live state again whenever any of it changes) and `dmx` (channel values
  as JSON, keyed by universe, ten times a second — built only while such a
  client is connected).

The `fixture` message carries
`{ id, address?, universe?, label?, profileId?, maxBrightness?, position?, group?, geometry?, output? }`.
`position` is `{ x, y }` in percent of the stage plot, or `null`; `group` is one
of `front`, `back`, `room`, `floor`, or `null`; `geometry` is an LED bar's line
(a panel's top edge), `{ length, angle }` (length 1–100 in stage percent, angle
−180–180 degrees clockwise on the plot), or `null` for the default; `output` is
`{ protocol: 'ddp', host, port? }` to send the fixture's universes to a WLED, or
`null` for Art-Net and sACN.

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

A control that silently stopped working is worse than one that says so, so the
page bars itself whenever the socket is not live, and says which of the three it
is: **Connecting** while it is still coming up, **Disconnected** when a live
connection dropped (the rig holds its last look, and the veil clears itself when
the server comes back), and **Access token required** when the server refused
this browser — the only one of the three that needs you, because it is the only
one that never resolves on its own.

---

## Configuration

Everything is configured in the app, in its **Rig**, **Sources** and
**Settings** views (keys **4**, **5**, **6**). There are no environment
variables to set: the server stores your choices in `config/settings.json` and
reads them from there.

Change what you need in a section and press its **Apply**; a section says when
it has edits not applied yet. Most settings take effect immediately.

| Where | Section | Settings |
|-------|---------|----------|
| Rig → Outputs | **Art-Net** | Enabled, node IP, port, default universe, finding nodes, ArtSync |
| Rig → Outputs | **sACN (E1.31)** | Enabled, node IP, priority, source name, universe offset, network, component ID |
| Rig → Outputs | **Philips Hue** | Enabled, bridge address, pairing, entertainment area, pars delay, channel-to-fixture bindings |
| Sources | **Playback sources** | PRO DJ LINK, Windows now-playing (SMTC) |
| Sources | **Spotify** | Client ID, client secret, optional OAuth proxy, unverified-state escape hatch, and the saved session (server-written, never shown) |
| Sources | **Deezer** | ARL cookie — exact ISRC-matched audio instead of a yt-dlp search |
| Sources | **Live input** | Enabled, what to listen to, device, auto-sync, play by ear, room latency |
| Sources | **Analysis** | Separator, structure model, analyser and download timeouts, library folder, Python interpreter |
| Settings | **Show** | Remember the night, flash limit |
| Settings | **MIDI controller** | Input and output port, motorised fader feedback |
| Settings | **MIDI clock out** | The port the clock goes to, or off |
| Settings | **Engine** | Its own thread or the main thread |
| Settings | **Server & access** | Bind address, port, access token, public URL |

The **Server & access** settings and the engine thread are read before the
server starts, so they are marked `restart` and applied on the next start.
Everything else applies as soon as you press Apply.

### The config file

`config/settings.json` holds secrets — the Spotify client secret, the Deezer
ARL, the access token, the Hue application and client keys — so it is written
`0600` and is gitignored. Nothing else
needs to be in it: any key you have not set uses the built-in default.

The app never shows a stored secret. It reports only whether one is set, and
lets you replace or clear it.

If the file is corrupt or fails validation at startup, it is moved aside as
`settings.json.invalid-<timestamp>` and the server starts on defaults rather
than refusing to boot mid-gig.

### Moving from .env

Environment variables are **no longer read**. If you have a `.env` from an
earlier version, the server names the variables it is ignoring at startup:

```
[settings] These environment variables are no longer read: ARTNET_HOST, DEEZER_ARL
[settings] Settings now live in the app (its Rig, Sources and Settings views) and are stored
[settings] in config/settings.json. Set them there; you can delete them from .env.
```

Set those values once in the app and delete the file. (`DEBUG_MIDI=1`
is the one exception — it is a developer log toggle, not a setting, and is still
read from the environment.)

Art-Net changes made over the socket (a page, Companion) are persisted to the
same file.

> **Why `--openssl-legacy-provider`?** The `start` and `dev` scripts pass it
> because Deezer track decryption uses Blowfish (`bf-cbc`), which OpenSSL 3
> moved to the legacy provider. Without the flag, Deezer downloads fail with
> `ERR_OSSL_EVP_UNSUPPORTED`; everything else works.

---

## Keyboard shortcuts

Press **?** in the app for this list.

| Key | Action |
|-----|--------|
| **Space** | Tap tempo — also right after clicking a button; a control reached with Tab keeps Space for itself |
| **1** / **2** / **3** | Manual / Auto Show / Perform view |
| **4** / **5** | Timeline / Stage view |
| **6** / **7** / **8** / **9** | Rig / Sources / Settings / Preflight view |
| **←** **→**, **Home** / **End** on the view tabs | Next / previous / first / last view |
| **←** **→** **↑** **↓**, **Home** / **End** | Move within the colour grid |
| **Enter** / **Shift+Enter** | Write the focused swatch into the active slot / the paired slot (A↔B, C↔D) |
| **Shift+click** or **right-click** | Write a swatch into the paired slot |
| **Space** or **Enter** on an energy button | Hold the effect until released |
| **←** **→** **↑** **↓** (**Shift** for bigger steps) | Nudge the focused fixture on the stage plot (on the Rig view's plan, the whole selection) |
| **[** **]**, **-** **=**, **0** on a bar | Turn it, change its length, back to its default line |
| **Esc** on the plan | Stop drawing bars; else clear the selection |
| **←** **→** (**Shift** for 10 s), **Home** / **End** on the timeline | Rehearse from a second later / earlier, the start / the end |
| **←** **→** **↑** **↓**, **+** / **−** on the 3D stage | Turn and tilt the view, move closer / further |
| **?** / **Esc** | Show / close the shortcuts overlay |

---

## Development

```bash
npm run lint         # ESLint
npm run typecheck    # tsc, strict
npm test             # node:test unit suite (components included)
npm run check        # all three
npm run test:e2e     # Playwright: the page in Chromium against a real server
npm run preflight    # pre-show check (exits 1 if something will not work)
npm run watch:client # rebuild the client bundle on change
npm run dev          # server with --watch
npm run gen:analysis-types  # after changing the analysis document schema
```

**TypeScript, run as it is.** Everything in `src/` is strict TypeScript that
Node 22.18+ runs directly by stripping the types: nothing is compiled, and
`tsc` only checks. So the code sticks to syntax Node can strip (no enums,
namespaces or parameter properties), type-only imports say `import type`, and
imports name the `.ts` file. `server.js` is a small bootstrap that checks the
Node version and loads `src/main.ts`. The tests are ES-module JavaScript that
import the `.ts` modules.

**The analysis document** — what the Python analyser writes and the show is
built from — is described once, in `src/analysis/document.schema.json`. The
Python tests validate real analyser output against it, and
`npm run gen:analysis-types` generates `src/types/analysis.ts` from it; a unit
test fails when the generated file is out of date.

`public/app.bundle.js` is generated from `public-src/` by esbuild and is not
committed; `npm start` builds it automatically via `prestart`. It is an ES
module, split: the Stage view's three.js is a chunk of its own in
`public/chunks/`, loaded when the view first opens, and the build lists the
chunks in `public/chunks/index.json` for the service worker to keep. On the page, the
state is one signal per key (`public-src/store.js`), so a component re-renders
only for the keys it reads (`pick([...])`), and faders keep a local draft while
they move (`public-src/draft.js`).

**Tests.** The unit suite includes the page's components, bundled by esbuild
and rendered in Node from a state snapshot (`tests/unit/components.test.js`).
`npm run test:e2e` runs the real server — on port 3999, with a throwaway config
directory and analysis cache and no DMX output (`tests/e2e/serve.js`) — and
drives the page in Chromium: the views, protocol 2, the Perform pads on a
desktop and a touch tablet, the Timeline and the 3D stage (on an analysed
track the server seeds its cache with, so no test needs Python), the fixes,
the PWA, and axe-core on every view in every theme. It uses
the Playwright pinned in `package.json`; `npx playwright install chromium`
fetches its browser where there is none.

`LIGHTSHOW_CONFIG_DIR` points the server at another directory for
`settings.json`, `show.json`, `cues.json` and `midi-map.json` (default:
`config/`), and `LIGHTSHOW_CACHE_DIR` at another for the analysis cache
(default: `cache/`).

The app icons (`public/icons/`) are drawn by `node scripts/make-icons.js`,
which needs no dependencies; run it after changing the design.

CI runs lint, the typecheck, tests, a client build, the end-to-end suite, the
Python analysis tests and `npm audit --omit=dev` on every push and pull
request.

---

## Licence

MIT — see [LICENSE](LICENSE).
