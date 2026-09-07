import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { stateSig } from './state.js';

import { Header } from './components/Header.jsx';
import { CommandBar } from './components/CommandBar.jsx';
import { Colors } from './components/Colors.jsx';
import { AutoMode } from './components/AutoMode.jsx';
import { Warm } from './components/Warm.jsx';
import { Patterns } from './components/Patterns.jsx';
import { Cues } from './components/Cues.jsx';
import { Fixtures } from './components/Fixtures.jsx';
import { BottomDrawer } from './components/BottomDrawer.jsx';

function ModeTabs({ mode, setMode }) {
  // Subscribes here rather than in Root, so an auto-show status change re-renders
  // this tab strip alone instead of the whole tree.
  const s = stateSig.value;
  const autoActive = !!(s.autoShow && s.autoShow.status && s.autoShow.status !== 'idle');

  return (
    <div class="mode-tabs" role="tablist">
      <button
        role="tab"
        aria-selected={mode === 'manual'}
        class={`mode-tab ${mode === 'manual' ? 'active' : ''}`}
        onClick={() => setMode('manual')}
      >
        <span class="mode-tab-icon">◧</span>
        <span class="mode-tab-label">Manual</span>
        <span class="mode-tab-hint">Patterns · Colours · Fixtures</span>
      </button>
      <button
        role="tab"
        aria-selected={mode === 'auto'}
        class={`mode-tab ${mode === 'auto' ? 'active' : ''}`}
        onClick={() => setMode('auto')}
      >
        <span class="mode-tab-icon">✦</span>
        <span class="mode-tab-label">Auto Show</span>
        <span class="mode-tab-hint">{autoActive ? 'Running' : 'Spotify · Now Playing · PRO DJ LINK'}</span>
        {autoActive && <span class="mode-tab-dot" />}
      </button>
    </div>
  );
}

function ManualView() {
  return (
    <div class="manual-view">
      <div class="manual-col col-patterns"><Cues /><Patterns /></div>
      <div class="manual-col col-colors"><Colors /></div>
      <div class="manual-col col-fixtures"><Fixtures /></div>
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

function Root() {
  // Deliberately reads no signals. Subscribing the root made every component in
  // the tree re-render on every push; each component now subscribes to what it
  // actually needs.
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem('lightshow.mode');
    return saved === 'auto' ? 'auto' : 'manual';
  });

  useEffect(() => { localStorage.setItem('lightshow.mode', mode); }, [mode]);

  // Keyboard shortcuts: 1 → Manual, 2 → Auto
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;
      if (e.key === '1') setMode('manual');
      else if (e.key === '2') setMode('auto');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <Header />
      <CommandBar />
      <ModeTabs mode={mode} setMode={setMode} />
      <main class={`mode-${mode}`}>
        {mode === 'manual' ? <ManualView /> : <AutoView />}
      </main>
      <BottomDrawer />
    </>
  );
}

render(<Root />, document.getElementById('app'));
