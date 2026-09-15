(function (global) {
  const SHUFFLE_SELECTOR = '.playControls__shuffle.playControls__control, .shuffleControl';
  const genericError = 'Не удалось выполнить полное перемешивание. Попробуйте ещё раз.';
  const contextError = 'Не удалось получить данные SoundCloud. Обновите страницу и попробуйте ещё раз.';

  function makeRequestId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return `scshuffle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function domRequest(document, requestType, responseType, detail, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const requestId = makeRequestId();
      let timer;
      const onResult = (event) => {
        if (!event || !event.detail || event.detail.requestId !== requestId) return;
        clearTimeout(timer);
        document.removeEventListener(responseType, onResult);
        resolve(event.detail);
      };
      document.addEventListener(responseType, onResult);
      timer = setTimeout(() => {
        document.removeEventListener(responseType, onResult);
        reject(new Error(genericError));
      }, timeoutMs);
      document.dispatchEvent(new global.CustomEvent(requestType, {
        detail: { ...(detail || {}), requestId },
      }));
    });
  }

  async function requestPageContext(document) {
    const result = await domRequest(
      document,
      'scshuffle:get-context',
      'scshuffle:context-result',
      {},
    );
    if (!result || !result.ok || !result.context) {
      throw new Error(result?.error || contextError);
    }
    return result.context;
  }

  async function replacePageQueue(document, trackIds) {
    const result = await domRequest(
      document,
      'scshuffle:replace-queue',
      'scshuffle:queue-result',
      { trackIds },
      35000,
    );
    if (!result || !result.ok) {
      throw new Error(result?.error || genericError);
    }
    return result;
  }

  function runtimeRequest(message) {
    return new Promise((resolve, reject) => {
      if (!global.chrome?.runtime?.sendMessage) {
        reject(new Error(genericError));
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(genericError));
          return;
        }
        resolve(response);
      });
    });
  }

  function normalizeError(error) {
    const message = error && typeof error.message === 'string' ? error.message.trim() : '';
    return message || genericError;
  }

  function installShuffleInterceptor(options = {}) {
    const document = options.document;
    if (!document || typeof document.addEventListener !== 'function') {
      throw new Error('document is required');
    }

    const request = options.request || runtimeRequest;
    const requestContext = options.requestContext || (() => requestPageContext(document));
    const replaceQueue = options.replaceQueue || ((trackIds) => replacePageQueue(document, trackIds));
    const scheduleReset = options.scheduleReset || ((fn) => setTimeout(fn, 2200));
    const MutationObserverCtor = options.MutationObserver
      || global.MutationObserver;

    let busy = false;
    let activeButton = null;
    let activeStatus = null;
    let resetGeneration = 0;
    const originals = new WeakMap();

    function remember(button) {
      if (!button || originals.has(button)) return;
      originals.set(button, {
        title: typeof button.title === 'string' ? button.title : '',
        ariaBusy: button.getAttribute?.('aria-busy'),
      });
    }

    function applyState(button) {
      if (!button || !activeStatus) return;
      remember(button);
      button.title = activeStatus;
      if (busy) button.setAttribute?.('aria-busy', 'true');
      else button.removeAttribute?.('aria-busy');
    }

    function applyToVisibleButtons() {
      const buttons = typeof document.querySelectorAll === 'function'
        ? document.querySelectorAll(SHUFFLE_SELECTOR)
        : [];
      for (const button of buttons) applyState(button);
    }

    function setStatus(button, text, isBusy) {
      activeButton = button || activeButton;
      activeStatus = text;
      busy = Boolean(isBusy);
      if (activeButton) applyState(activeButton);
      applyToVisibleButtons();
    }

    function restoreButton(button) {
      if (!button) return;
      const original = originals.get(button);
      if (!original) return;
      button.title = original.title;
      if (original.ariaBusy === null || original.ariaBusy === undefined) {
        button.removeAttribute?.('aria-busy');
      } else {
        button.setAttribute?.('aria-busy', original.ariaBusy);
      }
      originals.delete(button);
    }

    function restoreAll() {
      if (activeButton) restoreButton(activeButton);
      const buttons = typeof document.querySelectorAll === 'function'
        ? document.querySelectorAll(SHUFFLE_SELECTOR)
        : [];
      for (const button of buttons) restoreButton(button);
      activeButton = null;
      activeStatus = null;
      busy = false;
    }

    async function onClick(event) {
      const button = event?.target?.closest?.(SHUFFLE_SELECTOR);
      if (!button) return;

      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      if (busy) return;

      const generation = ++resetGeneration;
      try {
        setStatus(button, 'Синхронизация…', true);
        const context = await requestContext();
        const response = await request({ type: 'REQUEST_FULL_SHUFFLE', context });
        if (!response?.ok) throw new Error(response?.error || genericError);
        if (!Array.isArray(response.tracks) || response.tracks.length === 0) {
          throw new Error('Нет доступных лайкнутых треков для перемешивания.');
        }

        setStatus(button, 'Перемешивание…', true);
        const result = await replaceQueue(response.tracks.map((track) => track.id));
        if (!result?.ok) throw new Error(result?.error || genericError);
        setStatus(button, `Перемешано: ${result.queuedCount} треков`, false);
      } catch (error) {
        setStatus(button, normalizeError(error), false);
      } finally {
        busy = false;
        if (activeButton) activeButton.removeAttribute?.('aria-busy');
        scheduleReset(() => {
          if (generation === resetGeneration) restoreAll();
        });
      }
    }

    document.addEventListener('click', onClick, true);

    let observer = null;
    if (typeof MutationObserverCtor === 'function' && document.documentElement) {
      observer = new MutationObserverCtor(() => {
        if (activeStatus) applyToVisibleButtons();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    return {
      destroy() {
        document.removeEventListener?.('click', onClick, true);
        observer?.disconnect?.();
        restoreAll();
      },
      isBusy() { return busy; },
    };
  }

  function registerPopupContextHandler(document) {
    if (!global.chrome?.runtime?.onMessage) return;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== 'GET_PAGE_CONTEXT') return false;
      requestPageContext(document)
        .then((context) => sendResponse({ ok: true, context }))
        .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
      return true;
    });
  }

  const api = {
    installShuffleInterceptor,
    requestPageContext,
    replacePageQueue,
    registerPopupContextHandler,
  };

  global.SCShuffleContent = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (global.document && global.chrome?.runtime) {
    installShuffleInterceptor({ document: global.document });
    registerPopupContextHandler(global.document);
  }
}(globalThis));
