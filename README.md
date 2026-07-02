# ArtNet Lightshow

Web-based light show controller for **4× Cameo ROOT PAR 6** fixtures over ArtNet.
Supports **Behringer X-Touch Compact** (MIDI) and **Elgato Stream Deck** via **Bitfocus Companion**.

## Features

- **BPM engine** — tap tempo, manual entry, beat subdivision (1/1, 1/2, 1/4, 1/8)
- **10 patterns** — Solid, Chase →, Chase ←, Ping Pong, Strobe, Fade, Colour Cycle, Rainbow, Twinkle, Split
- **13 colour presets** — Red, Orange, Amber, Yellow, Green, Cyan, Blue, Purple, Magenta, White, Warm White, UV, Blackout
- **Dual colour slots** — Colour A & B for split/alternating patterns
- **Per-fixture overrides** — independent RGBWAUV + Dimmer + Strobe per fixture, or instant blackout
- **Energy overrides** — global one-touch effects (White Strobe, Blinder, UV Strobe, Colour Strobe, All On) that trump everything except master blackout
- **Master controls** — global dimmer, master blackout, play/stop
- **Live DMX monitor** — real-time channel values for all 4 fixtures
- **Ableton Link** — sync BPM with Ableton Live and other Link-enabled apps via Python aalink bridge
- **MIDI control** — Behringer X-Touch Compact with LED feedback
- **Stream Deck** — via Bitfocus Companion module (actions, feedbacks, presets)
- **REST API** — for custom integrations

## Quick Start

```bash
npm install
npm start
```

Open **http://localhost:3000**.

---

## Fixture Setup

### DMX Addresses (default)

| Fixture | Label  | Start Address |
|---------|--------|--------------|
| 1       | PAR 1  | 1            |
| 2       | PAR 2  | 13           |
| 3       | PAR 3  | 25           |
| 4       | PAR 4  | 37           |

### Channel Map — 12-Channel Mode (D12CH)

| Channel | Function      |
|---------|---------------|
| 1       | Dimmer        |
| 2       | Dimmer fine   |
| 3       | Strobe        |
| 4       | Red           |
| 5       | Green         |
| 6       | Blue          |
| 7       | White         |
| 8       | Amber         |
| 9       | UV            |
| 10      | Colour macros (keep 0) |
| 11      | Sound         |
| 12      | DMX Delay     |

Set each fixture to **12-channel mode (D12CH)** and configure the start address as above.

---

## Energy Overrides

Energy overrides are "panic button" effects that instantly override all patterns and per-fixture settings (except master blackout). Only one can be active at a time; set `energyOverride: null` to clear.

| ID             | Name           | Description                    |
|----------------|----------------|--------------------------------|
| `white-strobe` | White Strobe   | Full white + fast strobe       |
| `blinder`      | Blinder        | Full white wall of light       |
| `uv-strobe`    | UV Strobe      | Full UV + fast strobe          |
| `color-strobe` | Colour Strobe  | Colour A + fast strobe         |
| `all-on`       | All On         | Every channel maxed out        |

Energy overrides bypass the master dimmer — output is always at full intensity.

Activate via UI, MIDI (encoder push 8 — hold to activate, release to clear), REST, or Companion.

---

## Ableton Link

Sync BPM with Ableton Live or any other Ableton Link-enabled app.

**Requirements:** Python 3 + aalink

```bash
pip install aalink
```

Enable Link at startup:

```bash
LINK=1 npm start
```

Or toggle Link from the web UI **Link** panel at runtime. When Link is active, tempo changes from any peer are applied automatically and local BPM changes are pushed back to the session.

---

## MIDI — Behringer X-Touch Compact

Set the X-Touch Compact to **Standard MIDI mode** (Layer A).

The server auto-detects the first available MIDI device named "X-Touch".
Override via environment variables:

```bash
MIDI_INPUT="X-Touch Compact" MIDI_OUTPUT="X-Touch Compact" npm start
```

Or use the **MIDI panel** in the web UI to select ports at runtime.

### Default Mapping

| Control | MIDI | Action |
|---------|------|--------|
| Encoder 1 | CC 1 (relative) | BPM ±1/step |
| Encoder 2 | CC 2 (relative) | Master dimmer |
| Encoder 3–6 | CC 3–6 (relative) | Fixture 1–4 dimmer |
| Encoder 7 | CC 7 (relative) | Strobe speed |
| Fader 1–4 | Pitch Bend ch 1–4 | Fixture 1–4 dimmer (absolute) |
| Fader 9 (master) | Pitch Bend ch 9 | Master dimmer (absolute) |
| Enc push 1 | Note 0 | Tap tempo |
| Enc push 2 | Note 1 | Toggle blackout |
| Enc push 3 | Note 2 | Toggle play/stop |
| Enc push 4–7 | Note 3–6 | Fixture 1–4 blackout |
| Enc push 8 | Note 7 | Energy override (hold to activate, release to clear) |
| Button row 1 | Note 8–17 | Patterns (10) |
| Button row 2 | Note 18–23 | Colour A presets (first 6) |

LEDs on the X-Touch Compact are updated automatically to reflect the current state.

---

## Stream Deck — Bitfocus Companion

See **[companion-module/INSTALL.md](companion-module/INSTALL.md)** for full installation instructions.

Requires Companion **v4.3+** (the module uses the v2 connection API).

### Quick Summary

1. Run `npm install` inside `companion-module/`
2. In the Companion launcher, open advanced settings (cog icon) and pick a **Developer modules** folder
3. Copy or symlink `companion-module/` into that folder
4. Add a new **"ArtNet Lightshow"** connection pointing to `localhost:3000`
5. Drag presets from the module onto your Stream Deck buttons

### Presets included

- **Patterns** (25 buttons) — highlight when active
- **Colours A–D** (24 buttons each) — button background = colour
- **Transport** — Play/Stop, Blackout, Tap Tempo, BPM display/±5, Beat divisions
- **Fixtures** — per-fixture blackout (4 buttons), clear all overrides
- **Energy** — momentary effects (hold to activate, release to clear)

---

## REST API

All endpoints return JSON. Useful for custom integrations or additional controllers.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/state` | Full current state |
| POST | `/api/set` | Patch any state fields (JSON body) |
| POST | `/api/tap` | Tap tempo |
| POST | `/api/blackout/toggle` | Toggle master blackout |
| POST | `/api/blackout/on` | Blackout on |
| POST | `/api/blackout/off` | Blackout off |
| POST | `/api/pattern/:id` | Set pattern (e.g. `chase`, `rainbow`) |
| POST | `/api/color/a/:index` | Set Colour A (0-12) |
| POST | `/api/color/b/:index` | Set Colour B (0-12) |
| POST | `/api/bpm/:value` | Set BPM |
| POST | `/api/bpm/adjust/:delta` | Nudge BPM (e.g. `+5`) |
| POST | `/api/play` | Start show |
| POST | `/api/stop` | Stop show |
| POST | `/api/master/:value` | Set master dimmer (0-255) |
| POST | `/api/energy/:id` | Activate energy override (e.g. `white-strobe`) |
| POST | `/api/energy/off` | Clear energy override |
| POST | `/api/fixture/:id/override` | Set fixture override (JSON body) |
| POST | `/api/fixture/:id/blackout/toggle` | Toggle fixture blackout |
| POST | `/api/fixture/:id/clear` | Clear fixture override |
| POST | `/api/link/enable` | Enable Ableton Link |
| POST | `/api/link/disable` | Disable Ableton Link |
| POST | `/api/link/toggle` | Toggle Ableton Link |
| GET | `/api/midi/ports` | List available MIDI ports |
| POST | `/api/midi/connect` | Connect MIDI ports `{ input, output }` |

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3000` | Web server port |
| `MIDI_INPUT` | _(auto)_ | MIDI input port name |
| `MIDI_OUTPUT` | _(auto)_ | MIDI output port name |
| `LINK` | _(off)_ | Set to `1` to enable Ableton Link on startup |

ArtNet node IP and universe are configurable in the web UI **ArtNet Settings** panel.
Default: broadcast to `2.255.255.255:6454`, universe 0.

## Keyboard Shortcut

**Space** — tap tempo
