(function (global) {
  const genericError = 'Не удалось получить состояние расширения. Откройте SoundCloud и попробуйте ещё раз.';

  function defaultFormatDate(value) {
    if (!value) return 'не указано';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'не указано';
    return new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(date);
  }

  function renderStatus(status, root, formatDate = defaultFormatDate) {
    const target = root || global.document?.createElement?.('div') || { textContent: '' };
    if (!status) {
      target.textContent = 'Кэш ещё не создан.\nНажмите «Синхронизировать».';
      return target;
    }
    const eligibleCount = Number.isInteger(status.eligibleCount) ? status.eligibleCount : 0;
    const skippedCount = Number.isInteger(status.skippedCount) ? status.skippedCount : 0;
    const lines = [
      `${eligibleCount} доступных треков`,
      `Пропущено: ${skippedCount}`,
      `Последняя синхронизация: ${formatDate(status.syncedAt)}`,
    ];
    if (status.lastError) lines.push(`Ошибка: ${status.lastError}`);
    target.textContent = lines.join('\n');
    return target;
  }

  function normalizeError(error) {
    return error && typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : genericError;
  }

  function createPopupController(options) {
    const {
      statusRoot,
      syncButton,
      clearButton,
      getContext,
      sendMessage,
      formatDate = defaultFormatDate,
    } = options;
    let context = null;
    let busy = false;

    function setBusy(value) {
      busy = Boolean(value);
      syncButton.disabled = busy || !context;
      clearButton.disabled = busy || !context;
    }

    function showError(error) {
      statusRoot.textContent = normalizeError(error);
    }

    async function start() {
      setBusy(true);
      try {
        context = await getContext();
        if (!context?.accountId || !context?.userId || !context?.clientId) {
          throw new Error(genericError);
        }
        const response = await sendMessage({ type: 'GET_STATUS', accountId: context.accountId });
        if (!response?.ok) throw new Error(response?.error || genericError);
        renderStatus(response.status, statusRoot, formatDate);
      } catch (error) {
        context = null;
        showError(error);
      } finally {
        setBusy(false);
      }
    }

    async function sync() {
      if (busy || !context) return;
      setBusy(true);
      statusRoot.textContent = 'Синхронизация…';
      try {
        const response = await sendMessage({ type: 'SYNC_LIKES', context });
        if (!response?.ok) throw new Error(response?.error || genericError);
        renderStatus({
          eligibleCount: Array.isArray(response.eligibleTracks) ? response.eligibleTracks.length : 0,
          skippedCount: response.skippedCount,
          syncedAt: response.syncedAt,
          lastError: null,
        }, statusRoot, formatDate);
      } catch (error) {
        showError(error);
      } finally {
        setBusy(false);
      }
    }

    async function clear() {
      if (busy || !context) return;
      setBusy(true);
      try {
        const response = await sendMessage({ type: 'CLEAR_ACCOUNT', accountId: context.accountId });
        if (!response?.ok) throw new Error(response?.error || genericError);
        statusRoot.textContent = 'Кэш очищен.\nПри следующем Shuffle лайки синхронизируются заново.';
      } catch (error) {
        showError(error);
      } finally {
        setBusy(false);
      }
    }

    syncButton.addEventListener?.('click', () => { void sync(); });
    clearButton.addEventListener?.('click', () => { void clear(); });
    setBusy(false);

    return { start, sync, clear };
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!global.chrome?.runtime?.sendMessage) {
        reject(new Error(genericError));
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(genericError));
        else resolve(response);
      });
    });
  }

  function activePageContext() {
    return new Promise((resolve, reject) => {
      if (!global.chrome?.tabs?.query || !global.chrome?.tabs?.sendMessage) {
        reject(new Error(genericError));
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !tabs?.[0]?.id) {
          reject(new Error(genericError));
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_PAGE_CONTEXT' }, (response) => {
          if (chrome.runtime.lastError || !response?.ok || !response.context) {
            reject(new Error(response?.error || genericError));
            return;
          }
          resolve(response.context);
        });
      });
    });
  }

  const api = { renderStatus, createPopupController, defaultFormatDate };
  global.SCShufflePopup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (global.document && global.chrome?.runtime) {
    global.document.addEventListener('DOMContentLoaded', () => {
      const statusRoot = global.document.getElementById('status');
      const syncButton = global.document.getElementById('sync');
      const clearButton = global.document.getElementById('clear');
      if (!statusRoot || !syncButton || !clearButton) return;
      const controller = createPopupController({
        statusRoot,
        syncButton,
        clearButton,
        getContext: activePageContext,
        sendMessage: runtimeMessage,
      });
      void controller.start();
    });
  }
}(globalThis));
