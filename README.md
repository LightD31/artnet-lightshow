# ArtNet Lightshow

Web-based light show controller for **4× Cameo ROOT PAR 6** fixtures over ArtNet.
Supports **Behringer X-Touch Compact** (MIDI) and **Elgato Stream Deck** via **Bitfocus Companion**.

## Features

- **BPM engine** — tap tempo, manual entry, beat subdivision (1/1, 1/2, 1/4, 1/8)
- **10 patterns** — Solid, Chase →, Chase ←, Ping Pong, Strobe, Fade, Colour Cycle, Rainbow, Twinkle, Split
- **12 colour presets** — Red, Orange, Yellow, Green, Cyan, Blue, Purple, Magenta, White, Warm White, UV, Blackout
- **Dual colour slots** — Colour A & B for split/alternating patterns
- **Per-fixture overrides** — independent RGBW + Dimmer + Strobe per fixture, or instant blackout
- **Master controls** — global dimmer, master blackout, play/stop
- **Live DMX monitor** — real-time channel values for all 4 fixtures
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
| 2       | PAR 2  | 7            |
| 3       | PAR 3  | 13           |
| 4       | PAR 4  | 19           |

### Channel Map — 6-Channel Mode

| Channel | Function |
|---------|----------|
| 1       | Dimmer   |
| 2       | Red      |
| 3       | Green    |
| 4       | Blue     |
| 5       | White    |
| 6       | Strobe   |

Set each fixture to **6-channel mode** and configure the start address as above.

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
| Button row 1 | Note 8–17 | Patterns (10) |
| Button row 2 | Note 18–23 | Colour A presets (first 6) |

LEDs on the X-Touch Compact are updated automatically to reflect the current state.

---

## Stream Deck — Bitfocus Companion

See **[companion-module/INSTALL.md](companion-module/INSTALL.md)** for full installation instructions.

### Quick Summary

1. Copy `companion-module/` to Companion's `developer-modules/` directory
2. Run `npm install` inside the module directory
3. Enable developer modules in Companion → Settings → Advanced
4. Add a new **"ArtNet Lightshow"** connection pointing to `localhost:3000`
5. Drag presets from the module onto your Stream Deck buttons

### Presets included

- **Patterns** (10 buttons) — highlight when active
- **Colour A** (12 buttons) — button background = colour
- **Colour B** (12 buttons)
- **Transport** — Play/Stop, Blackout, Tap Tempo, BPM ±5, Beat divisions
- **Fixtures** — per-fixture blackout (4 buttons), clear all overrides

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
| POST | `/api/color/a/:index` | Set Colour A (0-11) |
| POST | `/api/color/b/:index` | Set Colour B (0-11) |
| POST | `/api/bpm/:value` | Set BPM |
| POST | `/api/bpm/adjust/:delta` | Nudge BPM (e.g. `+5`) |
| POST | `/api/play` | Start show |
| POST | `/api/stop` | Stop show |
| POST | `/api/master/:value` | Set master dimmer (0-255) |
| POST | `/api/fixture/:id/override` | Set fixture override (JSON body) |
| POST | `/api/fixture/:id/blackout/toggle` | Toggle fixture blackout |
| POST | `/api/fixture/:id/clear` | Clear fixture override |
| GET | `/api/midi/ports` | List available MIDI ports |
| POST | `/api/midi/connect` | Connect MIDI ports `{ input, output }` |

---

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3000` | Web server port |
| `MIDI_INPUT` | _(auto)_ | MIDI input port name |
| `MIDI_OUTPUT` | _(auto)_ | MIDI output port name |

ArtNet node IP and universe are configurable in the web UI **ArtNet Settings** panel.
Default: broadcast to `2.255.255.255:6454`, universe 0.

## Keyboard Shortcut

**Space** — tap tempo
