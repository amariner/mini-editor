import type { CSSProperties } from 'react';
/** Choose readable card text without changing the saved account background. */
export function accountCardStyle(color?: string): CSSProperties | undefined {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return;
  const linear = [1, 3, 5].map((i) => {
    const n = parseInt(color.slice(i, i + 2), 16) / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const darkInk = (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05);
  const ink = darkInk ? ((luminance + 0.05) / 0.0580232 >= 4.5 ? '#161616' : '#000000') : '#ffffff';
  const mix = (amount: number) => `color-mix(in srgb, ${color} ${100 - amount}%, ${ink})`;
  const background = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const luminanceOf = (rgb: number[]) =>
    rgb
      .map((n) => {
        const v = n / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const body = [0.86, 0.92, 0.96, 1]
    .map((weight) =>
      background.map((v) =>
        Math.round(v + ((darkInk ? parseInt(ink.slice(1, 3), 16) : 255) - v) * weight),
      ),
    )
    .find((rgb) => {
      const value = luminanceOf(rgb);
      return (Math.max(value, luminance) + 0.05) / (Math.min(value, luminance) + 0.05) >= 4.5;
    });
  return {
    backgroundColor: color,
    color: ink,
    '--multichat-body': body ? `rgb(${body.join(', ')})` : ink,
    '--brand': ink,
    '--link': ink,
    '--code-ink': ink,
    '--code-bg': mix(8),
    '--code-line': mix(25),
    '--code-block': mix(7),
    '--tk-k': darkInk ? '#4c287c' : '#d5c4ff',
    '--tk-s': darkInk ? '#17502f' : '#a5dfb5',
    '--tk-c': mix(70),
    '--tk-n': darkInk ? '#802d36' : '#ffc4ce',
    '--tk-f': darkInk ? '#173d75' : '#b4dcff',
    '--tk-t': darkInk ? '#6a4511' : '#ead99f',
    '--card': color,
    '--text': ink,
    '--text-2': ink,
    '--muted': mix(75),
    '--faint': mix(55),
    '--line': mix(25),
    '--tile': mix(9),
    '--tile-hover': mix(15),
    '--sel': ink,
    '--sel-text': color,
    '--ui-text-color': ink,
    '--ui-icon-color': ink,
  } as CSSProperties;
}
