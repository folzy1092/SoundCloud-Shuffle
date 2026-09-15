const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('./test-helpers');

test('isEligibleTrack accepts only finished, streamable ALLOW tracks', () => {
  const { isEligibleTrack } = loadCore();

  assert.equal(isEligibleTrack({ policy: 'ALLOW', state: 'finished', streamable: true }), true);
  assert.equal(isEligibleTrack({ policy: 'BLOCK', state: 'finished', streamable: true }), false);
  assert.equal(isEligibleTrack({ policy: 'ALLOW', state: 'processing', streamable: true }), false);
  assert.equal(isEligibleTrack({ policy: 'ALLOW', state: 'finished', streamable: false }), false);
  assert.equal(isEligibleTrack(null), false);
});

test('shuffleTracks creates a deterministic Fisher-Yates permutation without mutating input', () => {
  const { shuffleTracks } = loadCore();
  const tracks = ['a', 'b', 'c', 'd'];
  const randomValues = [0.9, 0.1, 0.5];
  let randomIndex = 0;

  const shuffled = shuffleTracks(tracks, () => randomValues[randomIndex++]);

  assert.deepEqual(shuffled, ['c', 'b', 'a', 'd']);
  assert.deepEqual(tracks, ['a', 'b', 'c', 'd']);
  assert.notEqual(shuffled, tracks);
});

test('shuffleTracks uses Math.random when no random function is supplied', () => {
  const { shuffleTracks } = loadCore();
  const tracks = ['a'];

  assert.deepEqual(shuffleTracks(tracks), ['a']);
});

test('buildLikesUrl creates a first API v2 likes request', () => {
  const { buildLikesUrl } = loadCore();

  assert.equal(
    buildLikesUrl(null, 'client id', '123'),
    'https://api-v2.soundcloud.com/users/123/track_likes?client_id=client+id&limit=200&linked_partitioning=1',
  );
});

test('buildLikesUrl preserves a pagination cursor and replaces client_id', () => {
  const { buildLikesUrl } = loadCore();

  assert.equal(
    buildLikesUrl('https://api-v2.soundcloud.com/users/123/track_likes?cursor=abc&client_id=old', 'new', '123'),
    'https://api-v2.soundcloud.com/users/123/track_likes?cursor=abc&client_id=new',
  );
});

test('makeAccountKey namespaces the SoundCloud account identifier', () => {
  const { makeAccountKey } = loadCore();

  assert.equal(makeAccountKey('456'), 'soundcloud-shuffle:456');
});
