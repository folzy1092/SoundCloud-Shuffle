(function (global) {
  if (!global.SCShuffleCore && typeof importScripts === 'function') {
    importScripts('shared-core.js');
  }

  const core = global.SCShuffleCore
    || (typeof require === 'function' ? require('./shared-core.js') : null);

  function syncError() {
    return new Error('Не удалось синхронизировать понравившиеся треки. Попробуйте ещё раз.');
  }

  function storageError() {
    return new Error('Не удалось обработать данные расширения. Попробуйте ещё раз.');
  }

  function payloadError() {
    return new Error('Не удалось подготовить данные треков для очереди. Синхронизируйте лайки и попробуйте ещё раз.');
  }

  function normalizeLike(like) {
    const track = like && like.track;
    const hasTrackId = track && (typeof track.id === 'number' || (typeof track.id === 'string' && track.id));
    const user = track && track.user;
    const hasUserId = user && (typeof user.id === 'number' || (typeof user.id === 'string' && user.id));
    if (!hasTrackId
      || typeof track.title !== 'string'
      || typeof track.permalink_url !== 'string'
      || !user
      || typeof user !== 'object'
      || Array.isArray(user)
      || !hasUserId
      || typeof user.username !== 'string'
      || !user.username
      || typeof track.policy !== 'string'
      || typeof track.state !== 'string'
      || typeof track.streamable !== 'boolean'
      || typeof like.created_at !== 'string') {
      throw syncError();
    }

    return {
      id: track.id,
      title: track.title,
      permalink_url: track.permalink_url,
      user: track.user,
      policy: track.policy,
      state: track.state,
      streamable: track.streamable,
      likedAt: like.created_at,
    };
  }

  async function syncLikes(context, dependencies) {
    const { accountId, userId, clientId } = context || {};
    if (!core || !accountId || !userId || !clientId || !dependencies || typeof dependencies.fetchJson !== 'function' || typeof dependencies.set !== 'function') {
      throw syncError();
    }

    const normalizedTracks = [];
    let nextHref = core.buildLikesUrl(null, clientId, userId);

    try {
      while (nextHref) {
        const page = await dependencies.fetchJson(nextHref);
        if (!page || typeof page !== 'object' || !Array.isArray(page.collection)) {
          throw syncError();
        }

        for (const like of page.collection) {
          normalizedTracks.push(normalizeLike(like));
        }

        if (page.next_href === undefined || page.next_href === null) {
          nextHref = null;
        } else if (typeof page.next_href === 'string' && page.next_href) {
          nextHref = core.buildLikesUrl(page.next_href, clientId, userId);
        } else {
          throw syncError();
        }
      }
    } catch (error) {
      throw syncError();
    }

    const eligibleTracks = normalizedTracks.filter(core.isEligibleTrack);
    const skippedCount = normalizedTracks.length - eligibleTracks.length;
    const syncedAt = dependencies.now ? dependencies.now() : new Date().toISOString();
    const cacheValue = {
      tracks: eligibleTracks,
      skippedCount,
      syncedAt,
      lastError: null,
    };

    try {
      await dependencies.set({ [core.makeAccountKey(accountId)]: cacheValue });
    } catch (error) {
      throw syncError();
    }

    return { accountId, eligibleTracks, skippedCount, syncedAt };
  }

  function validTrackId(value) {
    return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      || (typeof value === 'string' && /^[1-9]\d*$/.test(value));
  }

  async function fetchTrackPayloads(trackIds, clientId, fetcher) {
    if (!Array.isArray(trackIds)
      || trackIds.length === 0
      || trackIds.some((id) => !validTrackId(id))
      || new Set(trackIds.map(String)).size !== trackIds.length
      || typeof clientId !== 'string'
      || !clientId
      || typeof fetcher !== 'function') {
      throw payloadError();
    }

    const byId = new Map();
    const batchSize = 50;

    try {
      for (let index = 0; index < trackIds.length; index += batchSize) {
        const batch = trackIds.slice(index, index + batchSize);
        const ids = encodeURIComponent(batch.map(String).join(','));
        const url = `https://api-v2.soundcloud.com/tracks?ids=${ids}&client_id=${encodeURIComponent(clientId)}`;
        const payload = await fetcher(url);
        if (!Array.isArray(payload)) throw payloadError();
        for (const track of payload) {
          if (!track || typeof track !== 'object' || !validTrackId(track.id)) throw payloadError();
          byId.set(String(track.id), track);
        }
      }
    } catch (error) {
      throw payloadError();
    }

    const ordered = trackIds.map((id) => byId.get(String(id)));
    if (ordered.some((track) => !track)) throw payloadError();
    return ordered;
  }

  function fetchJson(url) {
    return fetch(url).then(async (response) => {
      if (!response.ok) {
        throw syncError();
      }
      return response.json();
    });
  }

  function storageGet(key) {
    return chrome.storage.local.get(key);
  }

  function storageSet(value) {
    return chrome.storage.local.set(value);
  }

  function storageRemove(key) {
    return chrome.storage.local.remove(key);
  }

  function registerMessageHandlers() {
    if (!global.chrome || !chrome.runtime || !chrome.runtime.onMessage) {
      return;
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const accountId = message && message.accountId;
      if (message && message.type === 'SYNC_LIKES') {
        syncLikes(message.context, { fetchJson, set: storageSet })
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      if (message && message.type === 'REQUEST_FULL_SHUFFLE') {
        const context = message.context || {};
        const key = context.accountId ? core.makeAccountKey(context.accountId) : null;
        if (!key || !context.userId || !context.clientId) {
          sendResponse({ ok: false, error: syncError().message });
          return false;
        }
        storageGet(key)
          .then(async (stored) => {
            let cache = stored && stored[key];
            if (!cache) {
              const synced = await syncLikes(context, { fetchJson, set: storageSet });
              cache = {
                tracks: synced.eligibleTracks,
                skippedCount: synced.skippedCount,
                syncedAt: synced.syncedAt,
                lastError: null,
              };
            }
            if (!Array.isArray(cache.tracks)
              || cache.tracks.some((track) => !track || track.id === undefined || !core.isEligibleTrack(track))) {
              throw syncError();
            }
            if (cache.tracks.length === 0) {
              throw new Error('Нет доступных лайкнутых треков для перемешивания.');
            }

            const tracks = core.shuffleTracks(cache.tracks);
            let payloads;
            if (message.includePayloads === true) {
              payloads = await fetchTrackPayloads(
                tracks.map((track) => track.id),
                context.clientId,
                fetchJson,
              );
            }

            sendResponse({
              ok: true,
              tracks,
              ...(payloads ? { payloads } : {}),
              skippedCount: Number.isInteger(cache.skippedCount) ? cache.skippedCount : 0,
              syncedAt: cache.syncedAt || null,
            });
          })
          .catch((error) => sendResponse({
            ok: false,
            error: error?.message || syncError().message,
          }));
        return true;
      }
      if (message && message.type === 'GET_STATUS' && accountId) {
        const key = core.makeAccountKey(accountId);
        storageGet(key)
          .then((value) => {
            const cache = value[key] || null;
            sendResponse({
              ok: true,
              status: cache ? {
                eligibleCount: Array.isArray(cache.tracks) ? cache.tracks.length : 0,
                skippedCount: Number.isInteger(cache.skippedCount) ? cache.skippedCount : 0,
                syncedAt: cache.syncedAt || null,
                lastError: cache.lastError || null,
              } : null,
            });
          })
          .catch(() => sendResponse({ ok: false, error: storageError().message }));
        return true;
      }
      if (message && message.type === 'CLEAR_ACCOUNT' && accountId) {
        storageRemove(core.makeAccountKey(accountId))
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false, error: storageError().message }));
        return true;
      }
      return false;
    });
  }

  const api = { syncLikes, normalizeLike, fetchTrackPayloads, registerMessageHandlers };
  global.SCShuffleBackground = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  registerMessageHandlers();
}(globalThis));
