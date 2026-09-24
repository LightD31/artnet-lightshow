import { useEffect, useRef } from 'preact/hooks';
import { stateSig, autoPositionSig, send, api } from '../state.js';
import { fmtTime } from '../utils.js';
import { AnalysisStats } from './AnalysisStats.jsx';
import { AutoTimeline } from './AutoTimeline.jsx';
import { Queue } from './Queue.jsx';
import { StagePreview } from './StagePreview.jsx';

/**
 * The auto-show surface.
 *
 * Everything here is one of three things, and the layout says which: what the
 * show is doing (transport), how it should look (palette and intensity), and
 * what it knows (now playing, the queue, the analysis). The controls used to be
 * a single wrapping row of seven differently-shaped widgets, with a redundant
 * second transport button and three stacked source rows that were mostly about
 * sources you were not using.
 */

// Where the current track sits in the night (src/show/set-memory.ts).
const ARC_TEXT = {
  'warm-up': 'warming up',
  peak: 'a peak: the big moments are spent here',
  breather: 'a breather after the tracks before',
  level: 'holding the level of the night',
};

const STATUS_TEXT = {
  idle: 'Idle',
  downloading: 'Downloading audio',
  analyzing: 'Analysing audio',
  ready: 'Ready to start',
  playing: 'Running',
};

const SOURCES = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'prolink', label: 'PRO DJ LINK' },
  { value: 'hybrid', label: 'Spotify + OS clock' },
  { value: 'spotify', label: 'Spotify' },
  { value: 'deezer', label: 'Deezer (extension)' },
  { value: 'nowplaying', label: 'Now playing (OS)' },
  { value: 'live', label: 'Live input (by ear)' },
  { value: 'timer', label: 'Standalone timer' },
];

// Milliseconds per press of the sync nudge buttons, and the slider's step.
// Mirrors SYNC_NUDGE_MS in src/midi.js so a click here and an encoder detent
// there move by the same amount. One millisecond would be unusable — nobody can
// hear one — and a whole beat would overshoot the error every time.
const SYNC_NUDGE_MS = 5;

const PALETTE_SIZES = [
  { size: 'auto', label: 'Auto', hint: 'Sized per song: one colour per distinct passage, as far as the music supports' },
  { size: 2, label: '2', hint: 'Two contrasting colours — reads cleanly on a small rig' },
  { size: 3, label: '3', hint: 'Three well-separated hues' },
  { size: 4, label: '4', hint: 'The full hand-tuned tetrad' },
];

/** One dot per playback source, so the strip says what is live at a glance. */
function SourceDots({ s }) {
  const sp = s.spotify || {};
  const dz = s.deezer || {};
  const np = s.nowPlaying || {};
  const pl = s.prolink || {};

  const sources = [
    { id: 'prolink', label: 'PRO DJ LINK', live: !!pl.connected, detail: pl.track ? `${pl.track.artist || ''} — ${pl.track.title || ''}` : 'No CDJ' },
    { id: 'spotify', label: 'Spotify', live: !!sp.authenticated, detail: sp.authenticated ? 'Connected' : sp.configured ? 'Not connected' : 'Not configured' },
    { id: 'deezer', label: 'Deezer', live: !!dz.authenticated, detail: dz.authenticated ? `${dz.artist || ''} — ${dz.name || ''}` : 'Extension not connected' },
    { id: 'os', label: 'OS media', live: !!np.authenticated, detail: np.authenticated ? `${np.artist || ''} — ${np.name || ''}` : 'Nothing detected' },
    { id: 'live', label: 'Live input', live: !!(s.live && s.live.listening), detail: s.live && s.live.listening ? (s.live.bpm ? `Hearing ${s.live.bpm.toFixed(1)} BPM` : 'Listening') : 'Off' },
  ];

  // Only while hybrid is the source actually driving: everywhere else the
  // clock question has one obvious answer and a chip about it is noise.
  const hy = s.hybrid || {};
  const hybridActive = s.activeSource === 'hybrid';
  const clockChip = hybridActive ? {
    id: 'clock',
    label: hy.driver === 'nowplaying' ? 'Clock: OS' : 'Clock: Spotify',
    live: hy.driver === 'nowplaying',
    detail: hy.driver === 'nowplaying'
      ? `Position from the OS media session${hy.sessionApp ? ` (${hy.sessionApp})` : ''}`
        + `; drift ${Math.round((hy.clock && hy.clock.driftMs) || 0)} ms`
      : 'The OS session is not reporting the Spotify track — falling back to '
        + "Spotify's own position",
  } : null;

  return (
    <div class="source-strip">
      {sources.map((src) => (
        <span key={src.id} class={`source-chip ${src.live ? 'live' : ''}`} title={src.detail}>
          <span class="source-dot" />
          {src.label}
        </span>
      ))}
      {clockChip && (
        <span class={`source-chip ${clockChip.live ? 'live' : ''}`} title={clockChip.detail}>
          <span class="source-dot" />
          {clockChip.label}
        </span>
      )}
      {sp.authenticated ? (
        <button
          class="btn sm source-action"
          onClick={() => api('/api/spotify/disconnect', { method: 'POST' })}
        >Disconnect Spotify</button>
      ) : sp.configured ? (
        <button
          class="btn sm source-action"
          onClick={() => window.open('/auth/spotify', '_blank', 'width=500,height=700')}
        >Connect Spotify</button>
      ) : null}
    </div>
  );
}

/** Now playing, with where we are in the track. */
function NowPlaying({ track }) {
  const pos = autoPositionSig.value;
  const duration = track.durationMs || 0;
  const pct = duration > 0 ? Math.max(0, Math.min(100, (pos.positionMs / duration) * 100)) : 0;

  return (
    <section class="panel now-panel">
      {track.albumArt && <img class="now-art" src={track.albumArt} alt="" />}
      <div class="now-body">
        <div class="now-name" title={track.name}>{track.name}</div>
        <div class="now-artist" title={track.artist}>{track.artist}</div>
        {duration > 0 && (
          <div class="now-progress">
            <div class="now-bar"><div class="now-bar-fill" style={{ width: `${pct}%` }} /></div>
            <span class="now-time">{fmtTime(pos.positionMs)} / {fmtTime(duration)}</span>
          </div>
        )}
      </div>
    </section>
  );
}

export function AutoMode() {
  const s = stateSig.value;
  const sp = s.spotify;
  const as = s.autoShow;

  const pendingStartRef = useRef(false);
  useEffect(() => {
    if (pendingStartRef.current && as && as.status === 'ready') {
      pendingStartRef.current = false;
      api('/api/auto/start', { method: 'POST' });
    }
  }, [as && as.status]);

  if (!sp || !as) return null;

  const status = as.status || 'idle';
  // Playing by ear runs the show with no timeline, and so no busy badge.
  const byEar = !!(s.showOn && s.live && s.live.director && s.live.director.active && status !== 'playing');
  const busy = !byEar && (status === 'downloading' || status === 'analyzing');
  const running = status === 'playing' || byEar;

  const analyzeAndStart = () => {
    if (running) return;
    if (status === 'ready') { api('/api/auto/start', { method: 'POST' }); return; }

    const requestedSource = s.autoSource || 'auto';
    // The server is authoritative about source priority. In auto mode it may
    // choose PRO DJ LINK over Spotify (or Deezer over generic OS media), so
    // deciding from credentials here can analyse one track and then run the
    // timeline against another clock. Explicit choices still use their own
    // endpoint so an unavailable source produces its useful error message.
    const source = requestedSource === 'auto' ? (s.activeSource || 'timer') : requestedSource;

    // A failed analyse must clear the pending flag, or the next status change
    // fires a start for a track that never analysed. api() reports the reason.
    const triggerAnalyze = (endpoint) => {
      pendingStartRef.current = true;
      api(endpoint, { method: 'POST' }).then((d) => { if (!d.ok) pendingStartRef.current = false; });
    };

    if (source === 'spotify' || source === 'hybrid') triggerAnalyze('/api/auto/analyze-spotify');
    else if (source === 'deezer') triggerAnalyze('/api/auto/analyze-deezer');
    else if (source === 'nowplaying') triggerAnalyze('/api/auto/analyze-nowplaying');
    else if (source === 'prolink') triggerAnalyze('/api/auto/analyze-prolink');
    else api('/api/auto/start', { method: 'POST' });
  };

  const stop = () => {
    pendingStartRef.current = false;
    api('/api/auto/stop', { method: 'POST' });
  };

  const intensity = as.intensity ?? 50;
  const syncLimit = s.syncOffsetLimitMs ?? 2000;
  const syncOffset = s.autoSyncOffsetMs ?? 0;
  // Signed, because which way it is pointing is the whole question.
  const syncLabel = `${syncOffset > 0 ? '+' : syncOffset < 0 ? '\u2212' : ''}${Math.abs(syncOffset)} ms`;
  const nudgeSync = (by) => send({
    autoSyncOffsetMs: Math.max(-syncLimit, Math.min(syncLimit, syncOffset + by)),
  });

  return (
    <div class="auto-layout">
      {/* One transport bar. Start and stop are the same button in two states —
          two buttons, each disabled half the time, said the same thing twice. */}
      <div class="auto-transport">
        <button
          class={`transport-btn ${running ? 'running' : ''}`}
          disabled={busy}
          onClick={running ? stop : analyzeAndStart}
        >
          <span class="transport-glyph">{busy ? '⟳' : running ? '■' : '▶'}</span>
          <span>{busy ? 'Analysing…' : running ? 'Stop show' : 'Start show'}</span>
        </button>

        {byEar
          ? <span class="auto-badge auto-badge-playing" title="No analysed track to play: answering what the live input hears">By ear</span>
          : <span class={`auto-badge auto-badge-${status}`}>{STATUS_TEXT[status] || status}</span>}

        <span class="transport-spacer" />

        <label class="transport-source">
          <span class="transport-source-label">Follow</span>
          <select
            class="auto-select"
            value={s.autoSource || 'auto'}
            onChange={(e) => send({ autoSource: e.target.value })}
          >
            {SOURCES.map((src) => <option key={src.value} value={src.value}>{src.label}</option>)}
          </select>
        </label>
      </div>

      <div class="auto-columns">
        <div class="auto-col">
          {as.track && <NowPlaying track={as.track} />}

          {/* The two controls that shape the generated show, together. The
              intensity slider used to sit in the transport row as "INT". */}
          <section class="panel look-panel">
            <header class="panel-head"><h3 class="panel-title">Look</h3></header>

            <div class="look-row">
              <span class="look-label" id="palette-label">Palette</span>
              <div class="segmented" role="group" aria-labelledby="palette-label">
                {PALETTE_SIZES.map(({ size, label, hint }) => {
                  // On 'auto' the button shows which size the track actually
                  // resolved to, because that is what the operator is looking
                  // at on the rig.
                  const auto = as.paletteSizeMode === 'auto';
                  const active = size === 'auto' ? auto : (!auto && (as.paletteSize || 4) === size);
                  return (
                    <button
                      key={size}
                      type="button"
                      class={`segmented-btn ${active ? 'active' : ''}`}
                      aria-pressed={active}
                      title={hint}
                      onClick={() => send({ autoPaletteSize: size })}
                    >{size === 'auto' && auto && as.paletteSize ? `Auto · ${as.paletteSize}` : label}</button>
                  );
                })}
              </div>
              <span class="look-hint">colours per song</span>
            </div>

            <div class="look-row">
              <label class="look-label" for="auto-intensity">Intensity</label>
              <input
                id="auto-intensity"
                class="look-slider"
                type="range" min="0" max="100"
                value={intensity}
                aria-valuetext={`${intensity} percent`}
                onInput={(e) => send({ autoIntensity: Number(e.target.value) })}
              />
              <span class="look-value">{intensity}</span>
            </div>
            <p class="look-note">
              How hard the generated show pushes — accent density, drops and strobe bursts.
            </p>
            {as.set && as.set.memory && as.set.tracks > 0 && (
              <p class="look-note" title="Each track avoids the last one's palette and looks, keeps shared colours when the keys mix, and paces its big moments against the night so far.">
                Night so far: {as.set.tracks} {as.set.tracks === 1 ? 'track' : 'tracks'}
                {as.set.arc && ARC_TEXT[as.set.arc] ? ` · ${ARC_TEXT[as.set.arc]}` : ''}
              </p>
            )}

            <div class="look-row">
              <label class="look-label" for="auto-sync">Sync</label>
              <button
                type="button"
                class="sync-nudge"
                title="5 ms later"
                aria-label="Lights 5 milliseconds later"
                onClick={() => nudgeSync(-SYNC_NUDGE_MS)}
              >&minus;</button>
              <input
                id="auto-sync"
                class="look-slider"
                type="range"
                min={-syncLimit} max={syncLimit} step={SYNC_NUDGE_MS}
                value={syncOffset}
                aria-valuetext={syncLabel}
                onInput={(e) => send({ autoSyncOffsetMs: Number(e.target.value) })}
              />
              <button
                type="button"
                class="sync-nudge"
                title="5 ms earlier"
                aria-label="Lights 5 milliseconds earlier"
                onClick={() => nudgeSync(SYNC_NUDGE_MS)}
              >+</button>
              <button
                type="button"
                class="look-value sync-value"
                title="Back to zero"
                aria-label={`Sync offset ${syncLabel}. Reset to zero.`}
                onClick={() => send({ autoSyncOffsetMs: 0 })}
              >{syncLabel}</button>
            </div>
            <p class="look-note">
              Lines the lights up with what the room hears. Raise it when the rig feels
              late — a positive offset runs the show <em>ahead</em> of the reported track
              position, covering player buffering, network and fixture lag. It is saved
              with your settings, since the right value belongs to the rig, not the set.
            </p>
            {s.live && s.live.listening && as.running && (
              <p class="look-note" aria-live="polite">
                {as.autoSyncMs
                  ? <>Heard by the live input: the source runs {Math.abs(as.autoSyncMs)} ms {as.autoSyncMs > 0 ? 'behind' : 'ahead of'} the music, and the show is corrected for it.</>
                  : <>The live input is lining this track up with what it hears.</>}
              </p>
            )}
          </section>

          <Queue />
          <SourceDots s={s} />
        </div>

        <div class="auto-col auto-col-analysis">
          <StagePreview />
          {as.analysis ? (
            <>
              <section class="panel">
                <header class="panel-head"><h3 class="panel-title">Analysis</h3></header>
                <AnalysisStats as={as} colorPresets={s.colorPresets} />
              </section>
              <section class="panel timeline-panel">
                <AutoTimeline />
              </section>
            </>
          ) : (
            <section class="panel">
              <p class="panel-empty">
                No analysis yet. Start a show and the track&rsquo;s tempo, key, genre and
                structure appear here.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
