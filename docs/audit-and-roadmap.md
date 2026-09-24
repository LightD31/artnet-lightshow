# Audit & improvement roadmap

*September 2026. A full review of the codebase and a phased plan to take it further.*

## Context

This document audits the whole project — the Node server and render engine, the show director, the Python
analysis pipeline, and the web UI — and lays out a roadmap for optimisation, a smarter show, better UI/UX and
bug fixes. It also records which current tools are worth adopting and why. Earlier design decisions are
treated as open for change.

The rig and use this plan is written for:

- **Rig:** RGBW(A/UV) pars and Philips Hue, **plus LED bars / pixel strips**.
- **Music:** **Spotify on the Windows show PC** (the hybrid Spotify + SMTC clock) **and DJs on CDJs/rekordbox**
  (PRO DJ LINK).
- **Live input:** **hybrid** — pre-analysis when the track is known, with a live input that phase-locks the beat
  and takes over when there is nothing to pre-analyse.
- **Scope:** a bold rewrite is acceptable, delivered as a phased roadmap rather than one change.

**Baseline at the time of the audit:** `npm ci` clean, `npm run lint` clean, `npm test` **620/620**,
`npm run build:client` fine (134 KB), `npm audit --omit=dev` 0 vulnerabilities. The code is careful — rationale
comments, validated stores with atomic writes, engine/preview maths shared behind a parity test. What holds it
back is structural: security gaps on the default setup, external APIs that changed underneath it, a beat
clock that never locks to the music, a one-colour-per-fixture model that cannot express pixels, and a UI that
re-renders everything on every push.

Legend: **[V]** = confirmed by reading the code during this audit. Unmarked items were found by a file-by-file survey and carry a file:line; each is re-checked when it is fixed. Line numbers refer to commit `4f2191d`.

---

## Part A — Audit findings (ranked)

### A1. Security (High)
Several issues were found in the HTTP/Socket.IO boundary and in settings validation that matter on the default
loopback setup, not only on a LAN bind. **Details are deliberately not published in this public repository until
they are fixed**; they are tracked privately and are the first item of Phase 0. Lower-severity hardening items
(input validation on uploads and imports, HTML escaping, unbounded in-memory maps) are folded into the same work.

### A2. Broken by external changes (High)
5. **[V] Spotify February 2026 dev-mode migration** (applied to existing apps 9 March 2026):
   - **ISRC may be missing.** The guide lists `external_ids` as removed from the Track object for development-mode apps; where that applies, `isrc` is null (`src/spotify.js:111,318,344`), the exact-audio Deezer path is skipped, and the track falls back to a yt-dlp *search*, which risks the wrong edit and therefore a wrong timeline. In practice Spotify still sends it to at least some apps, so the fix keeps it when present and looks one up only when it is not.
   - **Playlists moved.** `GET /playlists/{id}/tracks` became `/items`, `tracks.total` became `items.total`, and `items[].track` became `items[].item` (`spotify.js:100,372-411`). Playlists the user doesn't own or collaborate on now return no items.
6. **[V] yt-dlp needs a JavaScript runtime for YouTube** since 2025.11.12. `_ytDlpExec` (`auto-show.js:480`) passes no `--js-runtimes`, and preflight doesn't check for one. Node itself is a supported runtime.

### A3. Musical timing & sync (High — the biggest "smarter show" lever)
7. **[V] The pattern step clock free-runs.**
   - `restartBeatTimer` (`engine.js:348`) builds a `setTimeout` grid from whenever a patch arrived. Scenes re-anchor it, but it drifts between them.
   - **BPM is forced to an integer** in four places: `validation.js:47`, `clampBpm` in `show/render.js` and `director.js`, and `integrations.js:214`. A 123.7 BPM track runs at 124, about 75 ms of drift every 16 bars.
   - The analysed `beats[]`/`downbeats[]` and CDJ beat packets never step patterns.
8. **[V] Events are dispatched by polling:** a 20 ms tick (`auto-show.js:619`) plus a 25 ms render, so cues land 0–45 ms late with jitter. The sync offset fixes only the average.
9. **[V] Only the hybrid source uses the monotonic `PlaybackClock`.**
   - Spotify-only, Deezer and SMTC re-anchor raw (`integrations.js:66`). A backward jump over 100 ms → `_reseek` → `applyPatch({pattern})` → `_step = 0`, so the chase visibly restarts.
   - The hybrid source resets its clock to **0 ms** whenever the OS session stops matching (`hybrid-source.js:220` → `playback-clock.js:101`).
10. **[V] CDJ position sawtooth** (`prolink.js:407-410`).
    - The beat anchor time is reset on *every status packet*, not on each new beat, so the position keeps snapping back and reseeks constantly.
    - The extrapolation is not scaled by pitch, uses `Date.now()`, and judges staleness from any device, not the master.
11. **PRO DJ LINK wastes the data it could have.**
    - Audio comes from a yt-dlp *search*, which often returns the radio edit when the DJ plays the extended mix.
    - The exact file (over NFS), the rekordbox beat grid and **phrase analysis (PSSI)** go unused.
    - Only the master deck is followed.
    - `prolink-connect` hasn't been released since October 2022; its maintained fork is **`alphatheta-connect`**.

### A4. Robustness & performance (High/Medium)
12. **[V] No process-level safety net.**
    - There are no `uncaughtException`/`unhandledRejection` handlers.
    - The render, tick and broadcast timers aren't wrapped in try/catch.
    - Any throw kills the server with the fixtures latched on their last frame.
13. **[V] Analyzer worker bridge.**
    - **Restart race:** the single `_recycling` boolean and an exit handler that ignores which process exited mean fast track skips orphan a GPU-holding Python process and reject the whole queue (`analyzer-worker.js:275,340`).
    - **No stdin `error` listener** (`:444`), so an EPIPE crashes Node.
    - **NaN hangs a request for 600 s:** a line that doesn't parse is ignored until the timeout, and `embeddings`/S-KEY are added *after* `json_safe` (`pipeline.py:158-189`).
14. **[V] Concurrent prefetches can collide.** Temp names are `auto-dl-${Date.now()}` (`auto-show.js:470`) and the Spotify prefetch loop starts several in one tick (`integrations.js:357`). Only the time it takes to spawn yt-dlp keeps them in different milliseconds; two that do share one overwrite each other, and the wrong audio is cached under another track's key.
15. **[V] Main-thread stalls in the process that renders DMX:**
    - `GET /api/auto/cache` parses every cached analysis synchronously (`analysis-cache.js:115`).
    - `GET /api/preflight` runs the model download with `spawnSync` (`preflight.js:519`).
    - `python-env` probes with 30 s `spawnSync`.
    - Every sync-offset nudge rewrites `settings.json`.
    - The analysis cache also writes in place (not atomic), has no eviction, and its key ignores the separator and model settings.
16. **Other correctness bugs:**
    - PRO DJ LINK cache keys collide across USB sticks (`analysis-cache.js:186`).
    - A changed Deezer ARL is ignored until restart (`deezer.js:25`).
    - The show restore moves fixtures to the stored universe at boot (`show-store.js:143` vs `server.js:111`).
    - A Hue pair to an IPv6 or `host:port` address loses the issued key (`routes.js:1062`).
    - Cue and MIDI-map saves mutate memory before the write that can fail.
    - Spotify token refresh isn't single-flight.
17. **Output quality:**
    - **[V]** `dimmerFine` is always 0, so 16-bit dimming is wasted.
    - **[V]** The Art-Net sequence counter is global.
    - **[V]** The default target `2.255.255.255` misses typical 192.168.x LANs, so the first run gives a dark rig.
    - No sACN Stream_Terminated packets or universe discovery, no ArtSync, and every universe is re-sent at 40 Hz even when unchanged.

### A5. Fixture model (blocks pixel strips)
18. **[V] One colour per fixture.**
    - `channelMap` is flat, with `MAX_FIXTURES = 64` and 32 universes (`profiles.js`, `universes.js`).
    - GDTF import ignores geometry instances and 16-bit offsets, and mislabels warm white, cool white and amber (`gdtf.js:26,128,173`).
    - There is no DDP/WLED output and no Open Fixture Library import.

### A6. Analysis pipeline (Medium)
19. **No structure model.** Sections come from Laplacian clustering plus fixed rules (`structure.py:140-456`).
    - There is no buildup or pre-chorus label.
    - The fallback path can never produce "chorus".
    - Beatless intros and outros fall outside every section.
20. **Waste and fragility:**
    - The file is decoded four times.
    - Models are never pre-warmed at worker start (`cli.py:142`), despite what the docs say.
    - Beat This! waits on the GPU lock behind separation and MuQ.
    - A failure in either MuQ model discards both results.
    - The separation pool leaks on an exception.
    - The PANNs download can happen mid-track.
    - The device override skips setup, and a custom BS-RoFormer path is ignored.
    - Documents are several MB because the embeddings are unrounded.
21. **[V] The live analyser exists but isn't wired.** `analyze.py --live` / `StreamingAnalyzer` (`realtime.py`) has no audio capture and no Node consumer. Its reads are 4096-sample blocks (about 186 ms), while the docs claim 23 ms.
22. **Tooling:**
    - `download-models.py` never fetches `htdemucs` and does fetch the unused `skey-onnx`.
    - The interpreter probe doesn't check torch or beat_this.
    - `schema.py` is dead code.
    - The docs have drifted in about ten places.

### A7. UI / UX (Medium)
23. **Every `state` push is the full live state**, not a diff (`state.js:197`).
    - It is emitted on every `applyPatch`: about 2/s from expression events, plus every slider drag, unthrottled.
    - Nearly every component re-renders, and the DMX monitor re-diffs 512 cells each time.
    - The preview gets DMX at only 10 Hz and is DOM-based, so strobes and fast chases are invisible in the UI.
24. **Settings page** (`public/settings.js`, a separate 1563-line vanilla page):
    - The patch table and MIDI map are rebuilt on every push, wiping focus and edits mid-show.
    - Apply loses edits in other sections.
    - Raw `socket.emit` replays buffered actions after a reconnect.
    - It duplicates the API, auth and socket code.
25. **Live-use gaps:**
    - no PWA, Wake Lock or fullscreen, so a tablet can sleep mid-show;
    - 14–28 px touch targets;
    - information hidden in tooltips;
    - no big-button performance view and no 3D view;
    - dark theme only;
    - reduced-motion only partly honoured;
    - tabs without tabpanels and dialogs without a focus trap.
26. **Bugs:**
    - Space tap-tempo is swallowed after a click (`CommandBar.jsx:22`).
    - Previews ignore energy effects (`utils.js:44`).
    - Rehearsal resets on a view switch (`StagePreview.jsx:62`).
    - The auto-start flag is lost on a tab switch (`AutoMode.jsx:137`).
    - Analysis can't be cancelled, and failures never reach the UI.
    - Sliders snap back mid-drag.
    - Cue overwrite has no undo, and show-file load has no confirm.
    - README promises (BPM entry, 1/16 division) aren't in the UI.
    - Fixture numbering differs between pages.
    - The 641 KB source map is public, and there is no compression.
    - The extension options still say `LIGHTSHOW_TOKEN`.

---

## Part B — Target architecture ("v2")

```
 sources ─┐  Spotify(+SMTC) · alphatheta-connect (beats, PSSI, NFS audio, 2 decks) · live input (WASAPI/line-in) · tap/Link
          ▼
   Conductor (musical clock): posMs, beat, beatFrac, bar, float BPM  ◄── analysed / rekordbox beat grid
          ▼
   Director (per track + set memory) ──► Timeline (intents)  ──►  frame-accurate scheduler
          ▼
   Engine worker_thread @44 Hz: looks = pure f(musical time, fixture geometry) → cells (pars, pixels)
          ▼
   Outputs with per-output latency: Art-Net (seq/ArtSync) · sACN (term/discovery) · Hue · DDP→WLED
          ▼
   Binary frames ──► SPA (Perform / Show / Stage 3D / Rig / Sources / Settings), PWA
```

**Key decisions**
- **TypeScript**, migrated incrementally (`allowJs`), on Node 24 LTS.
- **Preact + signals kept.** They are small and already fit; TypeScript is added and the app becomes one SPA.
- **Engine in a `worker_thread`**, not a Rust sidecar.
- **Patterns become pure functions of musical time** rather than mutating `_step`, which makes preview parity exact and makes reseeks harmless.

---

## Part C — Phased roadmap

Every phase is its own PR, keeps `npm run check` and the Python suite green, and adds tests for what it changes.

### Phase 0 — Safety & broken integrations (first PR)
**Security**
- Harden the HTTP and Socket.IO boundary and settings validation (details in the private audit notes, see A1).
- Stricter handling of analysis sources, uploads and GDTF imports; escape the OAuth callback page; bound the
  in-memory OAuth state map.

**Crash safety**
- `process.on('uncaughtException'|'unhandledRejection')`: log and keep the rig running.
- try/catch around `renderDmx`, `_tick` and the integration timers.
- `analyzer-worker.js`:
  - handlers bound to their own process (`if (proc !== this._proc) return`);
  - a stdin `error` listener;
  - an unparsable line while a request is pending fails that request instead of hanging it.
- Python: run `json_safe` after the embeddings and S-KEY are added, and `json.dumps(allow_nan=False)` in `cli.py`.

**External breakage**
- `src/spotify.js`:
  - the playlist `/items` endpoint and field renames;
  - an **ISRC resolver** in `src/isrc.js`: Deezer public search `artist:"…" track:"…"` → duration within ±2 s → `/track/{id}.isrc`, cached, with MusicBrainz as the fallback. Deezer's `/track/isrc:X` is undocumented and returns a single track, so verify against a live account.
  - The README drops "anyone's playlist".
- yt-dlp: add `--js-runtimes node:<process.execPath>`. Preflight checks the yt-dlp version (≥2025.11.12) and the runtime.
- Unique download temp names (`crypto.randomUUID` inside a `mkdtemp` dir) in `auto-show.js` and `deezer.js`.

**Timing bugs**
- `prolink.js`:
  - re-anchor only when the beat number changes;
  - scale elapsed time by pitch;
  - use `performance.now()`;
  - staleness from the master only;
  - the cache key includes the media/USB identity.
- `hybrid-source.js`: keep the last position on a driver switch instead of dropping to 0.
- All non-hybrid sources run through `PlaybackClock`. Each sample is timed at the midpoint of the request's round trip. Spotify's `timestamp` field is not used, because it marks the last playback-state change, not when the position was sampled.

**Stalls**
- Analysis cache:
  - async reads;
  - a temp-then-rename write;
  - an `index.json` for `list()`;
  - LRU eviction by size;
  - the key includes the separator and model ids.
- The preflight download uses async `spawn` with a timeout.
- The sync-offset save is debounced.

### Phase 1 — Musical clock & beat-locked rendering (the foundation of "smarter")
- **New `src/show/clock.js` (Conductor).** It turns a position source plus a beat grid (analysed, rekordbox, or live) into `{posMs, beatIndex, beatFrac, barIndex, bpm}`, with float BPM and interpolation between beats. In manual mode the Conductor free-runs from tap tempo, BPM entry or MIDI.
- **Patterns derive everything from musical time.**
  - `step = floor((beatIndex + beatFrac) × division)`; fade/hit/ribbon/ensemble phases come from `beatFrac`/`barFrac`.
  - Delete `restartBeatTimer` and `_step` from `engine.js`/`patch.js`.
  - Change `src/shared/patterns.js` and `look-math.js` to accept `t`.
- **Float BPM** in `validation.js`, `render.js`/`director.js` `clampBpm` and `integrations.js:214`.
- **Frame-accurate scheduler.** Each frame fires the timeline events in `(prevPos, pos]`, replacing the 20 ms `_tick` interval in `auto-show.js`.
- **Per-output latency.** Generalise the Hue delay line in `output.js` so every output lands at the same moment.
- **`preview.js` samples the same Conductor**, so rehearsal is exact.
- **Tests:**
  - chase steps land within one frame of the analysed beats across a whole fixture track at a non-integer BPM;
  - no drift;
  - a reseek does not reset the phase.

### Phase 2 — Engine v2: TypeScript, worker thread, pixels, outputs

> **Status.**
> - **2a (#44, merged):** LED bars, meaning cells, geometry, the pixel effects, GDTF cells and 16-bit/virtual channels,
>   and the bar maker.
> - **2b (#45, merged):** the worker-thread engine at 44 Hz on a drift-corrected clock, with a main-thread fallback.
>   On the output side:
>   - Art-Net: per-universe sequence, ArtSync, and ArtPoll discovery with unicast routing.
>   - sACN: termination, discovery and interface choice.
>   - 16-bit dimming, plus a software strobe for fixtures with no strobe channel.
> - **2c (#46, merged):** the whole server as strict TypeScript on ES modules, run by Node's own type stripping
>   (Node 22.18+, no build step), and the analysis document described once in a JSON Schema that the Python tests
>   validate against and the TypeScript types are generated from.
> - **2c, OFL import:** Open Fixture Library fixtures, from a downloaded file or searched for online. Matrix modes
>   import as bars in the order their pixels sit, groups of pixels as cells, a strobe only where it behaves as the
>   show's does. Profiles gained `defaults`, so a channel the show does not drive is not left closed at 0.
> - **Deliberately dropped:**
>   - **Temporal dithering:** at 44 Hz it flickers visibly at the low levels it is meant to smooth.
>   - **Send-on-change with keep-alive:** nodes that time out would blink, and unicast routing already takes the load
>     off the network.
> - **2d:** strips longer than a universe run on into the next ones (whole pixels to each, from channel 1); panels
>   (profiles with a grid, drawn as rectangles on the stage plot, sampled in two dimensions); WLED found over mDNS,
>   added in a click from its `/json/info`, and sent DDP; caps raised against a measured budget to 4,096 cells,
>   1,024 to a fixture and 64 universes.
- **TypeScript**, starting with `src/shared`, `src/show` and `src/server`.
- **Analysis-document types** generated from a Python JSON Schema, which replaces the dead `schema.py`.
- **`worker_threads` engine** owning the Conductor, rendering and outputs, at 44 Hz with a drift-corrected timer.
  - The main thread posts patches.
  - Frames are shared through a `SharedArrayBuffer` for the monitor and preview.
- **Fixture model v2:**
  - profiles gain `cells[]`, each with emitters and optional 16-bit;
  - fixtures gain `geometry` (point / line of N pixels / matrix) in stage coordinates;
  - strips that span universes are handled automatically;
  - the caps are raised against a measured per-frame budget.
- **Looks render into a continuous field** sampled at every cell, so four pars and 600 pixels share one effect.
  - Port the 18 patterns.
  - Add pixel-native effects: gradient sweep, comet, centre-out burst, mirror, noise/plasma, bass/vocal VU and onset sparkles.
- **Outputs:**
  - **Art-Net:** per-universe sequence, ArtSync, ArtPoll first-run discovery with unicast.
  - **sACN:** stream termination, universe discovery, interface choice.
  - **16-bit dimmer** plus temporal dithering for 8-bit fixtures.
  - **DDP → WLED:** UDP 4048, up to 480 RGB px per packet, `_wled._tcp` mDNS discovery.
- **Imports:** GDTF geometry, 16-bit and amber/WW/CW fixes, plus **Open Fixture Library** JSON import.
- Cues, palettes and energy effects carry over through an adapter.

### Phase 3 — Sources v2: CDJs, Spotify, live input

> **Status (#49).**
> - **CDJs:**
>   - alphatheta-connect 0.27.0 is pinned, with npm overrides pointing its `file:` dependencies at the registry.
>   - Beat and absolute-position packets are read on our own socket: the library parses beat packets as positions.
>   - The show follows the deck on air, not only the master.
>   - The exact file is fetched over NFS and cached apart from search results.
>   - rekordbox's grid and PSSI phrases become the beats and sections.
>   - The show crossfades between decks, with the outgoing show playing on its own deck until the incoming track
>     is ready.
>   - Fader levels are left out: the DJM only reports them to a device posing as Stagehand, and on-air carries the
>     same decision.
> - **Live input:**
>   - soundcard capture (WASAPI loopback, Linux monitors) or a line-in, at a 256-sample hop.
>   - The live beat tracker now re-fits its phase to the last 4 s of onsets instead of nudging on every onset:
>     that nudging let hats and snares walk the grid off the music.
>   - Auto-sync by cross-correlating the live onsets with the analysed ones.
>   - A live director for music with no analysis.
>   - MIDI clock out.
> - **Not done:**
>   - The neural online tracker (BeatNet+/BEAST): the fixed PLL is within 10 ms on the test material, so it can wait
>     for a real need.
>   - Ableton Link: MIDI clock covers the same software through a loopback port, with nothing native to build.
- **Replace `prolink-connect` with `alphatheta-connect`:**
  - beat packets drive the Conductor (true phase lock), with 30 ms absolute position on CDJ-3000;
  - the rekordbox grid becomes the beat grid;
  - **PSSI phrases** map to section roles (Intro/Up/Down/Chorus/Bridge/Verse/Outro → intro/buildup/breakdown/chorus/…);
  - the **exact audio is fetched over NFS**, so no yt-dlp;
  - on-air/fader state for two decks crossfades the show between the tracks during a mix.
- **Live input service** (Python, `sounddevice`):
  - Capture from **WASAPI loopback** on the show PC (exactly what Spotify plays) or from a line-in off the booth output.
  - `StreamingAnalyzer` reads hop-sized blocks, which fixes the 186 ms latency.
  - An optional neural online tracker (BeatNet+ or BEAST).
  - It streams beat phase, onsets and band energy at about 100 Hz to Node over a local socket.
- **Auto-sync (known track).** Continuously cross-correlate the live onset/energy envelope with the analysed track's envelope, and feed the measured offset into the Conductor. This replaces the manual sync offset and cancels Spotify's position error.
- **Unknown track or no pre-analysis.** The Conductor runs on live beats, and a reactive "live director" uses the realtime events: drops on the rise, buildups, silence.
- **Optional:** Ableton Link (`@ktamas77/abletonlink`) in and out, and MIDI clock out.

### Phase 4 — Analysis v2

> **Status.**
> - **Structure:**
>   - SongFormer names the sections: its functions become the roles, with a new `prechorus` role, and its boundaries
>     are snapped to the bar line.
>   - The self-similarity clusters still decide which sections are the same music.
>   - A detected drop turns a chorus or an instrumental into a `drop`: SongFormer has no drop label. It does not
>     overrule a verse; on real music that turned correctly named verses into drops. Instrumentals keep a new
>     `instrumental` role.
>   - Scored against human annotations of ten SALAMI live recordings (`scripts/eval-structure.py`): section names
>     match over 68 % of the track (SongFormer alone 69 %, the labeller 33 %, "verse" everywhere 30 %), and
>     boundaries within 3 s at 0.71 F against the labeller's 0.56.
>   - The Laplacian labeller is the fallback. Its sections now reach the ends of the track.
> - **SongFormer's cost:**
>   - Measured on a 4-core CPU: 0.75× the track's length.
>   - Its attention is quadratic in the window it reads: a five-minute track read whole was killed for memory on a
>     16 GB machine. The window is now sized to the free memory, and too little falls back to the labeller.
>   - So `auto` runs it only on a GPU, and Settings → Structure can force it on or off.
>   - `bench-analyze.py --structure songformer` is the 890M benchmark still to run.
> - **Not done:**
>   - EDMFormer has no released weights.
>   - The five fixture tracks carry no audio, so the real-music score comes from SALAMI's live recordings instead:
>     not studio pop, and not club tracks.
> - **A6:** all fixed.
>   - One decode per track.
>   - Beat This! is warmed first at worker start and runs first on the GPU.
>   - MuLan and the embeddings fail independently.
>   - Every pool is shut down in `finally`.
>   - The device override gets the same set-up as auto-detection.
>   - The BS-RoFormer path is honoured.
>   - The analysis never downloads the tagger.
>   - Embeddings are rounded to four places.
>   - `--live` reads a hop at a time.
> - **Pixels:**
>   - A `pulse` block holds the stem envelopes at 50 Hz and the kick, snare and hat lanes from the drum stem.
>   - The engine samples it every frame for the `drums` and `stems` bar patterns, and `meter`.
> - **Environment:**
>   - `pyproject.toml` and `uv.lock` pin torch, torchaudio and torchvision to one index per build (cpu, cu128,
>     rocm7.2), and the server prefers the `.venv` this makes.
>   - A registry-driven `download-models.py` feeds Settings → Analysis models, with progress.
>   - The preflight imports the torch stack for real.
>   - Schema 2.1.
>   - Per-stage timings in `meta.timings` and `bench-analyze.py`.

- **Structure models:**
  - **SongFormer** for pop/rock (intro/verse/pre-chorus/chorus/bridge/inst/outro/silence);
  - **EDMFormer** for EDM (intro/buildup/drop/breakdown/outro/silence);
  - both need the **MuQ** backbone, which is already downloaded, plus MusicFM, which is new; the model is chosen from the perception genre, or both are run and fused;
  - the speed on the Radeon 890M is benchmarked before either is adopted;
  - the Laplacian labeller stays as the fallback;
  - scored against the five committed fixture tracks.
- **Fix A6:**
  - decode once at 44.1 kHz and resample;
  - warm the models at worker start, with Beat This! first;
  - isolate MuQ failures;
  - shut the pool down in `finally`;
  - device override and BS-RoFormer path;
  - fetch the tagger outside the analysis path;
  - round the embeddings.
- **For pixels:** 50 Hz per-stem envelopes and kick/snare/hat onset lanes from the drum stem.
- **Environment:**
  - a **uv**-managed Python environment with a lockfile and per-platform torch indexes (CUDA/ROCm/CPU);
  - an in-UI model manager with progress;
  - fix `download-models.py`;
  - a stronger interpreter probe;
  - a schema version bump;
  - per-stage timings in `bench-analyze.py`.

### Phase 5 — Director v2 (smarter show)
- **Pixel-aware looks by role.** Pars carry the colour and wash; strips carry motion and detail.
  - verse: slow gradient
  - pre-chorus/buildup: rising fill
  - chorus: mirrored chase
  - drop: centre-out burst plus kick sparkles
  - breakdown: low plasma
- **Accents on real drum onsets**, not on the bar grid alone.
- **Set memory:**
  - no repeated palette or look back to back;
  - an energy arc across the night;
  - harmonic-key palette continuity.
- **DJ transitions** from the Phase 3 two-deck data.
- **Photosensitivity limiter** (≤3 large-area flashes/s), which can be toggled.
- **Per-track show overlays.** Operator edits (lock palette, swap a section's look, add or remove accents) are stored with the cache entry and re-applied on every replan.
- **Research track, optional.** A/B the SeqLight/Skip-BART learned hue/intensity prior against the rule director. Adopt it only if it wins a blind test.

### Phase 6 — UI v2
- **One SPA.** Settings move into `public-src`, and `public/settings.js` and its duplicate API/auth/socket code are deleted.
- **Protocol v2:**
  - domain-scoped signals with versioned diffs;
  - binary preview frames at 30 Hz, volatile, sent only to subscribed rooms;
  - slider emits throttled to one per animation frame, with local drafts.
- **Views:**
  - **Perform:** tablet-first pads for blackout, kill, blinder, strobe, UV and palettes, plus intensity, now/next and sync health.
  - **Show:** timeline, analysis and the overlay editor.
  - **Stage:** a **three.js** 3D view with volumetric par cones, emissive pixel strips and haze, rendered from the shared engine code at 60 fps with scrubbable rehearsal.
  - **Rig:** the patch plus pixel mapping (draw strips on the plan) and Art-Net/sACN/WLED/Hue discovery with an identify flash.
  - **Sources**, **Settings** and **Preflight**.
- **PWA:** manifest, service-worker app shell, Wake Lock and fullscreen.
- **Accessibility and touch:**
  - ≥44 px targets;
  - tabpanels and dialog focus traps;
  - labels and contrast;
  - full reduced-motion support;
  - light and red-night themes;
  - a first-run onboarding wizard.
- **Fix every bug in A7.26.**
- **Tests:** Playwright e2e smoke tests (Chromium is preinstalled) and component tests.

### Phase 7 — Platform & ops (interleaved)
- **Upgrades:** Node 24 LTS, zod 4, @preact/signals 2, eslint 10, esbuild 0.28; drop dotenv.
- **Refactors:**
  - split `routes.js` (87 routes) into domain routers;
  - a shared JSON-store base class to replace four copies;
  - one loopback helper.
- **Logging:** pino structured logs with an in-UI log view, and a health endpoint.
- **Supervision:** a crash supervisor that restores the look after a restart.
- **Deezer (d-fi-core):** lazy-loaded as an optional plugin, only when an ARL is set. Terms-of-service risk is noted, and `--openssl-legacy-provider` is removed from the default start.
- **Packaging:** a Windows portable/installer build (Node SEA) plus a uv bootstrap.

---

## Part D — Tools chosen (research)

| Need | Pick | Why |
|---|---|---|
| Structure | [SongFormer](https://github.com/ASLP-lab/SongFormer) / [EDMFormer](https://github.com/25ohms/EDMFormer) | State of the art on SongFormBench; 2–4 s per song on an L40 (slower on a Radeon 890M, to be benchmarked); CC-BY-4.0; the MuQ backbone is already downloaded, only MusicFM is new |
| Online beats | [BeatNet+](https://github.com/mjhydri/BeatNet-Plus), [BEAST](https://github.com/WildHoneyPie/BEAST), plus the existing `realtime.py` | Real-time beat/downbeat tracking; BEAST reports 80 % beat F1 under 50 ms |
| CDJs | [alphatheta-connect](https://github.com/chrisle/alphatheta-connect) | Maintained fork of prolink-connect; CDJ-3000X, Opus Quad, PSSI, absolute position |
| Pixels | [WLED DDP](https://kno.wled.ge/interfaces/ddp/) | Built for pixels, no universe bookkeeping, 480 px per packet |
| Fixtures | [Open Fixture Library](https://open-fixture-library.org/) | Large free JSON fixture library, including matrices |
| 3D view | three.js (references: [ASLS Studio](https://github.com/ASLS-org/studio), [Beam](https://github.com/dinther/Beam)) | Volumetric beams in the browser |
| Tempo sync | [@ktamas77/abletonlink](https://www.npmjs.com/package/@ktamas77/abletonlink) | The most recently maintained Node Link binding |
| Learned prior (research) | [Skip-BART](https://arxiv.org/abs/2506.01482) (ICLR 2026), [SeqLight](https://arxiv.org/abs/2605.03660) | Code and weights released; trained on rock livehouse footage, so experimental only |
| External fixes | [Spotify Feb-2026 guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [yt-dlp EJS](https://github.com/yt-dlp/yt-dlp/issues/15012) | Source of A2 |

---

## Part E — Delivery & verification

**Order of work.** Phase 0 first, as one PR. Each later phase is its own PR, started after the previous one is
reviewed. Phase 7 items are interleaved wherever they unblock something.

**Verification for every phase:**
- `npm run check` (lint plus 620+ unit tests) and `npm run build:client`.
- CI's Python job (`python -m unittest discover -s tests/python`).

**Phase 0 specifics:**
- **Security:** unit tests for every hardened boundary (see the private notes).
- **Worker:** tests for the double-recycle race, the EPIPE path and a response line containing NaN.
- **Spotify:** tests using recorded `/items` payloads, plus the ISRC resolver with a mocked Deezer API.
- **yt-dlp:** a test that the args include `--js-runtimes`.
- **PRO DJ LINK:** a test that position is monotonic under 5 Hz status packets and scales with pitch.
- **Prefetch:** unique temp names under concurrent prefetch.
- **Smoke run:** start the server (`npm start`), check with curl that `/api/state` works, and exercise the hardened boundary.

**Phase 1:**
- Beat-alignment tests on `tests/fixtures/tracks/*.json` (steps within one 25 ms frame of the analysed beats at non-integer BPM).
- Preview-parity tests extended to use the Conductor.

**Phases 2–6:**
- Frame-budget benchmark: 600 pixels + 8 pars in under 2 ms per frame in the worker.
- Packet-level tests for the DDP, ArtSync and sACN termination packets.
- Playwright screenshots of the Perform, Stage and Rig views on a tablet viewport.
- Structure-model accuracy against the heuristic on the committed tracks.
