import React, { useEffect, useRef, useState } from 'react';
export function EditableName({
  value,
  label,
  save,
  close,
}: {
  value: string;
  label: string;
  save: (value: string) => void;
  close: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (cancel = false) => {
    if (done.current) return;
    done.current = true;
    const name = draft.trim();
    if (!cancel && name && name !== value) save(name);
    close();
  };
  return (
    <input
      ref={input}
      className="inline-name"
      aria-label={label}
      value={draft}
      maxLength={80}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(true);
        }
      }}
    />
  );
}
