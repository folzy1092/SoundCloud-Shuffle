(function () {
  const errors = {
    player: 'Не удалось подготовить очередь SoundCloud. Обновите страницу и попробуйте ещё раз.',
    context: 'Откройте «Нравится» и включите лайкнутый трек, затем повторите Shuffle.',
    population: 'Не удалось полностью загрузить «Нравится». Откройте «Нравится» и попробуйте ещё раз.',
    tracks: 'Набор треков устарел или пуст. Синхронизируйте лайки и повторите Shuffle.',
    changed: 'Текущий трек изменился во время подготовки. Повторите Shuffle.',
    pageContext: 'Не удалось получить данные аккаунта SoundCloud. Обновите страницу и попробуйте ещё раз.',
    foreignLikes: 'Откройте свои «Нравится» и включите лайкнутый трек.',
  };

  function validId(id) {
    return (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
      || (typeof id === 'string' && /^[1-9]\d*$/.test(id));
  }

  async function populateLikes(likes) {
    try {
      if (likes.isFullyPopulated() === true) return;
      if (typeof likes.bulkFetch !== 'function') throw new Error();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error()), 30000);
        const finish = (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        try {
          finish.success = () => finish();
          finish.error = () => finish(new Error());
          const pending = likes.bulkFetch(finish);
          if (pending && typeof pending.then === 'function') pending.then(() => finish(), finish);
          else if (pending && typeof pending.done === 'function' && typeof pending.fail === 'function') {
            pending.done(() => finish());
            pending.fail(() => finish(new Error()));
          }
        } catch (error) {
          finish(error);
        }
      });
      if (likes.isFullyPopulated() !== true) throw new Error();
    } catch {
      throw new Error(errors.population);
    }
  }

  function asId(value) {
    if ((typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      || (typeof value === 'string' && /^[1-9]\d*$/.test(value))) {
      return String(value);
    }
    return null;
  }

  function hydrationEntry(hydration, names) {
    if (!Array.isArray(hydration)) return null;
    const wanted = new Set(names);
    const entry = hydration.find((item) => item && wanted.has(item.hydratable));
    return entry?.data ?? null;
  }

  function firstNonEmptyString(values) {
    const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim());
    return value ? value.trim() : null;
  }

  function extractClientId(page) {
    const hydration = page?.__sc_hydration;
    const apiClient = hydrationEntry(hydration, ['apiClient', 'api_client']);
    return firstNonEmptyString([
      apiClient?.id,
      apiClient?.clientId,
      apiClient?.client_id,
      apiClient?.client?.id,
      apiClient?.client?.clientId,
      apiClient?.client?.client_id,
      apiClient?.data?.id,
      apiClient?.data?.clientId,
      apiClient?.data?.client_id,
      hydration?.apiClient?.id,
      hydration?.apiClient?.clientId,
      hydration?.apiClient?.client_id,
      page?.__sc_apiClient?.id,
      page?.__sc_apiClient?.clientId,
      page?.__sc_apiClient?.client_id,
      page?.__sc_client_id,
    ]);
  }

  function accountIdFromUser(user) {
    const candidates = [
      user?.id,
      user?.userId,
      user?.user_id,
      user?.user?.id,
      user?.profile?.id,
      user?.currentUser?.id,
      user?.current_user?.id,
      user?.data?.id,
    ];
    for (const candidate of candidates) {
      const id = asId(candidate);
      if (id) return id;
    }
    const urnCandidates = [
      user?.urn,
      user?.user?.urn,
      user?.profile?.urn,
      user?.currentUser?.urn,
      user?.current_user?.urn,
      user?.data?.urn,
    ];
    for (const urn of urnCandidates) {
      if (typeof urn !== 'string') continue;
      const match = urn.match(/(?:users?|user)[:/](\d+)/i);
      if (match) return asId(match[1]);
    }
    return null;
  }

  function extractAccountId(page) {
    const hydration = page?.__sc_hydration;
    const meUser = hydrationEntry(hydration, ['meUser', 'me', 'currentUser', 'current_user']);
    return accountIdFromUser(meUser)
      || accountIdFromUser(hydration?.meUser)
      || accountIdFromUser(hydration?.me)
      || accountIdFromUser(hydration?.currentUser)
      || accountIdFromUser(hydration?.current_user);
  }

  function sourceLikesUserId(player) {
    try {
      const current = player?.getCurrentQueueItem?.();
      const likes = current?.originalModel?.collection;
      const sourceInfo = likes?.getSourceInfo?.();
      if (sourceInfo?.type !== 'user-track_likes') return null;
      const candidates = [sourceInfo.resourceId, sourceInfo.userId, sourceInfo.user_id, sourceInfo.id];
      for (const candidate of candidates) {
        const id = asId(candidate);
        if (id) return id;
      }
      const urn = typeof sourceInfo.urn === 'string' ? sourceInfo.urn : '';
      const match = urn.match(/(?:users?|user)[:/](\d+)/i);
      return match ? asId(match[1]) : null;
    } catch {
      return null;
    }
  }

  function getPageContext(page, player) {
    const clientId = extractClientId(page);
    const accountId = extractAccountId(page);
    if (!clientId || !accountId) throw new Error(errors.pageContext);
    const sourceUserId = sourceLikesUserId(player);
    if (sourceUserId && sourceUserId !== accountId) throw new Error(errors.foreignLikes);
    return { accountId, userId: accountId, clientId };
  }

  async function waitForPageContext(page, player, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    do {
      try {
        return getPageContext(page, player);
      } catch (error) {
        lastError = error;
        if (error?.message === errors.foreignLikes) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw lastError || new Error(errors.pageContext);
  }

  function soundId(sound) {
    return asId(sound?.id) || asId(sound?.get?.('id'));
  }

  function soundFromPayload(current, payload) {
    if (!payload || typeof payload !== 'object' || !validId(payload.id)) {
      throw new Error(errors.tracks);
    }
    const SoundCtor = current?.sound?.constructor;
    if (typeof SoundCtor !== 'function') throw new Error(errors.player);
    let attrs = payload;
    try {
      if (typeof SoundCtor.normalize === 'function') attrs = SoundCtor.normalize(payload);
      const sound = new SoundCtor(attrs);
      if (soundId(sound) !== String(payload.id)) throw new Error();
      return sound;
    } catch {
      throw new Error(errors.player);
    }
  }

  async function replaceQueueFromPayloads({ player, tracks } = {}) {
    if (!player || ['getCurrentQueueItem', 'createExplicitQueueItem', 'replaceQueue']
      .some((name) => typeof player[name] !== 'function')) throw new Error(errors.player);
    if (!Array.isArray(tracks) || !tracks.length
      || tracks.some((track) => !track || !validId(track.id))
      || new Set(tracks.map((track) => String(track.id))).size !== tracks.length) {
      throw new Error(errors.tracks);
    }

    const current = player.getCurrentQueueItem();
    const currentId = soundId(current?.sound);
    const likes = current?.originalModel?.collection;
    if (!currentId || !likes || typeof likes.getSourceInfo !== 'function') {
      throw new Error(errors.context);
    }
    const sourceInfo = likes.getSourceInfo();
    if (sourceInfo?.type !== 'user-track_likes') throw new Error(errors.context);

    const items = tracks
      .filter((track) => String(track.id) !== currentId)
      .map((payload) => {
        const sound = soundFromPayload(current, payload);
        const item = player.createExplicitQueueItem(sound, sound, null);
        if (!item?.sound || soundId(item.sound) !== String(payload.id)) {
          throw new Error(errors.player);
        }
        return item;
      });

    if (player.getCurrentQueueItem() !== current) throw new Error(errors.changed);
    player.replaceQueue([current, ...items], 0, { pause: true });
    return { queuedCount: items.length };
  }

  async function replaceQueueFromLikes({ player, trackIds, tracks } = {}) {
    try {
      if (Array.isArray(tracks) && tracks.length > 0) {
        return await replaceQueueFromPayloads({ player, tracks });
      }

      if (!player || ['getCurrentQueueItem', 'createExplicitQueueItem', 'replaceQueue']
        .some((name) => typeof player[name] !== 'function')) throw new Error(errors.player);
      if (!Array.isArray(trackIds) || !trackIds.length || !trackIds.every(validId)
        || new Set(trackIds.map(String)).size !== trackIds.length) throw new Error(errors.tracks);

      const current = player.getCurrentQueueItem();
      const likes = current?.originalModel?.collection;
      if (!validId(current?.sound?.id) || !likes
        || ['audibleAt', 'getSoundIndex', 'getSourceInfo', 'isFullyPopulated']
          .some((name) => typeof likes[name] !== 'function')) throw new Error(errors.context);
      const sourceInfo = likes.getSourceInfo();
      if (sourceInfo?.type !== 'user-track_likes') throw new Error(errors.context);
      await populateLikes(likes);

      const byId = new Map();
      for (let index = 0; ; index += 1) {
        const sound = likes.audibleAt(index);
        if (!sound) break;
        if (!validId(sound.id) || byId.has(String(sound.id))) throw new Error(errors.tracks);
        byId.set(String(sound.id), sound);
      }
      const sounds = trackIds.filter((id) => String(id) !== String(current.sound.id))
        .map((id) => byId.get(String(id)));
      if (sounds.some((sound) => !sound)) throw new Error(errors.tracks);
      const items = sounds.map((sound) => {
        const item = player.createExplicitQueueItem(likes, sound, { sourceInfo });
        if (!item?.sound || String(item.sound.id) !== String(sound.id)) throw new Error(errors.player);
        return item;
      });
      if (player.getCurrentQueueItem() !== current) throw new Error(errors.changed);
      player.replaceQueue([current, ...items], 0, { pause: true });
      return { queuedCount: items.length };
    } catch (error) {
      throw new Error(Object.values(errors).includes(error?.message) ? error.message : errors.player);
    }
  }

  function unwrapModule(value, depth = 5) {
    if (!value || depth < 0) return value;
    if (value.exports && value.exports !== value) return unwrapModule(value.exports, depth - 1);
    if (value.A) return unwrapModule(value.A, depth - 1);
    if (value.Z) return unwrapModule(value.Z, depth - 1);
    if (value.ZP) return unwrapModule(value.ZP, depth - 1);
    if (value.__esModule && value.default) return unwrapModule(value.default, depth - 1);
    return value;
  }

  function isQueuePlayer(candidate) {
    const value = unwrapModule(candidate);
    return Boolean(value) && ['getCurrentQueueItem', 'createExplicitQueueItem', 'replaceQueue']
      .every((name) => typeof value[name] === 'function');
  }

  function findPlayerInRequire(requireModule) {
    if (typeof requireModule !== 'function') return null;

    const cached = requireModule.c;
    if (cached && typeof cached === 'object') {
      for (const module of Object.values(cached)) {
        const candidate = unwrapModule(module);
        if (isQueuePlayer(candidate)) return candidate;
      }
    }

    try {
      const legacy = unwrapModule(cached?.[20]?.exports || requireModule(20));
      if (isQueuePlayer(legacy)) return legacy;
    } catch {
      // SoundCloud no longer guarantees stable numeric module IDs.
    }

    const factories = requireModule.m;
    if (factories && typeof factories === 'object') {
      for (const id of Object.keys(factories)) {
        try {
          const candidate = unwrapModule(requireModule(id));
          if (isQueuePlayer(candidate)) return candidate;
        } catch {
          // Some modules require initialization state that is not available here.
        }
      }
    }
    return null;
  }

  function captureLegacyRequire(page) {
    let requireModule = null;
    let injectedId = null;
    try {
      injectedId = `scshuffle_bridge_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const modules = {
        [injectedId]: (module, _exports, runtime) => {
          if (typeof runtime === 'function') requireModule = runtime;
          if (module && typeof runtime === 'function') module.exports = runtime;
        },
      };
      if (typeof page.webpackJsonp === 'function') {
        page.webpackJsonp([], modules, [injectedId]);
      } else if (typeof page.webpackJsonp?.push === 'function') {
        const returned = page.webpackJsonp.push([[injectedId], modules, [[injectedId]]]);
        if (!requireModule && typeof returned === 'function') requireModule = returned;
        page.webpackJsonp.pop?.();
      }
      return requireModule;
    } catch {
      return null;
    } finally {
      if (requireModule?.m && injectedId) delete requireModule.m[injectedId];
      if (requireModule?.c && injectedId) delete requireModule.c[injectedId];
    }
  }

  function captureChunkRequire(chunkArray) {
    if (!chunkArray || typeof chunkArray.push !== 'function') return null;
    let requireModule = null;
    try {
      const id = `scshuffle_chunk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      chunkArray.push([
        [id],
        {},
        (runtime) => { if (typeof runtime === 'function') requireModule = runtime; },
      ]);
      chunkArray.pop?.();
    } catch {
      return null;
    }
    return requireModule;
  }

  function captureStandbyRequire(page) {
    try {
      const frame = page.document?.querySelector?.('iframe[src*="/n/pages/standby"]');
      return captureChunkRequire(frame?.contentWindow?.webpackChunk_N_E);
    } catch {
      return null;
    }
  }

  function capturePlayer(page) {
    const runtimes = [];
    const legacy = captureLegacyRequire(page);
    if (legacy) runtimes.push(legacy);

    const mainNext = captureChunkRequire(page.webpackChunk_N_E);
    if (mainNext && !runtimes.includes(mainNext)) runtimes.push(mainNext);

    const standby = captureStandbyRequire(page);
    if (standby && !runtimes.includes(standby)) runtimes.push(standby);

    for (const requireModule of runtimes) {
      const player = findPlayerInRequire(requireModule);
      if (player) return player;
    }
    throw new Error(errors.player);
  }

  function registerPageBridge(page) {
    if (page.location?.protocol !== 'https:'
      || !/(^|\.)soundcloud\.com$/.test(page.location?.hostname || '')) return;
    page.document.addEventListener('scshuffle:get-context', async (event) => {
      const { requestId } = event.detail || {};
      let result;
      try {
        let player = null;
        try { player = capturePlayer(page); } catch { player = null; }
        result = { requestId, ok: true, context: await waitForPageContext(page, player) };
      } catch (error) {
        result = { requestId, ok: false, error: error.message || errors.pageContext };
      }
      page.document.dispatchEvent(new page.CustomEvent('scshuffle:context-result', { detail: result }));
    });

    page.document.addEventListener('scshuffle:replace-queue', async (event) => {
      const { requestId, trackIds, tracks } = event.detail || {};
      let result;
      try {
        const player = capturePlayer(page);
        result = {
          requestId,
          ok: true,
          ...await replaceQueueFromLikes({ player, trackIds, tracks }),
        };
      } catch (error) {
        result = { requestId, ok: false, queuedCount: 0, error: error.message || errors.player };
      }
      page.document.dispatchEvent(new page.CustomEvent('scshuffle:queue-result', { detail: result }));
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      replaceQueueFromLikes,
      replaceQueueFromPayloads,
      getPageContext,
      capturePlayer,
    };
  }
  if (typeof window !== 'undefined' && window.document) registerPageBridge(window);
}());
