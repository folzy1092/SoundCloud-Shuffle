const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchTrackPayloads } = require('../extension/background.js');

test('fetchTrackPayloads restores requested shuffle order when SoundCloud returns unordered tracks', async () => {
  const urls = [];
  const result = await fetchTrackPayloads([3, 1, 2], 'cid', async (url) => {
    urls.push(url);
    return [{ id: 2, title: 'two' }, { id: 3, title: 'three' }, { id: 1, title: 'one' }];
  });

  assert.deepEqual(result.map((track) => track.id), [3, 1, 2]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /tracks\?ids=3%2C1%2C2/);
  assert.match(urls[0], /client_id=cid/);
});

test('fetchTrackPayloads batches large queues without changing their order', async () => {
  const ids = Array.from({ length: 103 }, (_, index) => index + 1);
  let calls = 0;
  const result = await fetchTrackPayloads(ids, 'cid', async (url) => {
    calls += 1;
    const parsed = new URL(url);
    const batch = parsed.searchParams.get('ids').split(',').map(Number);
    return batch.slice().reverse().map((id) => ({ id }));
  });

  assert.equal(calls, 3);
  assert.deepEqual(result.map((track) => track.id), ids);
});

test('fetchTrackPayloads rejects a partial SoundCloud response', async () => {
  await assert.rejects(
    fetchTrackPayloads([1, 2], 'cid', async () => [{ id: 1 }]),
    /Не удалось подготовить данные треков/,
  );
});
