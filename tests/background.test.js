const test = require('node:test');
const assert = require('node:assert/strict');

const { syncLikes, registerMessageHandlers } = require('../extension/background.js');

function eligible(id) {
  return {
    id,
    title: `Track ${id}`,
    permalink_url: `https://soundcloud.com/artist/track-${id}`,
    user: { id: `artist-${id}`, username: `Artist ${id}` },
    policy: 'ALLOW',
    state: 'finished',
    streamable: true,
  };
}

function blocked(id) {
  return { ...eligible(id), policy: 'BLOCK' };
}

test('syncLikes follows pagination and writes the completed account cache once', async () => {
  const writes = [];
  const requestedUrls = [];
  const fetchJson = async (url) => {
    requestedUrls.push(url);
    if (url.includes('cursor=second')) {
      return { collection: [{ track: eligible(2), created_at: '2026-09-14T11:00:00.000Z' }] };
    }
    return {
      collection: [
        { track: eligible(1), created_at: '2026-09-14T10:00:00.000Z' },
        { track: blocked(9), created_at: '2026-09-14T09:00:00.000Z' },
      ],
      next_href: 'https://api-v2.soundcloud.com/users/7/track_likes?cursor=second&client_id=stale',
    };
  };

  const result = await syncLikes(
    { accountId: '7', userId: '7', clientId: 'cid' },
    { fetchJson, set: async (value) => writes.push(value), now: () => '2026-09-14T12:00:00.000Z' },
  );

  assert.deepEqual(result, {
    accountId: '7',
    eligibleTracks: [
      { ...eligible(1), likedAt: '2026-09-14T10:00:00.000Z' },
      { ...eligible(2), likedAt: '2026-09-14T11:00:00.000Z' },
    ],
    skippedCount: 1,
    syncedAt: '2026-09-14T12:00:00.000Z',
  });
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[0], /limit=200/);
  assert.match(requestedUrls[1], /cursor=second/);
  assert.match(requestedUrls[1], /client_id=cid/);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]['soundcloud-shuffle:7'], {
    tracks: result.eligibleTracks,
    skippedCount: 1,
    syncedAt: '2026-09-14T12:00:00.000Z',
    lastError: null,
  });
});

test('syncLikes preserves the existing account cache when the second page fails', async () => {
  const existingCache = { tracks: [{ id: 99 }], syncedAt: 'previous' };
  const storage = { 'soundcloud-shuffle:7': existingCache };
  let writes = 0;
  const fetchJson = async (url) => {
    if (url.includes('cursor=second')) throw new Error('network unavailable');
    return {
      collection: [{ track: eligible(1), created_at: '2026-09-14T10:00:00.000Z' }],
      next_href: 'https://api-v2.soundcloud.com/users/7/track_likes?cursor=second',
    };
  };

  await assert.rejects(
    syncLikes(
      { accountId: '7', userId: '7', clientId: 'cid' },
      { fetchJson, set: async (value) => { writes += 1; Object.assign(storage, value); } },
    ),
    /Не удалось синхронизировать/,
  );

  assert.equal(writes, 0);
  assert.equal(storage['soundcloud-shuffle:7'], existingCache);
});

test('syncLikes rejects a malformed API page without writing a cache entry', async () => {
  let writes = 0;
  await assert.rejects(
    syncLikes(
      { accountId: '7', userId: '7', clientId: 'cid' },
      { fetchJson: async () => ({ collection: null }), set: async () => { writes += 1; } },
    ),
    /Не удалось синхронизировать/,
  );
  assert.equal(writes, 0);
});

test('syncLikes rejects a falsy non-null pagination cursor without writing a cache entry', async () => {
  let writes = 0;
  await assert.rejects(
    syncLikes(
      { accountId: '7', userId: '7', clientId: 'cid' },
      {
        fetchJson: async () => ({
          collection: [{ track: eligible(1), created_at: '2026-09-14T10:00:00.000Z' }],
          next_href: false,
        }),
        set: async () => { writes += 1; },
      },
    ),
    /Не удалось синхронизировать/,
  );
  assert.equal(writes, 0);
});

test('syncLikes rejects an incomplete like record without writing a cache entry', async () => {
  let writes = 0;
  const incompleteTrack = eligible(1);
  delete incompleteTrack.permalink_url;
  await assert.rejects(
    syncLikes(
      { accountId: '7', userId: '7', clientId: 'cid' },
      {
        fetchJson: async () => ({ collection: [{ track: incompleteTrack, created_at: '2026-09-14T10:00:00.000Z' }] }),
        set: async () => { writes += 1; },
      },
    ),
    /Не удалось синхронизировать/,
  );
  assert.equal(writes, 0);
});

test('syncLikes rejects a like whose user is not a complete user object', async () => {
  let writes = 0;
  const malformedTrack = eligible(1);
  malformedTrack.user = [];
  await assert.rejects(
    syncLikes(
      { accountId: '7', userId: '7', clientId: 'cid' },
      {
        fetchJson: async () => ({ collection: [{ track: malformedTrack, created_at: '2026-09-14T10:00:00.000Z' }] }),
        set: async () => { writes += 1; },
      },
    ),
    /Не удалось синхронизировать/,
  );
  assert.equal(writes, 0);
});

test('status and clear handler failures return a Russian user-facing error', async () => {
  const originalChrome = global.chrome;
  const listeners = [];
  global.chrome = {
    runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } },
    storage: {
      local: {
        get: async () => { throw new Error('raw storage read error'); },
        remove: async () => { throw new Error('raw storage delete error'); },
      },
    },
  };

  try {
    registerMessageHandlers();
    const listener = listeners[0];
    const statusResponse = await new Promise((resolve) => {
      assert.equal(listener({ type: 'GET_STATUS', accountId: '7' }, null, resolve), true);
    });
    const clearResponse = await new Promise((resolve) => {
      assert.equal(listener({ type: 'CLEAR_ACCOUNT', accountId: '7' }, null, resolve), true);
    });

    assert.deepEqual(statusResponse, { ok: false, error: 'Не удалось обработать данные расширения. Попробуйте ещё раз.' });
    assert.deepEqual(clearResponse, { ok: false, error: 'Не удалось обработать данные расширения. Попробуйте ещё раз.' });
  } finally {
    global.chrome = originalChrome;
  }
});

test('REQUEST_FULL_SHUFFLE returns a fresh full permutation from account cache without resyncing', async () => {
  const originalChrome = global.chrome;
  const listeners = [];
  let fetches = 0;
  global.fetch = async () => { fetches += 1; throw new Error('should not fetch'); };
  global.chrome = {
    runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } },
    storage: {
      local: {
        get: async () => ({
          'soundcloud-shuffle:7': {
            tracks: [eligible(1), eligible(2), eligible(3)],
            skippedCount: 4,
            syncedAt: '2026-09-14T12:00:00.000Z',
            lastError: null,
          },
        }),
        set: async () => {},
      },
    },
  };

  try {
    registerMessageHandlers();
    const listener = listeners[0];
    const response = await new Promise((resolve) => {
      assert.equal(listener({ type: 'REQUEST_FULL_SHUFFLE', context: { accountId: '7', userId: '7', clientId: 'cid' } }, null, resolve), true);
    });
    assert.equal(response.ok, true);
    assert.equal(response.tracks.length, 3);
    assert.deepEqual([...response.tracks.map(({ id }) => id)].sort(), [1, 2, 3]);
    assert.equal(response.skippedCount, 4);
    assert.equal(fetches, 0);
  } finally {
    global.chrome = originalChrome;
    delete global.fetch;
  }
});

test('REQUEST_FULL_SHUFFLE syncs once when cache is missing and then returns the synced tracks', async () => {
  const originalChrome = global.chrome;
  const originalFetch = global.fetch;
  const listeners = [];
  const writes = [];
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      collection: [
        { track: eligible(11), created_at: '2026-09-14T10:00:00.000Z' },
        { track: blocked(12), created_at: '2026-09-14T09:00:00.000Z' },
      ],
      next_href: null,
    }),
  });
  global.chrome = {
    runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } },
    storage: {
      local: {
        get: async () => ({}),
        set: async (value) => { writes.push(value); },
      },
    },
  };

  try {
    registerMessageHandlers();
    const listener = listeners[0];
    const response = await new Promise((resolve) => {
      assert.equal(listener({ type: 'REQUEST_FULL_SHUFFLE', context: { accountId: '7', userId: '7', clientId: 'cid' } }, null, resolve), true);
    });
    assert.equal(response.ok, true);
    assert.deepEqual(response.tracks.map(({ id }) => id), [11]);
    assert.equal(response.skippedCount, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]['soundcloud-shuffle:7'].tracks[0].id, 11);
  } finally {
    global.chrome = originalChrome;
    global.fetch = originalFetch;
  }
});
