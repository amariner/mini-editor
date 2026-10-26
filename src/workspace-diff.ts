export type DiffLine = {
  kind: 'context' | 'added' | 'removed' | 'hunk' | 'meta';
  text: string;
  before?: number;
  after?: number;
};

/** Preserve patch text while giving each side its own line numbers. */
export function parseWorkspaceDiff(patch: string): DiffLine[] {
  let before = 0;
  let after = 0;
  let inHunk = false;
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      inHunk = true;
      return { kind: 'hunk', text };
    }
    if (
      text.startsWith('diff --git ') ||
      (!inHunk &&
        /^(--- |\+\+\+ |index |new file mode |deleted file mode |old mode |new mode |rename |similarity index |Binary files |GIT binary patch)/.test(
          text,
        ))
    ) {
      inHunk = false;
      return { kind: 'meta', text };
    }
    if (!inHunk || text.startsWith('\\')) return { kind: 'meta', text };
    if (text.startsWith('+')) return { kind: 'added', text: text.slice(1), after: after++ };
    if (text.startsWith('-')) return { kind: 'removed', text: text.slice(1), before: before++ };
    if (text.startsWith(' '))
      return { kind: 'context', text: text.slice(1), before: before++, after: after++ };
    return { kind: 'meta', text };
  });
}
