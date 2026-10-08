// Vite returns the file contents as text for `?raw` imports.
declare module '*?raw' {
  const content: string;
  export default content;
}
// Vite's lazy glob imports (used for the themes shipped in /themes).
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options?: { query?: string; import?: string },
  ): Record<string, () => Promise<T>>;
}
