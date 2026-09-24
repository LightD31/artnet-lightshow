import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { field } from './state.js';
import { setUpDevice } from './device.js';

import { Header } from './components/Header.jsx';
import { CommandBar } from './components/CommandBar.jsx';
import { Colors } from './components/Colors.jsx';
import { AutoMode } from './components/AutoMode.jsx';
import { Warm } from './components/Warm.jsx';
import { Patterns } from './components/Patterns.jsx';
import { Cues } from './components/Cues.jsx';
import { Fixtures } from './components/Fixtures.jsx';
import { StagePreview } from './components/StagePreview.jsx';
import { BottomDrawer } from './components/BottomDrawer.jsx';
import { ConnectionVeil } from './components/ConnectionVeil.jsx';
import { ShortcutsOverlay } from './components/Shortcuts.jsx';
import { Perform } from './components/Perform.jsx';
import { RigView } from './components/setup/RigView.jsx';
import { SourcesView } from './components/setup/SourcesView.jsx';
import { SettingsView } from './components/setup/SettingsView.jsx';
import { PreflightView } from './components/setup/PreflightView.jsx';
import { Wizard, useFirstRun } from './components/setup/Wizard.jsx';

// The views, in the order the tabs show them: the three for running a show,
// then the four for setting one up. The keys are the digit that jumps to
// each, and the hash that opens the page on it — a tablet at front of house
// bookmarks /#perform; /#rig/outputs opens the Rig view on its outputs.
const VIEWS = [
  { id: 'manual', key: '1', icon: '◧', label: 'Manual', hint: 'Patterns · Colours · Fixtures', group: 'live' },
  { id: 'auto', key: '2', icon: '✦', label: 'Auto Show', hint: 'Spotify · Now Playing · PRO DJ LINK', group: 'live' },
  { id: 'perform', key: '3', icon: '◉', label: 'Perform', hint: 'Pads · Palettes · Faders', group: 'live' },
  { id: 'rig', key: '4', icon: '▦', label: 'Rig', hint: 'Plan · Patch · Outputs', group: 'setup' },
  { id: 'sources', key: '5', icon: '♫', label: 'Sources', hint: 'Players · Spotify · Live input', group: 'setup' },
  { id: 'settings', key: '6', icon: '⚙', label: 'Settings', hint: 'Show · MIDI · Server', group: 'setup' },
  { id: 'preflight', key: '7', icon: '✓', label: 'Preflight', hint: 'Pre-show check', group: 'setup' },
];
const VIEW_IDS = VIEWS.map((v) => v.id);

/** The view a hash names: its first part, so /#rig/outputs is the Rig view. */
const viewOfHash = () => window.location.hash.replace('#', '').split('/')[0];

function initialView() {
  const hash = viewOfHash();
  if (VIEW_IDS.includes(hash)) return hash;
  try {
    const saved = localStorage.getItem('lightshow.mode');
    return VIEW_IDS.includes(saved) ? saved : 'manual';
  } catch {
    return 'manual';
  }
}

function ModeTabs({ mode, setMode }) {
  // Subscribes here rather than in Root, so an auto-show status change re-renders
  // this tab strip alone instead of the whole tree.
  const autoShow = field('autoShow').value;
  const autoActive = !!(autoShow && autoShow.status && autoShow.status !== 'idle');

  // A tab strip is one stop in the tab order: the arrow keys, Home and End
  // move between its tabs (the ARIA tabs pattern).
  const onKeyDown = (e) => {
    const at = VIEW_IDS.indexOf(mode);
    const to = e.key === 'ArrowRight' ? (at + 1) % VIEWS.length
      : e.key === 'ArrowLeft' ? (at - 1 + VIEWS.length) % VIEWS.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? VIEWS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setMode(VIEW_IDS[to]);
    document.getElementById(`tab-${VIEW_IDS[to]}`)?.focus();
  };

  return (
    <div class={`mode-tabs in-${mode}`} role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
      {VIEWS.map((v, i) => [
        i > 0 && VIEWS[i - 1].group !== v.group && <span key={`sep-${v.id}`} class="mode-tab-sep" role="presentation" />,
        <button
          key={v.id}
          id={`tab-${v.id}`}
          role="tab"
          type="button"
          aria-selected={mode === v.id}
          aria-controls={`panel-${v.id}`}
          tabIndex={mode === v.id ? 0 : -1}
          class={`mode-tab ${mode === v.id ? 'active' : ''}`}
          onClick={() => setMode(v.id)}
        >
          <span class="mode-tab-icon" aria-hidden="true">{v.icon}</span>
          <span class="mode-tab-label">{v.label}</span>
          <span class="mode-tab-hint">{v.id === 'auto' && autoActive ? 'Running' : v.hint}</span>
          {v.id === 'auto' && autoActive && <span class="mode-tab-dot" aria-hidden="true" />}
          <kbd class="mode-tab-key" aria-hidden="true">{v.key}</kbd>
        </button>,
      ])}
    </div>
  );
}

function ManualView() {
  return (
    <div class="manual-view">
      <div class="manual-col col-patterns"><Cues /><Patterns /></div>
      <div class="manual-col col-colors"><Colors /></div>
      <div class="manual-col col-fixtures"><StagePreview /><Fixtures /></div>
    </div>
  );
}

function AutoView() {
  return (
    <div class="auto-view">
      <AutoMode />
      <Warm />
    </div>
  );
}

const PANELS = {
  manual: ManualView,
  auto: AutoView,
  perform: Perform,
  rig: RigView,
  sources: SourcesView,
  settings: SettingsView,
  preflight: PreflightView,
};

function Root() {
  // Deliberately reads no signals. Subscribing the root made every component in
  // the tree re-render on every push; each component now subscribes to what it
  // actually needs.
  const [mode, setMode] = useState(initialView);
  const Panel = PANELS[mode];
  useFirstRun();

  useEffect(() => {
    try { localStorage.setItem('lightshow.mode', mode); } catch { /* private mode */ }
    // A view with tabs of its own keeps its part of the hash (/#rig/outputs).
    if (viewOfHash() !== mode) window.history.replaceState(null, '', `#${mode}`);
  }, [mode]);

  useEffect(() => {
    const onHash = () => {
      const hash = viewOfHash();
      if (VIEW_IDS.includes(hash)) setMode(hash);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Keyboard shortcuts: 1 → Manual, 2 → Auto, 3 → Perform, 4–7 → the setup views
  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
      const view = VIEWS.find((v) => v.key === e.key);
      if (view) setMode(view.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {/* Focuses the view without touching the hash, which names the view. */}
      <a class="skip-link" href="#main" onClick={(e) => {
        e.preventDefault();
        document.getElementById(`panel-${mode}`)?.focus();
      }}>Skip to the controls</a>
      <Header />
      {mode !== 'perform' && <CommandBar />}
      <nav class="mode-nav" aria-label="Views">
        <ModeTabs mode={mode} setMode={setMode} />
      </nav>
      <main id="main" class={`mode-${mode}`}>
        <div id={`panel-${mode}`} class="view-panel" role="tabpanel" aria-labelledby={`tab-${mode}`} tabIndex={-1}>
          <Panel />
        </div>
      </main>
      <footer class="app-footer">
        {mode !== 'perform' && <BottomDrawer />}
        <ShortcutsOverlay />
      </footer>
      <Wizard />
      <ConnectionVeil />
    </>
  );
}

setUpDevice();
render(<Root />, document.getElementById('app'));
