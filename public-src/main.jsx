import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { stateSig } from './state.js';

import { Header } from './components/Header.jsx';
import { CommandBar } from './components/CommandBar.jsx';
import { Colors } from './components/Colors.jsx';
import { AutoMode } from './components/AutoMode.jsx';
import { Patterns } from './components/Patterns.jsx';
import { Fixtures } from './components/Fixtures.jsx';
import { BottomDrawer } from './components/BottomDrawer.jsx';

function ModeTabs({ mode, setMode, autoActive }) {
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
        <span class="mode-tab-hint">{autoActive ? 'Running' : 'Spotify · PRO DJ LINK'}</span>
        {autoActive && <span class="mode-tab-dot" />}
      </button>
    </div>
  );
}

function ManualView() {
  return (
    <div class="manual-view">
      <div class="manual-col col-patterns"><Patterns /></div>
      <div class="manual-col col-colors"><Colors /></div>
      <div class="manual-col col-fixtures"><Fixtures /></div>
    </div>
  );
}

function AutoView() {
  return (
    <div class="auto-view">
      <AutoMode />
    </div>
  );
}

function Root() {
  // Touch the signal so the whole tree re-renders on every state push.
  void stateSig.value;

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

  const s = stateSig.value;
  const autoActive = s.autoShow && s.autoShow.status && s.autoShow.status !== 'idle';

  return (
    <>
      <Header />
      <CommandBar />
      <ModeTabs mode={mode} setMode={setMode} autoActive={autoActive} />
      <main class={`mode-${mode}`}>
        {mode === 'manual' ? <ManualView /> : <AutoView />}
      </main>
      <BottomDrawer />
    </>
  );
}

render(<Root />, document.getElementById('app'));
