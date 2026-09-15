(function () {
  function isEligibleTrack(track) {
    return Boolean(
      track
      && track.policy === 'ALLOW'
      && track.state === 'finished'
      && track.streamable === true,
    );
  }

  function shuffleTracks(tracks, random) {
    const shuffled = tracks.slice();
    const getRandom = random || Math.random;

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(getRandom() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }

    return shuffled;
  }

  function buildLikesUrl(nextHref, clientId, userId) {
    const url = new URL(
      nextHref || `https://api-v2.soundcloud.com/users/${userId}/track_likes`,
    );

    url.searchParams.set('client_id', clientId);
    if (!nextHref) {
      url.searchParams.set('limit', '200');
      url.searchParams.set('linked_partitioning', '1');
    }
    return url.toString();
  }

  function makeAccountKey(accountId) {
    return `soundcloud-shuffle:${accountId}`;
  }

  globalThis.SCShuffleCore = {
    isEligibleTrack,
    shuffleTracks,
    buildLikesUrl,
    makeAccountKey,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.SCShuffleCore;
  }
}());
