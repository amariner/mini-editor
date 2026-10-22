/** Keep delayed IPC reads from replacing a newer broadcast or a later read. */
export class SnapshotSync<T> {
  private revision = 0;
  private request = 0;
  private latestRead?: Promise<void>;

  constructor(
    private load: () => Promise<T>,
    private apply: (snapshot: T) => void,
  ) {}

  receive(snapshot: T) {
    this.revision++;
    this.apply(snapshot);
  }

  invalidate() {
    this.revision++;
  }

  async refresh() {
    const revision = this.revision;
    const request = ++this.request;
    const read = this.load().then((snapshot) => {
      if (revision === this.revision && request === this.request) this.receive(snapshot);
    });
    this.latestRead = read;
    await read;
    // Navigation callers inspect the applied state after awaiting refresh. If a
    // later read superseded this one, wait for it rather than returning stale state.
    let current = read;
    while (current !== this.latestRead) {
      current = this.latestRead!;
      await current;
    }
  }
}
