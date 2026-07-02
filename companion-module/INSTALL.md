# Installing the Companion Module

## Requirements

- Bitfocus Companion v4.3 or later (the module uses the v2 connection API)
- Node.js 22+ (only needed to `npm install` / package the module)
- The ArtNet Lightshow server running (`npm start` in the parent directory)

## Installation

### 1. Install module dependencies

```bash
cd companion-module
npm install
```

### 2. Add the folder to Companion's developer modules

Companion loads modules under development from a folder you choose:

1. Open the **Companion launcher**, click the **cog icon** (top right) to show advanced settings
2. In the **Developer** section, click **Select** and pick a folder (e.g. `~/companion-dev-modules`)
3. Make sure the developer-modules toggle is enabled

The chosen folder must **contain** module folders (it is not the module folder itself). Copy or symlink this `companion-module` directory into it:

```bash
# Linux / macOS example
mkdir -p ~/companion-dev-modules
ln -s /path/to/artnet-lightshow/companion-module ~/companion-dev-modules/companion-module-artnet-lightshow
```

Companion watches the folder: when you edit module files it restarts just that module automatically.

Alternatively, build a distributable package with `npm run package` and use the generated `pkg` output.

### 3. Add the connection

1. Go to **Connections** → **Add connection**
2. Search for **"ArtNet Lightshow"**
3. Set **Host** = IP of the machine running the lightshow server (e.g. `127.0.0.1`)
4. Set **Port** = `3000` (or whatever `PORT` env var is set to)
5. Click **Save**

The connection will show **OK** once it connects to the running server.

### 4. Add buttons to your Stream Deck

1. Go to the **Buttons** page
2. Click **Presets** in the right panel
3. Find **"ArtNet Lightshow"** in the module list
4. Drag presets onto your Stream Deck buttons:
   - **Patterns** — all patterns with active feedback
   - **Colours** — palette slots A–D, button background matches the colour
   - **Transport** — Play/Stop, Blackout, Tap Tempo, BPM display/±5, beat divisions
   - **Fixtures** — per-fixture blackout + clear all overrides
   - **Energy** — momentary effects (hold to activate, release to clear)

See `companion/HELP.md` (also shown in Companion's connection help) for the full list of actions, feedbacks and variables.
