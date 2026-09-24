import { useEffect, useRef, useState } from 'preact/hooks';
import { useFocusTrap } from '../focus-trap.js';

/**
 * Every keyboard shortcut the surface has, in one place.
 *
 * They existed and worked; two of them were hinted in `title` attributes and
 * the rest were not written down anywhere, which for a surface meant to be
 * driven in a dark room during a set is the same as not having them. This table
 * is the list the overlay renders, so a shortcut added here is documented by
 * construction.
 *
 * `keys` is a chord — Shift and Enter held together — unless `either` is set,
 * in which case they are alternatives. Joining four arrow keys with "+" read as
 * an instruction to press all four at once.
 */
export const SHORTCUTS = [
  {
    group: 'Transport',
    items: [
      { keys: ['Space'], what: 'Tap tempo — tap along to set the BPM (also after clicking a button)' },
      { keys: ['1'], what: 'Manual view' },
      { keys: ['2'], what: 'Auto Show view' },
      { keys: ['3'], what: 'Perform view' },
      { keys: ['4', '5', '6', '7'], either: true, what: 'Rig, Sources, Settings, Preflight view' },
      { keys: ['←', '→'], either: true, what: 'Next or previous view, on the view tabs' },
    ],
  },
  {
    group: 'Colours',
    items: [
      { keys: ['←', '→', '↑', '↓'], either: true, what: 'Move within the swatch grid' },
      { keys: ['Enter'], what: 'Write the swatch into the active slot' },
      { keys: ['Shift', 'Enter'], what: 'Write into the paired slot (A↔B, C↔D)' },
      { keys: ['Shift', 'Click'], what: 'Write into the paired slot' },
      { keys: ['Right-click'], what: 'Write into the paired slot' },
      { keys: ['Home', 'End'], either: true, what: 'First / last swatch' },
    ],
  },
  {
    group: 'Energy effects',
    items: [
      { keys: ['Space'], what: 'Hold an energy button reached with Tab — releases when you let go' },
      { keys: ['Enter'], what: 'Hold a focused energy button' },
    ],
  },
  {
    group: 'Stage preview',
    items: [
      { keys: ['←', '→', '↑', '↓'], either: true, what: 'Nudge the focused fixture while positioning' },
      { keys: ['Shift', '←'], what: 'Nudge further (10% instead of 2%)' },
    ],
  },
  {
    group: 'This panel',
    items: [
      { keys: ['?'], what: 'Show or hide this list' },
      { keys: ['Esc'], what: 'Close' },
    ],
  },
];

/** True when a keystroke belongs to whatever the operator is typing into. */
function isTyping(target) {
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}

export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  useFocusTrap(panelRef, open, () => setOpen(false));

  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Escape' && open) { setOpen(false); return; }
      if (isTyping(e.target)) return;
      // `?` is Shift+/ on most layouts and its own key on some, so the printed
      // character is what to test rather than a code.
      if (e.key === '?') { e.preventDefault(); setOpen((v) => !v); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The opener stays on the page while the dialog is up, so closing it can
  // hand focus back to it.
  const opener = (
    <button
      type="button"
      class="shortcuts-tab"
      aria-label="Keyboard shortcuts"
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Keyboard shortcuts (?)"
      onClick={() => setOpen(true)}
    >?</button>
  );
  if (!open) return opener;

  return (
    <>
      {opener}
      <div class="shortcuts-veil" onClick={() => setOpen(false)}>
        <div
          ref={panelRef}
          tabIndex={-1}
          class="shortcuts-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="shortcuts-head">
            <h2>Keyboard shortcuts</h2>
            <button type="button" class="btn sm" onClick={() => setOpen(false)}>Close</button>
          </div>
          <div class="shortcuts-groups">
            {SHORTCUTS.map((group) => (
              <section key={group.group}>
                <h3>{group.group}</h3>
                <dl>
                  {group.items.map((item) => (
                    <div key={item.what} class="shortcuts-row">
                      <dt>
                        {item.keys.map((key, i) => (
                          <span key={key}>
                            {i > 0 && <span class="shortcuts-plus">{item.either ? '/' : '+'}</span>}
                            <kbd>{key}</kbd>
                          </span>
                        ))}
                      </dt>
                      <dd>{item.what}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
