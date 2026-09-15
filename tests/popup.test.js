const test = require('node:test');
const assert = require('node:assert/strict');

const { renderStatus, createPopupController } = require('../extension/popup.js');

function node() {
  return { textContent: '', disabled: false, addEventListener() {} };
}

test('renders a Russian ready status with count and local sync date', () => {
  const root = node();
  renderStatus(
    { eligibleCount: 431, skippedCount: 7, syncedAt: '2026-09-14T12:00:00.000Z', lastError: null },
    root,
    () => '14.09.2026, 15:00',
  );
  assert.match(root.textContent, /431 доступных треков/);
  assert.match(root.textContent, /Пропущено: 7/);
  assert.match(root.textContent, /14\.09\.2026/);
});

test('popup controller requests status, syncs and clears only the active account', async () => {
  const statusRoot = node();
  const syncButton = node();
  const clearButton = node();
  const messages = [];
  const context = { accountId: '7', userId: '7', clientId: 'cid' };
  const controller = createPopupController({
    statusRoot,
    syncButton,
    clearButton,
    getContext: async () => context,
    sendMessage: async (message) => {
      messages.push(message);
      if (message.type === 'GET_STATUS') return { ok: true, status: null };
      if (message.type === 'SYNC_LIKES') {
        return { ok: true, eligibleTracks: [{ id: 1 }, { id: 2 }], skippedCount: 3, syncedAt: '2026-09-14T12:00:00.000Z' };
      }
      return { ok: true };
    },
    formatDate: () => '14.09.2026, 15:00',
  });

  await controller.start();
  await controller.sync();
  await controller.clear();
  assert.deepEqual(messages, [
    { type: 'GET_STATUS', accountId: '7' },
    { type: 'SYNC_LIKES', context },
    { type: 'CLEAR_ACCOUNT', accountId: '7' },
  ]);
  assert.match(statusRoot.textContent, /Кэш очищен/);
  assert.equal(syncButton.disabled, false);
  assert.equal(clearButton.disabled, false);
});
