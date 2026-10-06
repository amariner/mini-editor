// Tests that need several accounts create them explicitly, just like a user would.
export async function createTestAccounts(page) {
  await page.evaluate(async () => {
    const state = await window.desk.invoke({ type: 'snapshot' });
    if (state.profiles?.length) return;
    for (const [kind, name] of [
      ['claude', 'Claude 1'],
      ['claude', 'Claude 2'],
      ['codex', 'Codex'],
    ]) {
      await window.desk.invoke({ type: 'addAccount', kind, name });
    }
  });
}
