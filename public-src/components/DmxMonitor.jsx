import { useEffect, useMemo, useRef } from 'preact/hooks';
import { stateSig, dmxSig, dmxShapeSig } from '../state.js';
import { useDmxFeed } from '../use-dmx.js';
import { channelPlace, stripOf, isInternalUniverse } from '../../src/shared/placement.ts';

/**
 * A profile's channels, for labelling: its channel list, or — for one that has
 * none, like a WLED's — each cell's colours, which say the same.
 */
function channelsOf(profile) {
  if (Array.isArray(profile.channelList) && profile.channelList.length) return profile.channelList;
  const out = [];
  (profile.cells || []).forEach((cell, c) => {
    for (const [attribute, offset] of Object.entries(cell.channelMap || {})) out.push({ offset, attribute, cell: c });
  });
  for (const [attribute, offset] of Object.entries(profile.channelMap || {})) out.push({ offset, attribute });
  return out;
}

function buildChannelLabels(s, universe) {
  const labels = {};
  if (!s.fixtures || !s.profiles) return labels;
  for (const fix of s.fixtures) {
    const profile = s.profiles[fix.profileId];
    if (!profile) continue;
    // A strip longer than a universe runs on into the next ones: each channel
    // is labelled on the universe it is on.
    const strip = stripOf(profile);
    const home = fix.universe ?? 0;
    if (!strip && home !== universe) continue;
    for (const ch of channelsOf(profile)) {
      const place = channelPlace(strip, fix.address, ch.offset);
      if (home + place.universe !== universe) continue;
      // A bar's cell channels read as their colour and cell: R12 is cell
      // twelve's red.
      const shortName = ch.cell !== undefined
        ? `${(ch.attribute || '?')[0].toUpperCase()}${ch.cell + 1}`
        : (ch.attribute || ch.name || '').substring(0, 3).toUpperCase();
      labels[place.index] = shortName || String(ch.offset + 1);
    }
  }
  return labels;
}

/**
 * One universe's 512 channels.
 *
 * The cells are rendered once, from the patch, and the 10 Hz value stream is
 * then written straight into them. Rendering the values instead made Preact
 * diff 512 nodes per universe ten times a second in order to change two text
 * nodes and a custom property in each — and rebuilt every channel label along
 * with them, because buildChannelLabels ran on every one of those renders.
 */
function UniverseGrid({ s, universe, count }) {
  const labels = useMemo(() => buildChannelLabels(s, universe), [s, universe]);
  const gridRef = useRef(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    // Last painted value per cell. Most channels hold still between frames, so
    // this skips nearly all of the writes rather than touching style and text
    // on every channel every frame.
    const painted = new Array(count).fill(-1);

    const paint = (snap) => {
      const values = (snap && snap[universe]) || [];
      const cells = grid.children;
      for (let i = 0; i < cells.length; i++) {
        const v = values[i] || 0;
        if (painted[i] === v) continue;
        painted[i] = v;
        const cell = cells[i];
        cell.style.setProperty('--bar', `${(v / 255) * 100}%`);
        cell.classList.toggle('active', v > 0);
        cell.lastElementChild.textContent = v;
      }
    };

    return dmxSig.subscribe(paint);
  }, [universe, count]);

  return (
    <div class="dmx-universe">
      <div class="dmx-universe-label">{isInternalUniverse(universe)
        ? 'Hue lamps — no DMX address, never sent' : `Universe ${universe}`}</div>
      {count === 0
        ? <div class="dmx-universe-empty">No fixtures patched — sending an empty frame.</div>
        : (
          <div class="dmx-monitor" ref={gridRef}>
            {Array.from({ length: count }, (_, i) => (
              <div key={i} class="dmx-cell" style={{ '--bar': '0%' }}>
                <span class="ch">{i + 1} {labels[i] || String((i % 12) + 1)}</span>
                <span class="val">0</span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

export function DmxMonitor() {
  // Open, the monitor keeps the DMX feed coming; closed, nothing asks for it.
  useDmxFeed();
  const s = stateSig.value;
  // The shape, not the values — see dmxShapeSig. "0:512,1:512".
  const shape = dmxShapeSig.value;
  const universes = shape
    ? shape.split(',').map((part) => {
      const [universe, count] = part.split(':').map(Number);
      return { universe, count };
    })
    : [];

  return (
    <div class="card">
      <div class="card-title">DMX Monitor</div>
      {universes.map(({ universe, count }) => (
        <UniverseGrid key={universe} s={s} universe={universe} count={count} />
      ))}
    </div>
  );
}
