import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalStream } from '../src/terminal-stream';

test('terminal snapshot reconciles overlapping events without duplicates or missing output', () => {
  const output: string[] = [];
  const stream = createTerminalStream((data) => output.push(data));
  stream.push({ data: 'already in snapshot', sequence: 1 });
  stream.push({ data: 'new output', sequence: 2 });
  assert.deepEqual(output, []);
  stream.restore({ data: 'history', sequence: 1 });
  stream.push({ data: 'live', sequence: 3 });
  assert.deepEqual(output, ['history', 'new output', 'live']);
});

test('terminal remains live after a failed or timed out snapshot and ignores a late snapshot', () => {
  const output: string[] = [];
  const stream = createTerminalStream((data) => output.push(data));
  stream.push({ data: 'during load', sequence: 5 });
  stream.restore();
  stream.push({ data: 'after failure', sequence: 6 });
  stream.restore({ data: 'late duplicated history', sequence: 6 });
  // Sequence numbers can restart when a process is relaunched in the same terminal.
  stream.push({ data: 'new process', sequence: 1 });
  assert.deepEqual(output, ['during load', 'after failure', 'new process']);
});

test('disposed terminal drops queued output and ignores pending responses and events', () => {
  const output: string[] = [];
  const stream = createTerminalStream((data) => output.push(data));
  stream.push({ data: 'queued', sequence: 1 });
  stream.dispose();
  stream.restore({ data: 'history', sequence: 0 });
  stream.push({ data: 'late', sequence: 2 });
  assert.deepEqual(output, []);
});
