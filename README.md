# ArtNet Lightshow

Web-based light show controller for **4× Cameo ROOT PAR 6** fixtures over ArtNet.

## Features

- **BPM engine** — tap tempo, manual entry, beat subdivision (1/1, 1/2, 1/4, 1/8)
- **10 patterns** — Solid, Chase →, Chase ←, Ping Pong, Strobe, Fade, Colour Cycle, Rainbow, Twinkle, Split
- **12 colour presets** — Red, Orange, Yellow, Green, Cyan, Blue, Purple, Magenta, White, Warm White, UV, Blackout
- **Dual colour slots** — Colour A & B for split/alternating patterns
- **Per-fixture overrides** — independent RGBW + Dimmer + Strobe per fixture, or instant blackout
- **Master controls** — global dimmer, master blackout, play/stop
- **Live DMX monitor** — real-time channel values for all 4 fixtures
- **ArtNet settings** — configure node IP, port, universe in the UI

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

## Installation

```bash
npm install
npm start
```

Open **http://localhost:3000** in a browser.

## Configuration

Set your ArtNet node IP in the **ArtNet Settings** panel (default `2.255.255.255` — broadcast).
For a specific node use its IP, e.g. `2.0.0.1`.

Override `PORT` env var to change the web server port (default `3000`).

## Keyboard Shortcut

**Space** — tap tempo
