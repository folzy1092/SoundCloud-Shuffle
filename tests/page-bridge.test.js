const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { replaceQueueFromLikes, getPageContext } = require('../extension/page-bridge.js');

function fixture() {
  const sounds = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const calls = [];
  const sourceInfo = { type: 'user-track_likes', resourceId: 7, resourceType: 'user' };
  const likes = {
    getSourceInfo: () => sourceInfo,
    audibleAt: (index) => sounds[index],
    getSoundIndex: (sound) => sounds.indexOf(sound),
    isFullyPopulated: () => true,
  };
  const current = { sound: sounds[0], originalModel: { collection: likes } };
  const player = {
    getCurrentQueueItem: () => current,
    createExplicitQueueItem(collection, sound, context) {
      assert.equal(collection, likes);
      assert.equal(context.sourceInfo, sourceInfo);
      assert.ok(sounds.includes(sound), 'uses native collection sound identity');
      return { sound };
    },
    replaceQueue: (...args) => calls.push(args),
  };
  return { sounds, calls, likes, current, player };
}

test('extracts client and meUser account context from current SoundCloud hydration', () => {
  const f = fixture();
  const page = {
    __sc_hydration: [
      { hydratable: 'anonymousId', data: 'anon' },
      { hydratable: 'meUser', data: { id: 7, urn: 'soundcloud:users:7' } },
      { hydratable: 'features', data: {} },
      { hydratable: 'geoip', data: {} },
      { hydratable: 'privacySettings', data: {} },
      { hydratable: 'statsigClientInitializeResponse', data: {} },
      { hydratable: 'trackingBrowserTabId', data: 'tab' },
      { hydratable: 'apiClient', data: { id: 'client-123' } },
    ],
  };
  const context = getPageContext(page, f.player);
  assert.deepEqual(context, { accountId: '7', userId: '7', clientId: 'client-123' });
});

test('supports nested meUser user shape and URN fallback', () => {
  const f = fixture();
  assert.deepEqual(getPageContext({
    __sc_hydration: [
      { hydratable: 'meUser', data: { user: { id: 7 } } },
      { hydratable: 'apiClient', data: { clientId: 'client-123' } },
    ],
  }, f.player), { accountId: '7', userId: '7', clientId: 'client-123' });

  assert.deepEqual(getPageContext({
    __sc_hydration: [
      { hydratable: 'meUser', data: { urn: 'soundcloud:users:7' } },
      { hydratable: 'apiClient', data: { id: 'client-123' } },
    ],
  }, f.player), { accountId: '7', userId: '7', clientId: 'client-123' });
});

test('accepts client_id and nested authenticated user shapes from SoundCloud hydration', () => {
  const f = fixture();
  const page = {
    __sc_hydration: [
      { hydratable: 'meUser', data: { profile: { id: '7' } } },
      { hydratable: 'apiClient', data: { client: { client_id: 'client-nested' } } },
    ],
  };
  assert.deepEqual(getPageContext(page, f.player), {
    accountId: '7',
    userId: '7',
    clientId: 'client-nested',
  });
});

test('rejects context when active Likes collection belongs to another user', () => {
  const f = fixture();
  f.likes.getSourceInfo = () => ({ type: 'user-track_likes', resourceId: 99, resourceType: 'user' });
  const page = {
    __sc_hydration: [
      { hydratable: 'apiClient', data: { id: 'client-123' } },
      { hydratable: 'meUser', data: { id: 7 } },
    ],
  };
  assert.throws(() => getPageContext(page, f.player), /Нравится|аккаунт|SoundCloud/);
});

test('prepares native queue items in requested order and replaces once preserving current', async () => {
  assert.equal(typeof replaceQueueFromLikes, 'function');
  const { player, calls, current, sounds } = fixture();
  const result = await replaceQueueFromLikes({ player, trackIds: [1, 3, 2] });
  assert.deepEqual(result, { queuedCount: 2 });
  assert.deepEqual(calls, [[[current, { sound: sounds[2] }, { sound: sounds[1] }], 0, { pause: true }]]);
  assert.equal(calls[0][0][0], current);
});

test('excludes numeric and string current IDs and rejects duplicate requested sounds', async () => {
  const { player, calls } = fixture();
  assert.deepEqual(await replaceQueueFromLikes({ player, trackIds: ['1', '3', 2] }), { queuedCount: 2 });
  calls.length = 0;
  await assert.rejects(replaceQueueFromLikes({ player, trackIds: [2, '2'] }), /Синхронизируйте/);
  assert.equal(calls.length, 0);
});

for (const [name, breakContext] of [
  ['missing Likes collection', (f) => { delete f.current.originalModel.collection; }],
  ['non-Likes context', (f) => { f.likes.getSourceInfo = () => ({ type: 'playlist' }); }],
  ['missing sound indexing', (f) => { delete f.likes.getSoundIndex; }],
  ['unknown population state', (f) => { delete f.likes.isFullyPopulated; }],
  ['missing player method', (f) => { delete f.player.createExplicitQueueItem; }],
]) {
  test(`rejects ${name} without replacing the queue`, async () => {
    const f = fixture();
    breakContext(f);
    await assert.rejects(replaceQueueFromLikes({ player: f.player, trackIds: [2] }), /Нравится|Обновите|Включите/);
    assert.equal(f.calls.length, 0);
  });
}

test('waits for full callback population before mapping native sounds', async () => {
  const f = fixture();
  f.sounds.pop();
  let populated = false;
  f.likes.isFullyPopulated = () => populated;
  f.likes.bulkFetch = (done) => {
    queueMicrotask(() => {
      f.sounds.push({ id: 3 });
      populated = true;
      done();
    });
  };
  const result = await replaceQueueFromLikes({ player: f.player, trackIds: [3, 2] });
  assert.deepEqual(result, { queuedCount: 2 });
  assert.deepEqual(f.calls[0][0].map((item) => item.sound.id), [1, 3, 2]);
});

test('waits for Promise population before replacing', async () => {
  const f = fixture();
  f.sounds.pop();
  let populated = false;
  f.likes.isFullyPopulated = () => populated;
  f.likes.bulkFetch = async () => { f.sounds.push({ id: 3 }); populated = true; };
  assert.deepEqual(await replaceQueueFromLikes({ player: f.player, trackIds: [3] }), { queuedCount: 1 });
});

for (const [name, breakPopulation] of [
  ['partial population after completion', (f) => { f.likes.bulkFetch = (done) => done(); }],
  ['fetch rejection', (f) => { f.likes.bulkFetch = async () => { throw new Error('fetch failed'); }; }],
  ['missing population method', () => {}],
]) {
  test(`rejects ${name} without replacing the queue`, async () => {
    const f = fixture();
    f.likes.isFullyPopulated = () => false;
    breakPopulation(f);
    await assert.rejects(replaceQueueFromLikes({ player: f.player, trackIds: [2] }), /Нравится/);
    assert.equal(f.calls.length, 0);
  });
}

for (const [name, create] of [
  ['creation throws after preparing an item', (sound) => { if (sound.id === 3) throw new Error('raw internal error'); return { sound }; }],
  ['creation returns no item', () => undefined],
  ['creation returns wrong sound', () => ({ sound: { id: 99 } })],
]) {
  test(`rejects ${name} without any replacement`, async () => {
    const f = fixture();
    f.player.createExplicitQueueItem = (_likes, sound) => create(sound);
    await assert.rejects(replaceQueueFromLikes({ player: f.player, trackIds: [2, 3] }), /Обновите/);
    assert.equal(f.calls.length, 0);
  });
}

test('rejects missing requested sounds and empty requests without replacing', async () => {
  const f = fixture();
  for (const trackIds of [[9], [], null, [{}]]) {
    await assert.rejects(replaceQueueFromLikes({ player: f.player, trackIds }), /Синхронизируйте/);
  }
  assert.equal(f.calls.length, 0);
});

test('does not overwrite a new current track if playback changes during population', async () => {
  const f = fixture();
  let populated = false;
  f.likes.isFullyPopulated = () => populated;
  f.likes.bulkFetch = async () => {
    populated = true;
    f.player.getCurrentQueueItem = () => ({ sound: { id: 9 } });
  };
  await assert.rejects(replaceQueueFromLikes({ player: f.player, trackIds: [2] }), /Повторите/);
  assert.equal(f.calls.length, 0);
});

for (const kind of ['deferred', 'options']) {
  test(`supports ${kind} population completion without mapping early`, async () => {
    const f = fixture();
    f.sounds.pop();
    let populated = false;
    f.likes.isFullyPopulated = () => populated;
    const complete = (done) => queueMicrotask(() => {
      f.sounds.push({ id: 3 });
      populated = true;
      done();
    });
    f.likes.bulkFetch = kind === 'options'
      ? (options) => { complete(options.success); }
      : () => ({ done(callback) { complete(callback); return this; }, fail() { return this; } });
    assert.deepEqual(await replaceQueueFromLikes({ player: f.player, trackIds: [3] }), { queuedCount: 1 });
  });
}

function browserFixture({ kind = 'function', hostname = 'soundcloud.com', player = fixture().player, hydration } = {}) {
  const listeners = new Map();
  const responses = [];
  const injectedIds = [];
  const requireModule = (id) => { assert.equal(id, 20); return player; };
  requireModule.c = { 20: { exports: player } };
  requireModule.m = {};
  const inject = (_chunks, modules, entries) => {
    for (const entry of entries) {
      const id = Array.isArray(entry) ? entry[0] : entry;
      injectedIds.push(id);
      requireModule.m[id] = modules[id];
      requireModule.c[id] = { exports: {} };
      modules[id](requireModule.c[id], {}, requireModule);
    }
  };
  const document = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    dispatchEvent: (event) => responses.push(event),
  };
  const window = {
    location: { hostname, protocol: 'https:' },
    document,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  };
  if (hydration) window.__sc_hydration = hydration;
  if (kind === 'function') window.webpackJsonp = inject;
  if (kind === 'array') window.webpackJsonp = { push: (payload) => inject(...payload) };
  const context = vm.createContext({ window, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/page-bridge.js'), 'utf8'), context);
  return { window, listeners, responses, injectedIds, requireModule };
}

test('context bridge replies with correlated account data', async () => {
  const f = fixture();
  const browser = browserFixture({
    player: f.player,
    hydration: [
      { hydratable: 'apiClient', data: { id: 'client-live' } },
      { hydratable: 'meUser', data: { id: 7 } },
    ],
  });
  assert.equal(typeof browser.listeners.get('scshuffle:get-context'), 'function');
  await browser.listeners.get('scshuffle:get-context')({ detail: { requestId: 'context-1' } });
  const event = browser.responses.find((response) => response.type === 'scshuffle:context-result');
  assert.deepEqual(JSON.parse(JSON.stringify(event.detail)), {
    requestId: 'context-1',
    ok: true,
    context: { accountId: '7', userId: '7', clientId: 'client-live' },
  });
});

test('context bridge waits briefly when SoundCloud hydration appears after the request', async () => {
  const f = fixture();
  const browser = browserFixture({ player: f.player });
  const pending = browser.listeners.get('scshuffle:get-context')({ detail: { requestId: 'late-context' } });
  setTimeout(() => {
    browser.window.__sc_hydration = [
      { hydratable: 'apiClient', data: { id: 'client-late' } },
      { hydratable: 'meUser', data: { id: 7 } },
    ];
  }, 20);
  await pending;
  const event = browser.responses.find((response) => response.type === 'scshuffle:context-result');
  assert.deepEqual(JSON.parse(JSON.stringify(event.detail)), {
    requestId: 'late-context',
    ok: true,
    context: { accountId: '7', userId: '7', clientId: 'client-late' },
  });
});

for (const kind of ['function', 'array']) {
  test(`captures ${kind} webpack runtime and replies with the matching requestId`, async () => {
    const f = fixture();
    const browser = browserFixture({ kind, player: f.player });
    assert.equal(typeof browser.listeners.get('scshuffle:replace-queue'), 'function');
    await browser.listeners.get('scshuffle:replace-queue')({ detail: { requestId: 'shuffle-7', trackIds: [3, 2] } });
    assert.equal(f.calls.length, 1);
    assert.equal(browser.responses.length, 1);
    assert.equal(browser.responses[0].type, 'scshuffle:queue-result');
    assert.deepEqual(JSON.parse(JSON.stringify(browser.responses[0].detail)), { requestId: 'shuffle-7', ok: true, queuedCount: 2 });
    for (const id of browser.injectedIds) {
      assert.equal(browser.requireModule.m[id], undefined);
      assert.equal(browser.requireModule.c[id], undefined);
    }
    assert.equal(browser.window.__scReq, undefined);
  });
}

test('missing webpack runtime returns an actionable correlated error', async () => {
  const browser = browserFixture({ kind: 'absent' });
  assert.equal(typeof browser.listeners.get('scshuffle:replace-queue'), 'function');
  await browser.listeners.get('scshuffle:replace-queue')({ detail: { requestId: 8, trackIds: [2] } });
  const result = browser.responses[0].detail;
  assert.equal(result.requestId, 8);
  assert.equal(result.ok, false);
  assert.equal(result.queuedCount, 0);
  assert.match(result.error, /Обновите/);
});

test('preparation error returns a correlated Russian event response and no replacement', async () => {
  const f = fixture();
  f.player.createExplicitQueueItem = () => { throw new Error('internal failure'); };
  const browser = browserFixture({ player: f.player });
  assert.equal(typeof browser.listeners.get('scshuffle:replace-queue'), 'function');
  await browser.listeners.get('scshuffle:replace-queue')({ detail: { requestId: 'failed-9', trackIds: [2] } });
  assert.equal(browser.responses[0].detail.requestId, 'failed-9');
  assert.equal(browser.responses[0].detail.ok, false);
  assert.match(browser.responses[0].detail.error, /Обновите/);
  assert.equal(f.calls.length, 0);
});

test('does not register the page bridge on unrelated domains', () => {
  assert.equal(browserFixture({ hostname: 'soundcloud.com.evil.test' }).listeners.size, 0);
});
