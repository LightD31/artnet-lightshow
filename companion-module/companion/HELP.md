# ArtNet Lightshow

Controls the [ArtNet Lightshow](https://github.com/LightD31/artnet-lightshow) server — a beat-synced light show engine for 4x Cameo ROOT PAR 6 — over Socket.IO.

## Configuration

| Setting | Description                                                          |
| ------- | -------------------------------------------------------------------- |
| Host    | Hostname or IP of the machine running the lightshow server           |
| Port    | Port of the lightshow server (default `3000`, or the `PORT` env var) |

Start the server with `npm start` in the project root. The connection shows **OK** once connected and reconnects automatically.

## Actions

| Action                     | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| Set Pattern                | Switch to a specific pattern                         |
| Set Colour A / B / C / D   | Change a palette slot (C/D feed 3/4-colour patterns) |
| Set BPM / Adjust BPM       | Set exact BPM or nudge it by ± amount                |
| Tap Tempo                  | Register a tap                                       |
| Set Master Dimmer          | 0-255                                                |
| Master Blackout            | On / Off / Toggle                                    |
| Play / Stop                | On / Off / Toggle                                    |
| Set Beat Division          | 1/1, 1/2, 1/4, 1/8                                   |
| Fixture Blackout           | Per fixture, toggle/on/off                           |
| Fixture Override (RGBWAUV) | Set colour + dimmer on one fixture                   |
| Clear Fixture Override     | Remove override on one or all fixtures               |
| Energy Override / Off      | Activate or clear an energy effect                   |
| Set Strobe Function/Speed  | Choose the strobe program and its speed              |

## Feedbacks

| Feedback                | Button highlights when…             |
| ----------------------- | ----------------------------------- |
| Pattern is active       | Selected pattern is running         |
| Master blackout active  | Blackout is on                      |
| Show is playing         | Show is playing                     |
| Colour A/B/C/D selected | That palette slot matches           |
| Fixture blackout        | That fixture is blacked out         |
| Fixture override        | That fixture has an active override |
| Energy override active  | An (or a specific) effect is active |

## Variables

`bpm`, `beat_division`, `playing`, `pattern`, `pattern_id`, `color_a` … `color_d`, `master_dimmer`, `master_blackout`, `strobe_function`, `strobe_speed`, `energy_override`

## Presets

Ready-made buttons are provided for patterns, all four colour slots, transport (play/stop, blackout, tap tempo, BPM, beat divisions), per-fixture blackouts and momentary energy effects (hold to activate, release to clear).
