import { useRef, useState } from 'preact/hooks';

/**
 * A text or number box over a value the server owns: it shows the server's
 * value until it is focused, keeps what is typed while it is (a live update
 * arriving mid-word does not wipe it), and sends it on Enter or on leaving
 * the box. Escape puts the server's value back.
 */
export function FieldInput({ value, onCommit, type = 'text', ...props }) {
  const [text, setText] = useState(null);
  const cancelled = useRef(false);
  const shown = text ?? (value === undefined || value === null ? '' : String(value));
  const commit = () => {
    if (cancelled.current) { cancelled.current = false; setText(null); return; }
    if (text !== null && text !== String(value ?? '')) {
      onCommit(type === 'number' ? Number(text) : text);
    }
    setText(null);
  };
  return (
    <input {...props} type={type} value={shown}
      onFocus={() => setText(String(value ?? ''))}
      onInput={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
        if (props.onKeyDown) props.onKeyDown(e);
      }} />
  );
}
