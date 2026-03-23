# Installing the Companion Module

## Requirements
- Bitfocus Companion v3.x
- Node.js 18+
- The ArtNet Lightshow server running (`npm start` in the parent directory)

## Installation

### 1. Install module dependencies
```bash
cd companion-module
npm install
```

### 2. Copy to Companion's developer modules folder

Companion v3 loads local/developer modules from:

| OS      | Path |
|---------|------|
| Windows | `%APPDATA%\Companion\developer-modules\` |
| macOS   | `~/Library/Application Support/companion/developer-modules/` |
| Linux   | `~/.config/companion/developer-modules/` |

Copy (or symlink) this entire `companion-module` folder there and rename it to `companion-module-artnet-lightshow`:

```bash
# Linux / macOS example
mkdir -p ~/.config/companion/developer-modules
cp -r /path/to/artnet-lightshow/companion-module \
      ~/.config/companion/developer-modules/companion-module-artnet-lightshow
```

### 3. Enable developer modules in Companion

In Companion's web UI (usually http://localhost:8000):
1. Go to **Settings → Advanced**
2. Enable **"Developer modules"**
3. Restart Companion

### 4. Add the connection

1. Go to **Connections** → **Add connection**
2. Search for **"ArtNet Lightshow"**
3. Set **Host** = IP of the machine running the lightshow server (e.g. `127.0.0.1`)
4. Set **Port** = `3000` (or whatever `PORT` env var is set to)
5. Click **Save**

The connection will show **OK** once it connects to the running server.

### 5. Add buttons to your Stream Deck

1. Go to **Buttons** page
2. Click **Presets** in the right panel
3. Find **"ArtNet Lightshow"** in the module list
4. Drag presets onto your Stream Deck buttons:
   - **Patterns** — 10 pattern buttons with active feedback
   - **Colour A / Colour B** — 12 colour buttons each, button background matches colour
   - **Transport** — Play/Stop, Blackout, Tap Tempo, BPM ±5, Beat divisions
   - **Fixtures** — Per-fixture blackout + clear all overrides

## Available Actions

| Action | Description |
|--------|-------------|
| Set Pattern | Switch to a specific pattern |
| Set Colour A / B | Change the colour slots |
| Set BPM | Set exact BPM |
| Adjust BPM | Nudge BPM by ± amount |
| Tap Tempo | Register a tap |
| Set Master Dimmer | 0-255 |
| Master Blackout | On / Off / Toggle |
| Play / Stop | On / Off / Toggle |
| Beat Division | 1/1, 1/2, 1/4, 1/8 |
| Fixture Blackout | Per fixture, toggle/on/off |
| Fixture Override (RGBW) | Set colour + dimmer on one fixture |
| Clear Fixture Override | Remove override on one or all fixtures |

## Available Feedbacks (button highlight)

| Feedback | Triggers when… |
|----------|---------------|
| Pattern active | Selected pattern is running |
| Master blackout | Blackout is on |
| Playing | Show is playing |
| Colour A active | Colour A slot matches |
| Colour B active | Colour B slot matches |
| Fixture blackout | That fixture is blacked out |
| Fixture override | That fixture has an active override |
