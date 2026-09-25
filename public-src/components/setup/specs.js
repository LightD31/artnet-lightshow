/**
 * The stored settings, section by section: what each field is called, what
 * it takes and what it does. Rendered by SettingsSection, so every one gets
 * the same layout, secret handling and restart badge.
 *
 * `ctx` carries the lists some pickers are built from, which live elsewhere:
 * this machine's network interfaces and audio devices, MIDI's output ports,
 * the Hue bridge's entertainment areas.
 */

/** Where the engine is rendering right now, and how its frames have been going. */
export function engineNote(data) {
  const e = data && data.engine;
  if (!e || !e.thread) return null;
  const where = e.thread === 'worker' ? 'its own thread' : 'the main thread';
  const timing = e.frames
    ? ` — ${e.rate} frames a second, ${e.renderMs.p95} ms to render (p95), `
      + `${e.lateFrames + e.skippedFrames} late or dropped in the last minute`
    : '';
  if (e.fellBack) return { ok: false, text: `Currently: ${where}, because ${e.fellBack}${timing}.` };
  return { ok: true, text: `Currently: ${where}${timing}.` };
}

/**
 * What the server actually resolved, rather than what the box says. "I ran
 * pip install" and "the analyser can import librosa" are different claims,
 * and on a machine with several Pythons they are about different interpreters.
 */
export function pythonNote(data) {
  const py = data && data.python;
  if (!py) return null;
  if (!py.ok) return { ok: false, text: `Currently: ${py.exe} — cannot be run.` };
  const where = py.executable || py.exe;
  if (py.missing && py.missing.length) {
    return { ok: false, text: `Currently: ${where} (${py.version}) — missing ${py.missing.join(', ')}. `
      + `Set it up under Analysis environment, below, or install with: "${where}" -m pip install -r requirements.txt` };
  }
  return { ok: true, text: `Currently: ${where} (${py.version}) — all dependencies present.` };
}

export const ARTNET = {
  id: 'artnet',
  title: 'Art-Net',
  desc: 'What most small nodes speak. Takes effect immediately.',
  fields: [
    { path: 'artnet.enabled', label: 'Enabled', type: 'toggle', help: 'Turn off to run sACN only.' },
    { path: 'artnet.host', label: 'Node IP', type: 'text',
      help: 'A broadcast address (ending in .255) reaches every node on the subnet; a node\'s own address sends to it alone.' },
    { path: 'artnet.port', label: 'Port', type: 'number', min: 1, max: 65535 },
    { path: 'artnet.universe', label: 'Universe', type: 'number', min: 0, max: 32767,
      help: 'The rig\'s default universe: it seeds new fixtures, and fixtures sitting on it follow when you change it.' },
    { path: 'artnet.discovery', label: 'Find Nodes', type: 'toggle',
      help: 'While the Node IP is a broadcast address, ask the network which nodes are there and send each one its '
        + 'universes directly. Universes no node claims still go to the broadcast address.' },
    { path: 'artnet.sync', label: 'ArtSync', type: 'toggle',
      help: 'Tell the nodes to change every universe at the same instant, so a wall of LED bars moves as one. Only for '
        + 'nodes that support it: a node that has seen ArtSync waits for it.' },
  ],
};

export const SACN = {
  id: 'sacn',
  title: 'sACN (E1.31)',
  desc: 'What consoles and most modern nodes speak. Runs alongside Art-Net or instead of it. Takes effect immediately.',
  fields: [
    { path: 'sacn.enabled', label: 'Enabled', type: 'toggle' },
    { path: 'sacn.host', label: 'Node IP', type: 'text',
      help: 'Blank multicasts to each universe\'s own group (239.255.x.y), which is how sACN is normally deployed. '
        + 'Name a node to unicast to it instead.' },
    { path: 'sacn.priority', label: 'Priority', type: 'number', min: 0, max: 200,
      help: 'Higher wins when two sources drive the same universe. 100 is the E1.31 default.' },
    { path: 'sacn.sourceName', label: 'Source Name', type: 'text', help: 'What the receiving console lists this server as.' },
    { path: 'sacn.universeOffset', label: 'Universe Offset', type: 'number', min: -32767, max: 63999,
      help: 'Art-Net counts universes from 0 and sACN from 1, so +1 lines them up: a fixture on universe 0 goes out as '
        + 'sACN universe 1.' },
    { path: 'sacn.interface', label: 'Network', type: 'select',
      options: (ctx) => [
        { value: '', label: 'Let the computer choose' },
        ...(ctx.networkInterfaces || []).map((i) => ({ value: i.address, label: `${i.name} — ${i.address}` })),
      ],
      missing: (value) => `${value} (not on this machine)`,
      help: 'Which network the multicast groups go out on. Only matters on a machine that is on more than one — pick '
        + 'the one the nodes are on.' },
    { path: 'sacn.cid', label: 'Component ID', type: 'text',
      help: 'How a receiver tells sources apart. Generated on first start and stable from then on — change it only if '
        + 'two servers on the network ended up sharing one.' },
  ],
};

export const HUE = {
  id: 'hue',
  title: 'Philips Hue',
  desc: 'Drive Hue lamps from the same show as the pars. Each channel of an entertainment area follows one rig '
    + 'fixture. Build the area in the Hue app first, then pair here.',
  fields: [
    { path: 'hue.enabled', label: 'Enabled', type: 'toggle' },
    { path: 'hue.host', label: 'Bridge Address', type: 'text',
      help: 'The bridge IP. Find Bridges looks it up; a show network with no route to the internet has to have it typed in.' },
    { path: 'hue.entertainmentId', label: 'Entertainment Area', type: 'select', empty: 'pair with a bridge first',
      options: (ctx) => (ctx.hueAreas || []).map((a) => ({ value: a.id, label: `${a.name} (${a.channels.length} channels)` })),
      missing: (value) => (value ? `${value} (not on the bridge)` : 'none picked'),
      help: 'Areas are built in the Hue app, where the lamps are already placed on a floor plan. A bridge streams one area at a time.' },
    { path: 'hue.latencyMs', label: 'Pars Delay', type: 'number', unit: 'ms', min: 0, max: 500,
      help: 'Hue lamps answer later than the pars, so every hit lands on the pars first. This holds the Art-Net and sACN '
        + 'output back to match. Start around 50: run the sync test, film it in slow motion, and raise this until the '
        + 'pars and lamps flash together.' },
  ],
};

export const SOURCES = {
  id: 'sources',
  title: 'Playback sources',
  desc: 'Which sources may drive the auto show. Takes effect immediately.',
  fields: [
    { path: 'sources.prolink', label: 'PRO DJ LINK', type: 'toggle', help: 'Follow CDJs on the network for tempo and track changes.' },
    { path: 'sources.smtc', label: 'Now Playing', type: 'toggle',
      help: 'Read the computer\'s media session — the Windows one, or the MPRIS players on Linux — so any player '
        + 'drives the show. Not on macOS.' },
  ],
};

export const LIVE = {
  id: 'live',
  title: 'Live input',
  desc: 'Hear the music as it plays. Patterns keep the beat of any track, known or not, and a show made for a known '
    + 'track lines itself up with what the room hears. Needs the analysis environment (below). Takes effect immediately.',
  fields: [
    { path: 'live.enabled', label: 'Enabled', type: 'toggle' },
    { path: 'live.source', label: 'Listen To', type: 'select', resets: ['live.device'],
      options: () => [
        { value: 'loopback', label: 'What this computer plays' },
        { value: 'input', label: 'An input (line-in or microphone)' },
      ],
      help: 'What this computer plays is the easy one: Spotify, a browser, anything, straight from the sound card with no '
        + 'cable. An input takes a line off the booth output — the only way to hear a set played on other equipment.' },
    { path: 'live.device', label: 'Device', type: 'select',
      options: (ctx, valueOf) => {
        const loopback = valueOf('live.source') !== 'input';
        const devices = ctx.liveDevices || { outputs: [], inputs: [] };
        const names = (loopback ? devices.outputs : devices.inputs) || [];
        return [
          { value: '', label: loopback ? 'The default output' : 'The default input' },
          ...names.map((name) => ({ value: name, label: name })),
        ];
      },
      missing: (value) => `${value} (not found)`,
      help: 'A device that is not plugged in now keeps its name and is used when it comes back.' },
    { path: 'live.autoSync', label: 'Auto-Sync', type: 'toggle',
      help: 'Line a known track\'s show up with what is heard, rather than trust where Spotify or the media session says '
        + 'the song is. The sync offset then only has to cover the lights\' own delay.' },
    { path: 'live.director', label: 'Play By Ear', type: 'toggle',
      help: 'With the auto show on and no analysed track to play — the next one still being analysed, or music nothing '
        + 'can name — answer what is heard: new looks on section changes, bursts on drops, dark in the silences.' },
    { path: 'live.latencyMs', label: 'Room Latency', type: 'number', unit: 'ms', min: -500, max: 500,
      help: 'How much later the room hears the music than this computer does. Positive when the PA is behind the sound '
        + 'card; negative for a line-in off the booth. 0 is right for most setups.' },
  ],
};

export const SPOTIFY = {
  id: 'spotify',
  title: 'Spotify',
  desc: 'Credentials from your Spotify app dashboard. Register the redirect URI shown in the server log — by default '
    + 'http://127.0.0.1:<port>/auth/spotify/callback.',
  fields: [
    { path: 'spotify.clientId', label: 'Client ID', type: 'text' },
    { path: 'spotify.clientSecret', label: 'Client Secret', type: 'secret' },
    { path: 'spotify.proxyBase', label: 'OAuth Proxy', type: 'text', placeholder: 'optional',
      help: 'Leave blank to authorise straight against Spotify — it accepts a 127.0.0.1 redirect, so no relay is needed '
        + 'when you connect from this machine. Set one only to connect from a different device.' },
    { path: 'spotify.allowUnverifiedState', label: 'Allow Unverified State', type: 'toggle',
      help: 'Only if a proxy strips the state parameter. Disables OAuth CSRF protection.' },
  ],
};

export const DEEZER = {
  id: 'deezer',
  title: 'Deezer',
  desc: 'An ARL cookie enables exact ISRC-matched audio. Without one, analysis falls back to a yt-dlp search. '
    + 'The first ARL takes a restart: decrypting Deezer\'s audio needs an OpenSSL module the server only loads when '
    + 'there is one. Downloading from Deezer this way is against its terms of use — the ARL is from your own account, '
    + 'and the choice is yours.',
  fields: [{ path: 'deezer.arl', label: 'ARL Cookie', type: 'secret' }],
};

export const ANALYSIS = {
  id: 'analysis',
  title: 'Analysis',
  desc: 'How tracks are analysed, and the limits on the analyser and the track downloader.',
  fields: [
    { path: 'analysis.separator', label: 'Separator', type: 'select',
      options: () => [
        { value: 'demucs', label: 'Demucs (fast)' },
        { value: 'bs-roformer', label: 'BS-RoFormer (slow)' },
      ],
      help: 'Splits each track into drums, bass, vocals and other. Demucs keeps up with a live set; BS-RoFormer takes '
        + 'about seven times as long, so the playing track is rarely ready in time. Changing it restarts the analyser; '
        + 'tracks already analysed keep their result.' },
    { path: 'analysis.structureModel', label: 'Structure', type: 'select',
      options: () => [
        { value: 'auto', label: 'Auto (SongFormer on a GPU)' },
        { value: 'songformer', label: 'SongFormer, also on CPU (slow)' },
        { value: 'off', label: 'Self-similarity only' },
      ],
      help: 'Names each section: intro, verse, chorus, bridge, outro. SongFormer needs its 2.9 GB of weights (Analysis '
        + 'models, below) and takes a few seconds a track on a GPU but most of the track\'s length on a CPU. Without it '
        + 'the sections come from where the music repeats. Changing it restarts the analyser.' },
    { path: 'analysis.gpuMemory', label: 'GPU memory', type: 'select',
      options: () => [
        { value: 'auto', label: 'Auto (in RAM on a card under 12 GB)' },
        { value: 'offload', label: 'In RAM, on the card for each pass' },
        { value: 'resident', label: 'On the card all the time' },
      ],
      help: 'Where the analysis models wait between passes on an NVIDIA card. An 8 GB card cannot hold them all at once: '
        + 'kept in RAM, each goes onto the card for its own pass — a fraction of a second, not a reload from disk — and '
        + 'the card has room for it. A pass that still runs out of memory is run again on the CPU. Changing it restarts '
        + 'the analyser.' },
    { path: 'analysis.analyzerTimeoutMs', label: 'Analysis Timeout', type: 'number', unit: 'ms', min: 60000, max: 3600000,
      help: 'How long one track may analyse before the worker is considered wedged and recycled.' },
    { path: 'analysis.downloadTimeoutMs', label: 'Download Timeout', type: 'number', unit: 'ms', min: 10000, max: 3600000,
      help: 'How long yt-dlp may run before it is killed.' },
    { path: 'analysis.localRoot', label: 'Library Folder', type: 'text',
      help: 'Confine "analyse a local file" to this folder. Blank allows any path.' },
    { path: 'analysis.pythonPath', label: 'Python', type: 'text', placeholder: 'auto-detect',
      help: 'Blank auto-detects, preferring an interpreter that can import the analyser\'s dependencies. Set a full path '
        + 'when pip installed into a different Python than the one that gets picked.',
      note: pythonNote },
  ],
};

export const SHOW = {
  id: 'show',
  title: 'Show',
  desc: 'How the generated show behaves across a night.',
  fields: [
    { path: 'auto.setMemory', label: 'Remember the Night', type: 'toggle',
      help: 'Each track avoids the palette and the looks of the one before it, keeps some of its colours when the two '
        + 'keys mix, and paces its biggest moments against the tracks before it. Off plans every track as if it were '
        + 'the first of the night.' },
    { path: 'safety.flashLimit', label: 'Flash Limit', type: 'toggle',
      help: 'Photosensitivity: at most three large-area flashes a second (WCAG 2.3.1, ITU-R BT.1702). Strobes are capped '
        + 'at three a second, and a look that would flash the whole rig faster is held to a flicker under a tenth of '
        + 'full brightness. Covers every output, manual looks included. Off by default.' },
  ],
};

export const ENGINE = {
  id: 'engine',
  title: 'Engine',
  desc: 'Where frames are rendered. Applies on the next restart.',
  fields: [
    { path: 'engine.thread', label: 'Render On', type: 'select',
      options: () => [
        { value: 'worker', label: 'Its own thread (recommended)' },
        { value: 'main', label: 'The main thread' },
      ],
      help: 'On its own thread the rig keeps time while the server plans the next track, imports a fixture file or '
        + 'serves the UI. The main thread is only worth choosing to rule the thread out when chasing a problem.',
      note: engineNote },
  ],
};

export const MIDI_CLOCK = {
  id: 'midiClock',
  title: 'MIDI clock out',
  desc: 'Send the tempo the lights keep — the show\'s, a CDJ\'s, the live input\'s or a tap — as MIDI clock, so a drum '
    + 'machine, a DAW or a visuals app plays in the same time. Takes effect immediately.',
  fields: [
    { path: 'midi.clockOutput', label: 'Clock Port', type: 'select',
      options: (ctx) => [{ value: '', label: 'Off' }, ...(ctx.midiOutputs || []).map((name) => ({ value: name, label: name }))],
      missing: (value) => `${value} (not connected)`,
      help: 'A port of its own, not the controller\'s. To reach software on this machine, create a loopback port '
        + '(loopMIDI on Windows, IAC on macOS) and pick it here.' },
  ],
};

export const SERVER = {
  id: 'server',
  title: 'Server & access',
  desc: 'Read before the server starts listening, so these apply on the next restart.',
  fields: [
    { path: 'server.host', label: 'Bind Address', type: 'text',
      help: '127.0.0.1 keeps the rig on this machine. 0.0.0.0 exposes it to the network — which requires an access token.' },
    { path: 'server.port', label: 'Port', type: 'number', min: 1, max: 65535 },
    { path: 'server.token', label: 'Access Token', type: 'secret', generate: true,
      help: 'Required whenever the bind address is not loopback. Each browser needs it once: open the UI at /?token=… , '
        + 'or type it into the prompt the page raises when it is refused.' },
    { path: 'server.publicUrl', label: 'Public URL', type: 'text',
      help: 'Only needed behind a reverse proxy, or when the OAuth callback must use a hostname.' },
  ],
};
