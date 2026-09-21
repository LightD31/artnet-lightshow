import { useState } from 'preact/hooks';
import { stateSig } from '../state.js';
import { Strobe } from './Strobe.jsx';
import { DmxMonitor } from './DmxMonitor.jsx';
import { Prolink } from './Prolink.jsx';

const TABS = [
  { id: 'dmx',     label: 'DMX Monitor' },
  { id: 'strobe',  label: 'Strobe',  showWhen: (s) => s.pattern === 'strobe' },
  { id: 'prolink', label: 'PRO DJ LINK' },
];

export function BottomDrawer() {
  const s = stateSig.value;
  const [open, setOpen]   = useState(false);
  const [tab, setTab]     = useState('dmx');

  const visibleTabs = TABS.filter((t) => !t.showWhen || t.showWhen(s));

  return (
    <div class={`bottom-drawer ${open ? 'open' : ''}`}>
      {/* The strip stays clickable as a convenience, but it is no longer the
          only way to work the drawer: the toggle below is a real button with
          its own handler, so the control is reachable and announced rather
          than being an unlabelled div that happened to respond to clicks. */}
      <div class="bd-handle" onClick={() => setOpen((v) => !v)}>
        <div class="bd-tabs" role="group" aria-label="Drawer panels">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id && open}
              class={`bd-tab ${tab === t.id && open ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setTab(t.id); setOpen(true); }}
            >{t.label}</button>
          ))}
        </div>
        <button
          type="button"
          class="bd-toggle"
          aria-expanded={open}
          aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
          title={open ? 'Collapse' : 'Expand'}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          <span aria-hidden="true">{open ? '▾' : '▴'}</span>
        </button>
      </div>
      {open && (
        <div class="bd-body">
          {tab === 'dmx'     && <DmxMonitor />}
          {tab === 'strobe'  && <Strobe />}
          {tab === 'prolink' && <Prolink />}
        </div>
      )}
    </div>
  );
}
