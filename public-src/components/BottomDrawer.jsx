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
      <div class="bd-handle" onClick={() => setOpen((v) => !v)}>
        <div class="bd-tabs">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              class={`bd-tab ${tab === t.id && open ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setTab(t.id); setOpen(true); }}
            >{t.label}</button>
          ))}
        </div>
        <button class="bd-toggle" title={open ? 'Collapse' : 'Expand'}>
          <span>{open ? '▾' : '▴'}</span>
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
