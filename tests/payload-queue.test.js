const test = require('node:test');
const assert = require('node:assert/strict');

const { replaceQueueFromPayloads } = require('../extension/page-bridge.js');

class FakeSound {
  static normalize(payload) {
    return { ...payload, normalized: true };
  }

  constructor(attrs) {
    this.id = attrs.id;
    this.attributes = attrs;
  }

  get(name) {
    return this.attributes[name];
  }
}

test('replaceQueueFromPayloads hydrates native sounds and replaces once without populating Likes', async () => {
  let bulkFetchCalls = 0;
  const likes = {
    getSourceInfo: () => ({ type: 'user-track_likes', resourceId: 7 }),
    bulkFetch: () => { bulkFetchCalls += 1; },
  };
  const currentSound = new FakeSound({ id: 1, title: 'current' });
  const current = { sound: currentSound, originalModel: { collection: likes } };
  const replacements = [];
  const created = [];
  const player = {
    getCurrentQueueItem: () => current,
    createExplicitQueueItem(sourceCollection, sound, context) {
      created.push({ sourceCollection, sound, context });
      return { sound };
    },
    replaceQueue(...args) {
      replacements.push(args);
    },
  };

  const result = await replaceQueueFromPayloads({
    player,
    tracks: [
      { id: 1, title: 'current' },
      { id: 3, title: 'third' },
      { id: 2, title: 'second' },
    ],
  });

  assert.deepEqual(result, { queuedCount: 2 });
  assert.equal(bulkFetchCalls, 0);
  assert.equal(created.length, 2);
  assert.equal(created[0].sourceCollection, created[0].sound);
  assert.equal(created[0].context, null);
  assert.deepEqual(created.map(({ sound }) => sound.id), [3, 2]);
  assert.equal(created.every(({ sound }) => sound instanceof FakeSound), true);
  assert.equal(replacements.length, 1);
  assert.deepEqual(replacements[0][0].map((item) => item.sound.id), [1, 3, 2]);
  assert.equal(replacements[0][1], 0);
  assert.deepEqual(replacements[0][2], { pause: true });
});

test('replaceQueueFromPayloads works when the current QueueItem has no original Likes collection', async () => {
  const current = { sound: new FakeSound({ id: 1, title: 'current' }) };
  const replacements = [];
  const player = {
    getCurrentQueueItem: () => current,
    createExplicitQueueItem(sourceCollection, sound, context) {
      assert.equal(sourceCollection, sound);
      assert.equal(context, null);
      return { sound };
    },
    replaceQueue(...args) {
      replacements.push(args);
    },
  };

  const result = await replaceQueueFromPayloads({
    player,
    tracks: [
      { id: 1, title: 'current' },
      { id: 2, title: 'next' },
    ],
  });

  assert.deepEqual(result, { queuedCount: 1 });
  assert.equal(replacements.length, 1);
  assert.deepEqual(replacements[0][0].map((item) => item.sound.id), [1, 2]);
});

test('replaceQueueFromPayloads rejects when there is no current sound', async () => {
  let replacements = 0;
  const player = {
    getCurrentQueueItem: () => ({ sound: null }),
    createExplicitQueueItem: () => ({ sound: new FakeSound({ id: 2 }) }),
    replaceQueue: () => { replacements += 1; },
  };

  await assert.rejects(
    replaceQueueFromPayloads({ player, tracks: [{ id: 2 }] }),
    /Включите любой трек/,
  );
  assert.equal(replacements, 0);
});
