import React from 'react';
// Stable pseudo-random identity: renaming or reopening a project never changes its mark.
// The eight colours are theme tokens (--mark-1 … --mark-8).
const MARK_COLORS = 8;
const shapes = [
  <circle cx="12" cy="12" r="8" />,
  <path d="M12 2 22 12 12 22 2 12Z" />,
  <path d="M12 3 22 21H2Z" />,
  <rect x="4" y="4" width="16" height="16" rx="4" />,
  <path d="m12 2 9 5v10l-9 5-9-5V7Z" />,
  <path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7Z" />,
  <path d="M12 2C25 5 21 22 12 22S-1 5 12 2Z" />,
  <path d="m12 1 3 7 8 4-8 3-3 8-4-8-7-3 7-4Z" />,
];
export function ProjectMark({ identity }: { identity: string }) {
  let hash = 2166136261;
  for (const char of identity) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const n = hash >>> 0;
  return (
    <span
      className="project-mark"
      aria-hidden="true"
      style={{ color: `var(--mark-${((n >>> 8) % MARK_COLORS) + 1})` }}
    >
      <svg viewBox="0 0 24 24" fill="currentColor">
        {shapes[n % shapes.length]}
      </svg>
    </span>
  );
}
/** Agent Desk's own mark: four of the project shapes on a 2×2 grid. */
/** `colored` paints each shape with its project-mark token, like the app icon. */
export function DeskMark({ size = 48, colored = false }: { size?: number; colored?: boolean }) {
  return (
    <svg
      className="desk-mark"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="currentColor"
      aria-hidden="true"
    >
      {[0, 1, 2, 3].map((shape, i) => (
        <g
          key={shape}
          transform={`translate(${(i % 2) * 25 + 1.5} ${Math.floor(i / 2) * 25 + 1.5}) scale(0.875)`}
          style={colored ? { fill: `var(--mark-${i + 1})` } : undefined}
        >
          {shapes[shape]}
        </g>
      ))}
    </svg>
  );
}
