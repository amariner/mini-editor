export type GridLayout = { auto: boolean; rows: number; columns: number };

export const gridSizes = [1, 2, 3, 4];
export const gridGap = 10;
const minCardWidth = 300;
// Landscape first: wide cards read better than tall, narrow ones. Index = number of chats.
const preferredColumns = [1, 1, 2, 3, 2, 3, 3, 4, 4, 3, 4, 4, 4];

/** Saved layouts from earlier builds always held the 2 × 2 default, chosen or not. */
export function restoreLayout(raw: unknown): GridLayout {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<GridLayout>;
  const rows = gridSizes.includes(value.rows as number) ? (value.rows as number) : 2;
  const columns = gridSizes.includes(value.columns as number) ? (value.columns as number) : 2;
  const auto = typeof value.auto === 'boolean' ? value.auto : rows === 2 && columns === 2;
  return { auto, rows, columns };
}

/** Columns that keep every card at a readable width. */
export function fitColumns(width: number) {
  return Math.max(1, Math.min(4, Math.floor((width + gridGap) / (minCardWidth + gridGap))));
}

/** Arrangement for `count` chats when the grid follows the running chats. */
export function autoLayout(count: number, fit: number) {
  const columns = Math.max(1, Math.min(fit, preferredColumns[Math.min(count, 12)]));
  return { columns, rows: Math.max(1, Math.min(4, Math.ceil(count / columns))) };
}
