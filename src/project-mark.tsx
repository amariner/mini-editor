import React from 'react';
// Stable pseudo-random identity: renaming or reopening a project never changes its mark.
const colors = [
  '#8c9ed1',
  '#b79bbd',
  '#89b1a3',
  '#c6a17e',
  '#92afc1',
  '#b6ae7f',
  '#be9397',
  '#a6a0c8',
];
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
      style={{ color: colors[(n >>> 8) % colors.length] }}
    >
      <svg viewBox="0 0 24 24" fill="currentColor">
        {shapes[n % shapes.length]}
      </svg>
    </span>
  );
}
/** Agent Desk's own mark: four of the project shapes on a 2×2 grid. */
export function DeskMark({ size = 48 }: { size?: number }) {
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
        >
          {shapes[shape]}
        </g>
      ))}
    </svg>
  );
}
