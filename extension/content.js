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
    let notice = null;
    let noticeTimer = null;
    const originals = new WeakMap();

    function ensureNotice() {
      if (notice?.isConnected) return notice;
      if (typeof document.createElement !== 'function') return null;
      const host = document.body || document.documentElement;
      if (!host?.appendChild) return null;
      notice = document.createElement('div');
      notice.id = 'scshuffle-status';
      notice.setAttribute?.('role', 'status');
      notice.style.position = 'fixed';
      notice.style.left = '50%';
      notice.style.bottom = '74px';
      notice.style.transform = 'translateX(-50%)';
      notice.style.zIndex = '2147483647';
      notice.style.maxWidth = 'min(520px, calc(100vw - 32px))';
      notice.style.padding = '10px 14px';
      notice.style.borderRadius = '8px';
      notice.style.background = 'rgba(20, 20, 20, .96)';
      notice.style.color = '#fff';
      notice.style.font = '600 13px/1.35 system-ui, sans-serif';
      notice.style.boxShadow = '0 8px 28px rgba(0,0,0,.35)';
      notice.style.pointerEvents = 'none';
      notice.style.opacity = '0';
      notice.style.transition = 'opacity .15s ease';
      host.appendChild(notice);
      return notice;
    }

    function showNotice(text, isError = false, autoHideMs = 0) {
      const element = ensureNotice();
      if (!element) return;
      if (noticeTimer) clearTimeout(noticeTimer);
      element.textContent = text;
      element.style.border = `1px solid ${isError ? 'rgba(255,90,90,.55)' : 'rgba(255,85,0,.55)'}`;
      element.style.opacity = '1';
      if (autoHideMs > 0) {
        noticeTimer = setTimeout(() => {
          if (notice) notice.style.opacity = '0';
        }, autoHideMs);
      }
    }

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
        showNotice('SoundCloud Shuffle: подготавливаю все лайки…');
        const context = await requestContext();
        const response = await request({ type: 'REQUEST_FULL_SHUFFLE', context });
        if (!response?.ok) throw new Error(response?.error || genericError);
        if (!Array.isArray(response.tracks) || response.tracks.length === 0) {
          throw new Error('Нет доступных лайкнутых треков для перемешивания.');
        }

        setStatus(button, 'Перемешивание…', true);
        showNotice(`SoundCloud Shuffle: перемешиваю ${response.tracks.length} треков…`);
        const result = await replaceQueue(response.tracks.map((track) => track.id));
        if (!result?.ok) throw new Error(result?.error || genericError);
        const successText = `Перемешано: ${result.queuedCount} треков`;
        setStatus(button, successText, false);
        showNotice(`SoundCloud Shuffle: ${successText}`, false, 2600);
      } catch (error) {
        const message = normalizeError(error);
        setStatus(button, message, false);
        showNotice(`SoundCloud Shuffle: ${message}`, true, 5000);
        console.error('[SoundCloud Shuffle]', error);
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
        if (noticeTimer) clearTimeout(noticeTimer);
        notice?.remove?.();
        notice = null;
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
