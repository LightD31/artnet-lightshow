'use strict';

const {
  InstanceBase,
  runEntrypoint,
  InstanceStatus,
  combineRgb,
} = require('@companion-module/base');

const { io } = require('socket.io-client');

// ── Colour helpers ────────────────────────────────────────────────────────────

const COLOR_PRESETS = [
  { name: 'Red',        r: 255, g: 0,   b: 0,   w: 0   },
  { name: 'Orange',     r: 255, g: 80,  b: 0,   w: 0   },
  { name: 'Yellow',     r: 255, g: 200, b: 0,   w: 0   },
  { name: 'Green',      r: 0,   g: 255, b: 0,   w: 0   },
  { name: 'Cyan',       r: 0,   g: 255, b: 255, w: 0   },
  { name: 'Blue',       r: 0,   g: 0,   b: 255, w: 0   },
  { name: 'Purple',     r: 100, g: 0,   b: 255, w: 0   },
  { name: 'Magenta',    r: 255, g: 0,   b: 200, w: 0   },
  { name: 'White',      r: 0,   g: 0,   b: 0,   w: 255 },
  { name: 'Warm White', r: 255, g: 120, b: 20,  w: 200 },
  { name: 'UV',         r: 30,  g: 0,   b: 255, w: 0   },
  { name: 'Blackout',   r: 0,   g: 0,   b: 0,   w: 0   },
];

const PATTERNS = [
  { id: 'solid',       name: 'Solid'        },
  { id: 'chase',       name: 'Chase →'      },
  { id: 'chase-rev',   name: 'Chase ←'      },
  { id: 'ping-pong',   name: 'Ping Pong'    },
  { id: 'strobe',      name: 'Strobe'       },
  { id: 'fade',        name: 'Fade'         },
  { id: 'color-cycle', name: 'Colour Cycle' },
  { id: 'rainbow',     name: 'Rainbow'      },
  { id: 'twinkle',     name: 'Twinkle'      },
  { id: 'split',       name: 'Split'        },
];

const ENERGY_EFFECTS = [
  { id: 'white-strobe',  name: 'White Strobe'  },
  { id: 'blinder',       name: 'Blinder'       },
  { id: 'uv-strobe',     name: 'UV Strobe'     },
  { id: 'color-strobe',  name: 'Colour Strobe' },
  { id: 'all-on',        name: 'All On'        },
];

const STROBE_FUNCTIONS = [
  { id: 'standard',         name: 'Standard'         },
  { id: 'ramp-up-down',     name: 'Ramp Up/Down'     },
  { id: 'ramp-up-down-rnd', name: 'Ramp Up/Down Rnd' },
  { id: 'ramp-up',          name: 'Ramp Up'          },
  { id: 'ramp-up-rnd',      name: 'Ramp Up Rnd'      },
  { id: 'ramp-down',        name: 'Ramp Down'        },
  { id: 'ramp-down-rnd',    name: 'Ramp Down Rnd'    },
  { id: 'random',           name: 'Random'           },
  { id: 'break',            name: 'Break'            },
];

function presetColor(c) {
  // Map RGBWAUV → Companion RGB for button preview
  // Amber ≈ warm orange; UV ≈ blue-purple
  return combineRgb(
    Math.min(255, c.r + c.w + Math.round(c.a * 1.0) + Math.round((c.uv || 0) * 0.2)),
    Math.min(255, c.g + c.w + Math.round(c.a * 0.5)),
    Math.min(255, c.b + c.w + Math.round((c.uv || 0) * 0.9)),
  );
}

// ── Module class ──────────────────────────────────────────────────────────────

class ArtnetLightshowInstance extends InstanceBase {
  constructor(internal) {
    super(internal);
    this.socket = null;
    this.liveState = {};
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init(config) {
    this.config = config;
    this.updateStatus(InstanceStatus.Connecting, 'Connecting…');
    this._connect();
    this._initActions();
    this._initFeedbacks();
    this._initPresets();
  }

  async destroy() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  async configUpdated(config) {
    this.config = config;
    if (this.socket) this.socket.disconnect();
    this._connect();
  }

  getConfigFields() {
    return [
      {
        type: 'textinput',
        id: 'host',
        label: 'Lightshow server host',
        default: '127.0.0.1',
        width: 8,
      },
      {
        type: 'number',
        id: 'port',
        label: 'Port',
        default: 3000,
        min: 1,
        max: 65535,
        width: 4,
      },
    ];
  }

  // ── Socket connection ──────────────────────────────────────────────────────

  _connect() {
    const url = `http://${this.config.host || '127.0.0.1'}:${this.config.port || 3000}`;
    this.log('debug', `Connecting to ${url}`);

    this.socket = io(url, { reconnection: true, reconnectionDelay: 2000 });

    this.socket.on('connect', () => {
      this.updateStatus(InstanceStatus.Ok);
      this.log('info', 'Connected to ArtNet Lightshow');
    });

    this.socket.on('disconnect', () => {
      this.updateStatus(InstanceStatus.ConnectionFailure, 'Disconnected');
    });

    this.socket.on('connect_error', (err) => {
      this.updateStatus(InstanceStatus.ConnectionFailure, err.message);
    });

    this.socket.on('state', (s) => {
      this.liveState = s;
      this.checkFeedbacks(
        'pattern_active',
        'blackout_active',
        'playing',
        'color_a_active',
        'color_b_active',
        'fixture_blackout',
        'fixture_override',
        'energy_override_active',
      );
    });
  }

  _emit(event, data) {
    if (this.socket && this.socket.connected) {
      this.socket.emit(event, data);
    } else {
      this.log('warn', 'Not connected — action ignored');
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  _initActions() {
    this.setActionDefinitions({

      set_pattern: {
        name: 'Set Pattern',
        options: [
          {
            type: 'dropdown',
            id: 'pattern',
            label: 'Pattern',
            default: 'chase',
            choices: PATTERNS.map(p => ({ id: p.id, label: p.name })),
          },
        ],
        callback: ({ options }) => this._emit('set', { pattern: options.pattern }),
      },

      set_color_a: {
        name: 'Set Colour A',
        options: [
          {
            type: 'dropdown',
            id: 'color',
            label: 'Colour',
            default: 0,
            choices: COLOR_PRESETS.map((c, i) => ({ id: i, label: c.name })),
          },
        ],
        callback: ({ options }) => this._emit('set', { colorA: options.color }),
      },

      set_color_b: {
        name: 'Set Colour B',
        options: [
          {
            type: 'dropdown',
            id: 'color',
            label: 'Colour',
            default: 6,  // Blue
            choices: COLOR_PRESETS.map((c, i) => ({ id: i, label: c.name })),
          },
        ],
        callback: ({ options }) => this._emit('set', { colorB: options.color }),
      },

      set_bpm: {
        name: 'Set BPM',
        options: [
          { type: 'number', id: 'bpm', label: 'BPM', default: 120, min: 20, max: 300 },
        ],
        callback: ({ options }) => this._emit('set', { bpm: options.bpm }),
      },

      adjust_bpm: {
        name: 'Adjust BPM',
        options: [
          { type: 'number', id: 'delta', label: 'Amount (±)', default: 5, min: -100, max: 100 },
        ],
        callback: ({ options }) => {
          const current = (this.liveState.bpm || 120);
          this._emit('set', { bpm: Math.max(20, Math.min(300, current + options.delta)) });
        },
      },

      tap_tempo: {
        name: 'Tap Tempo',
        options: [],
        callback: () => this._emit('tap'),
      },

      set_master_dimmer: {
        name: 'Set Master Dimmer',
        options: [
          { type: 'number', id: 'value', label: 'Level (0-255)', default: 255, min: 0, max: 255 },
        ],
        callback: ({ options }) => this._emit('set', { masterDimmer: options.value }),
      },

      master_blackout: {
        name: 'Master Blackout',
        options: [
          {
            type: 'dropdown',
            id: 'mode',
            label: 'Mode',
            default: 'toggle',
            choices: [
              { id: 'toggle', label: 'Toggle' },
              { id: 'on',     label: 'On'     },
              { id: 'off',    label: 'Off'    },
            ],
          },
        ],
        callback: ({ options }) => {
          const cur = this.liveState.masterBlackout;
          const next = options.mode === 'toggle' ? !cur : options.mode === 'on';
          this._emit('set', { masterBlackout: next });
        },
      },

      play_stop: {
        name: 'Play / Stop',
        options: [
          {
            type: 'dropdown',
            id: 'mode',
            label: 'Mode',
            default: 'toggle',
            choices: [
              { id: 'toggle', label: 'Toggle' },
              { id: 'play',   label: 'Play'   },
              { id: 'stop',   label: 'Stop'   },
            ],
          },
        ],
        callback: ({ options }) => {
          const cur = this.liveState.running;
          const next = options.mode === 'toggle' ? !cur : options.mode === 'play';
          this._emit('set', { running: next });
        },
      },

      beat_division: {
        name: 'Set Beat Division',
        options: [
          {
            type: 'dropdown',
            id: 'div',
            label: 'Division',
            default: 1,
            choices: [
              { id: 1, label: '1/1 (whole)'   },
              { id: 2, label: '1/2 (half)'    },
              { id: 4, label: '1/4 (quarter)' },
              { id: 8, label: '1/8 (eighth)'  },
            ],
          },
        ],
        callback: ({ options }) => this._emit('set', { beatDivision: options.div }),
      },

      fixture_blackout: {
        name: 'Fixture Blackout',
        options: [
          { type: 'number', id: 'fixture', label: 'Fixture (1-4)', default: 1, min: 1, max: 4 },
          {
            type: 'dropdown',
            id: 'mode',
            label: 'Mode',
            default: 'toggle',
            choices: [
              { id: 'toggle', label: 'Toggle' },
              { id: 'on',     label: 'On'     },
              { id: 'off',    label: 'Off'    },
            ],
          },
        ],
        callback: ({ options }) => {
          const id   = options.fixture - 1;
          const fix  = this.liveState.fixtures && this.liveState.fixtures[id];
          const cur  = fix && fix.override && fix.override.blackout;
          const next = options.mode === 'toggle' ? !cur : options.mode === 'on';
          this._emit('override', {
            id,
            override: { enabled: true, r: 0, g: 0, b: 0, w: 0, dim: 0, strobe: 0, blackout: next },
          });
        },
      },

      fixture_override: {
        name: 'Fixture Override (RGBWAUV)',
        options: [
          { type: 'number', id: 'fixture', label: 'Fixture (1-4)', default: 1, min: 1, max: 4 },
          { type: 'colorpicker', id: 'rgb', label: 'RGB Colour', default: combineRgb(255, 0, 0) },
          { type: 'number', id: 'white', label: 'White (0-255)',  default: 0,   min: 0, max: 255 },
          { type: 'number', id: 'amber', label: 'Amber (0-255)',  default: 0,   min: 0, max: 255 },
          { type: 'number', id: 'uv',    label: 'UV (0-255)',     default: 0,   min: 0, max: 255 },
          { type: 'number', id: 'dim',   label: 'Dimmer (0-255)', default: 255, min: 0, max: 255 },
        ],
        callback: ({ options }) => {
          const rgb = options.rgb;
          this._emit('override', {
            id: options.fixture - 1,
            override: {
              enabled: true,
              r:  (rgb >> 16) & 0xff,
              g:  (rgb >> 8)  & 0xff,
              b:   rgb        & 0xff,
              w:  options.white,
              a:  options.amber,
              uv: options.uv,
              dim: options.dim,
              strobe: 0,
              blackout: false,
            },
          });
        },
      },

      energy_override: {
        name: 'Energy Override (activate)',
        options: [
          {
            type: 'dropdown',
            id: 'effect',
            label: 'Effect',
            default: 'white-strobe',
            choices: ENERGY_EFFECTS.map(e => ({ id: e.id, label: e.name })),
          },
        ],
        callback: ({ options }) => {
          this._emit('set', { energyOverride: options.effect });
        },
      },

      energy_override_off: {
        name: 'Energy Override Off',
        options: [],
        callback: () => {
          this._emit('set', { energyOverride: null });
        },
      },

      set_strobe_function: {
        name: 'Set Strobe Function',
        options: [
          {
            type: 'dropdown',
            id: 'func',
            label: 'Function',
            default: 'standard',
            choices: STROBE_FUNCTIONS.map(f => ({ id: f.id, label: f.name })),
          },
        ],
        callback: ({ options }) => this._emit('set', { strobeFunction: options.func }),
      },

      fixture_clear: {
        name: 'Clear Fixture Override',
        options: [
          {
            type: 'dropdown',
            id: 'fixture',
            label: 'Fixture',
            default: 'all',
            choices: [
              { id: 'all', label: 'All fixtures' },
              { id: 1,     label: 'PAR 1' },
              { id: 2,     label: 'PAR 2' },
              { id: 3,     label: 'PAR 3' },
              { id: 4,     label: 'PAR 4' },
            ],
          },
        ],
        callback: ({ options }) => {
          if (options.fixture === 'all') {
            for (let i = 0; i < 4; i++) this._emit('override', { id: i, override: null });
          } else {
            this._emit('override', { id: options.fixture - 1, override: null });
          }
        },
      },

    });
  }

  // ── Feedbacks ──────────────────────────────────────────────────────────────

  _initFeedbacks() {
    this.setFeedbackDefinitions({

      pattern_active: {
        type: 'boolean',
        name: 'Pattern is active',
        defaultStyle: { bgcolor: combineRgb(80, 60, 255), color: combineRgb(255, 255, 255) },
        options: [
          {
            type: 'dropdown',
            id: 'pattern',
            label: 'Pattern',
            default: 'chase',
            choices: PATTERNS.map(p => ({ id: p.id, label: p.name })),
          },
        ],
        callback: ({ options }) => this.liveState.pattern === options.pattern,
      },

      blackout_active: {
        type: 'boolean',
        name: 'Master blackout active',
        defaultStyle: { bgcolor: combineRgb(200, 0, 0), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.liveState.masterBlackout,
      },

      playing: {
        type: 'boolean',
        name: 'Show is playing',
        defaultStyle: { bgcolor: combineRgb(0, 180, 60), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.liveState.running,
      },

      color_a_active: {
        type: 'boolean',
        name: 'Colour A is selected',
        defaultStyle: { bgcolor: combineRgb(80, 60, 255), color: combineRgb(255, 255, 255) },
        options: [
          {
            type: 'dropdown',
            id: 'color',
            label: 'Colour',
            default: 0,
            choices: COLOR_PRESETS.map((c, i) => ({ id: i, label: c.name })),
          },
        ],
        callback: ({ options }) => this.liveState.colorA === options.color,
      },

      color_b_active: {
        type: 'boolean',
        name: 'Colour B is selected',
        defaultStyle: { bgcolor: combineRgb(255, 60, 120), color: combineRgb(255, 255, 255) },
        options: [
          {
            type: 'dropdown',
            id: 'color',
            label: 'Colour',
            default: 5,
            choices: COLOR_PRESETS.map((c, i) => ({ id: i, label: c.name })),
          },
        ],
        callback: ({ options }) => this.liveState.colorB === options.color,
      },

      fixture_blackout: {
        type: 'boolean',
        name: 'Fixture blackout active',
        defaultStyle: { bgcolor: combineRgb(180, 0, 0), color: combineRgb(255, 255, 255) },
        options: [
          { type: 'number', id: 'fixture', label: 'Fixture (1-4)', default: 1, min: 1, max: 4 },
        ],
        callback: ({ options }) => {
          const fix = this.liveState.fixtures && this.liveState.fixtures[options.fixture - 1];
          return !!(fix && fix.override && fix.override.blackout);
        },
      },

      fixture_override: {
        type: 'boolean',
        name: 'Fixture override active',
        defaultStyle: { bgcolor: combineRgb(255, 100, 0), color: combineRgb(255, 255, 255) },
        options: [
          { type: 'number', id: 'fixture', label: 'Fixture (1-4)', default: 1, min: 1, max: 4 },
        ],
        callback: ({ options }) => {
          const fix = this.liveState.fixtures && this.liveState.fixtures[options.fixture - 1];
          return !!(fix && fix.override && fix.override.enabled);
        },
      },

      energy_override_active: {
        type: 'boolean',
        name: 'Energy override active',
        defaultStyle: { bgcolor: combineRgb(255, 30, 30), color: combineRgb(255, 255, 255) },
        options: [
          {
            type: 'dropdown',
            id: 'effect',
            label: 'Effect (or "any")',
            default: 'any',
            choices: [
              { id: 'any', label: 'Any energy effect' },
              ...ENERGY_EFFECTS.map(e => ({ id: e.id, label: e.name })),
            ],
          },
        ],
        callback: ({ options }) => {
          if (options.effect === 'any') return !!this.liveState.energyOverride;
          return this.liveState.energyOverride === options.effect;
        },
      },

    });
  }

  // ── Presets ────────────────────────────────────────────────────────────────

  _initPresets() {
    const presets = [];

    // ── Pattern buttons ──
    PATTERNS.forEach(p => {
      presets.push({
        type: 'button',
        category: 'Patterns',
        name: p.name,
        style: {
          text:     p.name,
          size:     '18',
          color:    combineRgb(220, 220, 255),
          bgcolor:  combineRgb(20, 20, 40),
        },
        feedbacks: [
          { feedbackId: 'pattern_active', options: { pattern: p.id },
            style: { bgcolor: combineRgb(80, 60, 255), color: combineRgb(255,255,255) } },
        ],
        steps: [{ down: [{ actionId: 'set_pattern', options: { pattern: p.id } }], up: [] }],
      });
    });

    // ── Colour A buttons ──
    COLOR_PRESETS.forEach((c, i) => {
      const bg = presetColor(c);
      presets.push({
        type: 'button',
        category: 'Colour A',
        name: c.name,
        style: {
          text:    c.name,
          size:    '14',
          color:   combineRgb(255, 255, 255),
          bgcolor: bg,
        },
        feedbacks: [
          { feedbackId: 'color_a_active', options: { color: i },
            style: { bgcolor: bg, color: combineRgb(0, 0, 0), text: `A\n${c.name}` } },
        ],
        steps: [{ down: [{ actionId: 'set_color_a', options: { color: i } }], up: [] }],
      });
    });

    // ── Colour B buttons ──
    COLOR_PRESETS.forEach((c, i) => {
      const bg = presetColor(c);
      presets.push({
        type: 'button',
        category: 'Colour B',
        name: c.name,
        style: {
          text:    c.name,
          size:    '14',
          color:   combineRgb(255, 255, 255),
          bgcolor: bg,
        },
        feedbacks: [
          { feedbackId: 'color_b_active', options: { color: i },
            style: { bgcolor: bg, color: combineRgb(0, 0, 0), text: `B\n${c.name}` } },
        ],
        steps: [{ down: [{ actionId: 'set_color_b', options: { color: i } }], up: [] }],
      });
    });

    // ── Transport ──
    presets.push({
      type: 'button',
      category: 'Transport',
      name: 'Play / Stop',
      style: { text: 'PLAY\nSTOP', size: '18', color: combineRgb(220, 220, 220), bgcolor: combineRgb(0, 50, 0) },
      feedbacks: [
        { feedbackId: 'playing', options: {},
          style: { bgcolor: combineRgb(0, 180, 60), color: combineRgb(255,255,255), text: '▶ PLAY' } },
      ],
      steps: [{ down: [{ actionId: 'play_stop', options: { mode: 'toggle' } }], up: [] }],
    });

    presets.push({
      type: 'button',
      category: 'Transport',
      name: 'Master Blackout',
      style: { text: 'BLACK\nOUT', size: '18', color: combineRgb(255, 80, 80), bgcolor: combineRgb(40, 0, 0) },
      feedbacks: [
        { feedbackId: 'blackout_active', options: {},
          style: { bgcolor: combineRgb(220, 0, 0), color: combineRgb(255,255,255) } },
      ],
      steps: [{ down: [{ actionId: 'master_blackout', options: { mode: 'toggle' } }], up: [] }],
    });

    presets.push({
      type: 'button',
      category: 'Transport',
      name: 'Tap Tempo',
      style: { text: 'TAP\nTEMPO', size: '18', color: combineRgb(200, 200, 255), bgcolor: combineRgb(30, 30, 80) },
      feedbacks: [],
      steps: [{ down: [{ actionId: 'tap_tempo', options: {} }], up: [] }],
    });

    presets.push({
      type: 'button',
      category: 'Transport',
      name: 'BPM +5',
      style: { text: 'BPM +5', size: '18', color: combineRgb(200, 200, 200), bgcolor: combineRgb(20, 20, 40) },
      feedbacks: [],
      steps: [{ down: [{ actionId: 'adjust_bpm', options: { delta: 5 } }], up: [] }],
    });

    presets.push({
      type: 'button',
      category: 'Transport',
      name: 'BPM -5',
      style: { text: 'BPM -5', size: '18', color: combineRgb(200, 200, 200), bgcolor: combineRgb(20, 20, 40) },
      feedbacks: [],
      steps: [{ down: [{ actionId: 'adjust_bpm', options: { delta: -5 } }], up: [] }],
    });

    // Beat divisions
    [{ div: 1, label: '1/1' }, { div: 2, label: '1/2' }, { div: 4, label: '1/4' }, { div: 8, label: '1/8' }]
      .forEach(({ div, label }) => {
        presets.push({
          type: 'button',
          category: 'Transport',
          name: `Beat ${label}`,
          style: { text: `BEAT\n${label}`, size: '18', color: combineRgb(200, 200, 255), bgcolor: combineRgb(20, 20, 60) },
          feedbacks: [],
          steps: [{ down: [{ actionId: 'beat_division', options: { div } }], up: [] }],
        });
      });

    // ── Per-fixture blackout ──
    for (let i = 1; i <= 4; i++) {
      presets.push({
        type: 'button',
        category: 'Fixtures',
        name: `PAR ${i} Blackout`,
        style: { text: `PAR ${i}\nBLACK`, size: '14', color: combineRgb(255, 80, 80), bgcolor: combineRgb(30, 0, 0) },
        feedbacks: [
          { feedbackId: 'fixture_blackout', options: { fixture: i },
            style: { bgcolor: combineRgb(200, 0, 0), color: combineRgb(255,255,255) } },
        ],
        steps: [{ down: [{ actionId: 'fixture_blackout', options: { fixture: i, mode: 'toggle' } }], up: [] }],
      });
    }

    presets.push({
      type: 'button',
      category: 'Fixtures',
      name: 'Clear All Overrides',
      style: { text: 'CLEAR\nOVERRIDE', size: '14', color: combineRgb(200, 200, 200), bgcolor: combineRgb(20, 20, 20) },
      feedbacks: [],
      steps: [{ down: [{ actionId: 'fixture_clear', options: { fixture: 'all' } }], up: [] }],
    });

    // ── Energy override buttons (momentary: hold to activate, release to off) ──
    ENERGY_EFFECTS.forEach(e => {
      presets.push({
        type: 'button',
        category: 'Energy',
        name: e.name,
        style: {
          text:     `⚡\n${e.name}`,
          size:     '14',
          color:    combineRgb(255, 200, 200),
          bgcolor:  combineRgb(60, 10, 10),
        },
        feedbacks: [
          { feedbackId: 'energy_override_active', options: { effect: e.id },
            style: { bgcolor: combineRgb(255, 30, 30), color: combineRgb(255, 255, 255) } },
        ],
        steps: [{
          down: [{ actionId: 'energy_override', options: { effect: e.id } }],
          up:   [{ actionId: 'energy_override_off', options: {} }],
        }],
      });
    });

    this.setPresetDefinitions(presets);
  }
}

runEntrypoint(ArtnetLightshowInstance, []);
