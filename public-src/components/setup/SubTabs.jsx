import { useEffect, useState } from 'preact/hooks';

/**
 * A view's own tabs, under the main ones: the ARIA tabs pattern (one stop in
 * the tab order, arrow keys between them), remembered per view, and named in
 * the address after the view's own — /#rig/outputs opens the Rig view on its
 * outputs, which is what the old settings page's links now point at.
 */

function fromHash(view, ids) {
  const [head, sub] = window.location.hash.replace('#', '').split('/');
  return head === view && ids.includes(sub) ? sub : null;
}

export function useSubTab(view, tabs) {
  const ids = tabs.map((t) => t.id);
  const key = `lightshow.${view}.tab`;
  const [tab, setTab] = useState(() => {
    const linked = fromHash(view, ids);
    if (linked) return linked;
    try {
      const saved = localStorage.getItem(key);
      return ids.includes(saved) ? saved : ids[0];
    } catch {
      return ids[0];
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, tab); } catch { /* private mode */ }
    const want = `#${view}/${tab}`;
    if (window.location.hash !== want) window.history.replaceState(null, '', want);
  }, [tab]);
  useEffect(() => {
    const onHash = () => { const linked = fromHash(view, ids); if (linked) setTab(linked); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return [tab, setTab];
}

export function SubTabs({ view, tabs, tab, setTab, label }) {
  const onKeyDown = (e) => {
    const at = tabs.findIndex((t) => t.id === tab);
    const to = e.key === 'ArrowRight' ? (at + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(tabs[to].id);
    document.getElementById(`subtab-${view}-${tabs[to].id}`)?.focus();
  };
  return (
    <div class="sub-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" id={`subtab-${view}-${t.id}`} aria-selected={tab === t.id}
          aria-controls={`subpanel-${view}`} tabIndex={tab === t.id ? 0 : -1}
          class={`sub-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The tab panel a SubTabs strip controls. */
export function SubPanel({ view, tab, children }) {
  return (
    <div id={`subpanel-${view}`} role="tabpanel" aria-labelledby={`subtab-${view}-${tab}`} class="sub-panel">
      {children}
    </div>
  );
}
