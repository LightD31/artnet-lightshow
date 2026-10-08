# ArtNet Lightshow

Controls the [ArtNet Lightshow](https://github.com/LightD31/artnet-lightshow) server — a beat-synced light show for DMX fixtures, LED bars, WLED strips and panels and Philips Hue lamps — from a Stream Deck or any Companion surface. Built for busking: looks, colours, the pads and tempo a press away for a show played by hand, and the auto show to ride the rest of the night.

## Configuration

| Setting      | Description                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| Host         | Hostname or IP of the machine running the lightshow server                                  |
| Port         | Port of the lightshow server (default `3000`)                                               |
| Access token | The server's access token, when it has one (it must whenever it is reachable from the network) |

The connection shows **OK** once connected and reconnects on its own. It follows the server by its changes alone (protocol 2), so a big rig — a WLED panel of thousands of pixels — costs Companion nothing between changes.

The patterns, colours, palettes, energy effects, fixtures and cues offered in actions, feedbacks and presets are the server's own, read when it connects: a pattern or a cue added on the server shows up here without a new module.

## Busking

The **Busk** preset page plays a show by hand, with the auto show stopped:

- **Looks** — the previous and next pattern or effect, the look on stage, a random pattern or effect, and play/stop. The patterns are the classic and party ones; the effects are Hue Dynamics' and Light DJ's, the fast-flashing ones only once the photosensitivity acknowledgement is given on the server. They are the lists an X-Touch's encoders browse, in the same order.
- **Colours over every effect** — every palette on the server as the palette override, each button in its first colour: on until pressed again, lit while on. Then palette off, a random palette and random colours A–D (never the blackout colour).
- **Hits** — the server's 16 pads, labelled from it: a hold pad plays while its button is down, renewed, so a crash or a dropped network lets go of it; a loop toggles; a once fires. Then a strobe burst and a blackout held. The strobes wait for the photosensitivity acknowledgement.
- **Tempo** — tap, the BPM, double and halve, automatic tempo match on/off, and the beat division from 1/1 to 1/16.
- **Show** — the auto show on/off, the track playing, stop every effect, the master level (±10 % and a display) and blackout.
- **Cues** — one button for each cue saved on the server.

The **Auto show** page rides it instead: on/off, its intensity (±10 and a display), a sync nudge (±20 ms) and the track playing.

## Actions

| Action                            | Description                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Set Pattern                       | Switch the running pattern, optionally crossfading over some milliseconds            |
| Set Bars Pattern                  | The LED bars' own picture (a pixel effect) while the pars run the pattern; or none   |
| Set Panels Pattern                | The panels' own picture (a WLED matrix: bars, fire, rain…); or none, as the bars     |
| Set Pixel Map                     | Lay pixel effects across the stage, along each bar, or mirrored                      |
| Set Palette                       | A server palette with 1–8 colour slots and authored gradients; classic variants use 2, 3 or 4 colours |
| Set Colour A / B / C / D          | Change one colour slot (C/D feed 3/4-colour patterns)                                |
| Set BPM / Adjust BPM              | Set exact BPM or nudge it by ± amount                                                |
| Double / Halve BPM                | ×2 or ÷2                                                                             |
| Tap Tempo                         | Register a tap                                                                       |
| Set / Adjust Master Dimmer        | 0-255, or by ± amount                                                                |
| Master Blackout                   | On / Off / Toggle — On on a button's down and Off on its up makes a blackout hold    |
| Play / Stop                       | On / Off / Toggle                                                                    |
| Outputs Armed / Disarmed          | Arm / Disarm / Toggle whether anything leaves the machine: disarmed, no Art-Net, sACN or DDP frame goes out and the Hue bridges are handed back. The server starts disarmed; disarming stops the patterns |
| Set Beat Division                 | 1/1, 1/2, 1/4, 1/8, 1/16                                                             |
| Palette Override                  | A palette over every effect: on / off / toggle                                       |
| Palette Override Off              | Back to the look's own colours                                                       |
| Browse Patterns or Effects        | The next or previous pattern or effect, round the list, with an optional crossfade   |
| Random Pattern, Effect, Palette or Colours | A random one, never the one on                                              |
| Stop Every Effect                 | Stop every running pad, effect and strobe                                            |
| Automatic Tempo Match             | Follow the music's tempo, keep yours, or toggle                                      |
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
| Panels pattern is active       | The panels are running that picture (or none)              |
| Pixel map is active            | Pixel effects are laid out that way                        |
| Palette is active              | That palette is the look's                                 |
| Palette override is on         | That palette (or any) is over every effect                 |
| Tempo follows the music        | Automatic tempo match is on                                |
| Colour A/B/C/D selected        | That colour slot matches                                   |
| Master blackout active         | Blackout is on                                             |
| Show is playing                | Show is playing                                            |
| Outputs are armed              | Frames are going out to the rig                            |
| Auto show is running           | The auto show is on                                        |
| Auto show follows this source  | The auto show is following that source now                 |
| Energy override active         | An (or a specific) effect is on, latched or held           |
| Fixture blackout / override    | That fixture is blacked out, or has an override            |

## Variables

`bpm` (to a tenth), `clock_source` (Auto, CDJ, Track or Tap), `beat_division`, `playing`, `outputs_armed`, `pattern`, `pattern_id`, `pixel_pattern`, `panel_pattern`, `pixel_map`, `palette`, `palette_override`, `color_a` … `color_d`, `master_dimmer`, `master_dimmer_pct`, `master_blackout`, `strobe_function`, `strobe_speed`, `energy_override`, `auto_show`, `auto_source`, `auto_intensity`, `sync_offset`, `track` (Artist — Title), `cue_count`

## Presets

Besides **Busk** and **Auto show**: the 16 pads and the strobe burst (**Deck**); every pattern (the whole-rig ones and the pixel effects apart), the bars' and the panels' own pictures and the pixel map; all four colour slots and whole palettes into them; transport (the outputs' arming switch, play/stop, blackout, tap tempo, BPM, beat divisions); a blackout for each fixture in the patch; and energy effects, latched or held. Button texts name variables by the connection's own label, so they keep working whatever it is called.
