# ArtNet Lightshow

Controls the [ArtNet Lightshow](https://github.com/LightD31/artnet-lightshow) server — a beat-synced light show for DMX fixtures, LED bars, WLED strips and panels and Philips Hue lamps — from a Stream Deck or any Companion surface. Built for busking: palettes, patterns and pixel effects a press away, effects that last as long as a button is held, cues, tempo and the auto show.

## Configuration

| Setting      | Description                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| Host         | Hostname or IP of the machine running the lightshow server                                  |
| Port         | Port of the lightshow server (default `3000`)                                               |
| Access token | The server's access token, when it has one (it must whenever it is reachable from the network) |

The connection shows **OK** once connected and reconnects on its own. It follows the server by its changes alone (protocol 2), so a big rig — a WLED panel of thousands of pixels — costs Companion nothing between changes.

The patterns, colours, palettes, energy effects, fixtures and cues offered in actions, feedbacks and presets are the server's own, read when it connects: a pattern or a cue added on the server shows up here without a new module.

## Busking

The **Busk** preset page has what a set played by hand needs:

- **Palettes** — every palette on the server, each button in its first colour, lit while it is the look's palette.
- **Hold** — each energy effect (white strobe, colour strobe, blinder, UV wash, kill, glow) and a blackout, **on only while the button is held**. The server lets go of a held effect on its own a second after it last heard from Companion, so a crash or a dropped network with a button down never leaves the rig strobing.
- **Tempo** — tap, the BPM, double and halve, ±5.
- **Auto show** — start or stop it, its intensity (±10 and a display), a sync nudge (±20 ms) and the track playing.
- **Master** — the master level (±10 % and a display) and blackout.
- **Cues** — one button for each cue saved on the server.

## Actions

| Action                            | Description                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Set Pattern                       | Switch the running pattern, optionally crossfading over some milliseconds            |
| Set Bars Pattern                  | The LED bars' own picture (a pixel effect) while the pars run the pattern; or none   |
| Set Pixel Map                     | Lay pixel effects across the stage, along each bar, or mirrored                      |
| Set Palette                       | A palette from the server, at 2, 3 or 4 colours                                      |
| Set Colour A / B / C / D          | Change one colour slot (C/D feed 3/4-colour patterns)                                |
| Set BPM / Adjust BPM              | Set exact BPM or nudge it by ± amount                                                |
| Double / Halve BPM                | ×2 or ÷2                                                                             |
| Tap Tempo                         | Register a tap                                                                       |
| Set / Adjust Master Dimmer        | 0-255, or by ± amount                                                                |
| Master Blackout                   | On / Off / Toggle — On on a button's down and Off on its up makes a blackout hold    |
| Play / Stop                       | On / Off / Toggle                                                                    |
| Set Beat Division                 | 1/1, 1/2, 1/4, 1/8                                                                   |
| Energy Hold                       | Press on a button's down, Release on its up: the effect lasts while it is held      |
| Energy Override / Off             | Latch an energy effect on, or clear it                                               |
| Set Strobe Function / Speed       | Choose the strobe program and its speed                                              |
| Recall Cue                        | Put a saved cue on stage                                                             |
| Auto Show Start / Stop            | Start, stop or toggle the auto show                                                  |
| Auto Show Intensity               | Set it, or adjust it by ± amount                                                     |
| Auto Show Source                  | What the auto show follows: auto-detect, Spotify, PRO DJ LINK, the live input, …     |
| Nudge Auto Show Sync              | Run the lights earlier (+) or later (−) against the music                             |
| Fixture Blackout                  | Per fixture, toggle/on/off                                                           |
| Fixture Override (RGBWAUV)        | Set colour + dimmer on one fixture                                                   |
| Clear Fixture Override            | Remove override on one or all fixtures                                               |

## Feedbacks

| Feedback                       | Button highlights when…                                    |
| ------------------------------ | ---------------------------------------------------------- |
| Pattern is active              | Selected pattern is running                                |
| Bars pattern is active         | The bars are running that picture (or none)                |
| Pixel map is active            | Pixel effects are laid out that way                        |
| Palette is active              | That palette is the look's                                 |
| Colour A/B/C/D selected        | That colour slot matches                                   |
| Master blackout active         | Blackout is on                                             |
| Show is playing                | Show is playing                                            |
| Auto show is running           | The auto show is on                                        |
| Auto show follows this source  | The auto show is following that source now                 |
| Energy override active         | An (or a specific) effect is on, latched or held           |
| Fixture blackout / override    | That fixture is blacked out, or has an override            |

## Variables

`bpm` (to a tenth), `clock_source` (Auto, CDJ, Track or Tap), `beat_division`, `playing`, `pattern`, `pattern_id`, `pixel_pattern`, `pixel_map`, `palette`, `color_a` … `color_d`, `master_dimmer`, `master_dimmer_pct`, `master_blackout`, `strobe_function`, `strobe_speed`, `energy_override`, `auto_show`, `auto_source`, `auto_intensity`, `sync_offset`, `track` (Artist — Title), `cue_count`

## Presets

Besides **Busk**: every pattern (the whole-rig ones and the pixel effects apart), the bars' own picture and the pixel map; all four colour slots; transport (play/stop, blackout, tap tempo, BPM, beat divisions); a blackout for each fixture in the patch; and latched energy effects.
