const test = require('node:test');
const assert = require('node:assert/strict');

const { installShuffleInterceptor } = require('../extension/content.js');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeButton(className = 'playControls__shuffle playControls__control') {
  const attrs = new Map();
  return {
    title: 'Shuffle',
    closest(selector) {
      return selector.split(',').some((part) => {
        const value = part.trim();
        return (value === '.playControls__shuffle.playControls__control'
          && className.includes('playControls__shuffle'))
          || (value === '.shuffleControl' && className.includes('shuffleControl'));
      }) ? this : null;
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
    getAttribute(name) { return attrs.get(name) ?? null; },
  };
}

function fakeDocument(button) {
  let clickListener;
  return {
    documentElement: {},
    addEventListener(type, listener, capture) {
      if (type === 'click') {
        assert.equal(capture, true);
        clickListener = listener;
      }
    },
    removeEventListener() {},
    querySelectorAll() { return [button]; },
    async click() {
      let prevented = false;
      let stopped = false;
      const event = {
        target: button,
        preventDefault() { prevented = true; },
        stopImmediatePropagation() { stopped = true; },
      };
      const pending = clickListener(event);
      return { pending, prevented, stopped };
    },
  };
}

test('prevents native shuffle and sends one full-shuffle request while busy', async () => {
  const gate = deferred();
  const calls = [];
  const button = fakeButton();
  const document = fakeDocument(button);
  const interceptor = installShuffleInterceptor({
    document,
    requestContext: async () => ({ accountId: '7', userId: '7', clientId: 'cid' }),
    request: async (message) => {
      calls.push(message);
      await gate.promise;
      return { ok: true, tracks: [{ id: 4 }, { id: 5 }] };
    },
    replaceQueue: async () => ({ ok: true, queuedCount: 2 }),
    scheduleReset: () => {},
  });

  const first = await document.click();
  const second = await document.click();
  assert.equal(first.prevented, true);
  assert.equal(first.stopped, true);
  assert.equal(second.prevented, true);
  assert.equal(second.stopped, true);
  assert.equal(calls.length, 1);
  assert.equal(button.getAttribute('aria-busy'), 'true');

  gate.resolve();
  await first.pending;
  assert.equal(calls.length, 1);
  interceptor.destroy();
});

test('passes shuffled track ids to the page bridge and restores busy state', async () => {
  const button = fakeButton();
  const document = fakeDocument(button);
  const queueCalls = [];
  const resets = [];
  installShuffleInterceptor({
    document,
    requestContext: async () => ({ accountId: '7', userId: '7', clientId: 'cid' }),
    request: async () => ({ ok: true, tracks: [{ id: 9 }, { id: 3 }], skippedCount: 2 }),
    replaceQueue: async (trackIds) => { queueCalls.push(trackIds); return { ok: true, queuedCount: 2 }; },
    scheduleReset: (fn) => { resets.push(fn); },
  });

  const click = await document.click();
  await click.pending;
  assert.deepEqual(queueCalls, [[9, 3]]);
  assert.match(button.title, /Перемешано/);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(resets.length, 1);
  resets[0]();
  assert.equal(button.title, 'Shuffle');
});

test('shows a Russian non-blocking error and never replaces on failed request', async () => {
  const button = fakeButton();
  const document = fakeDocument(button);
  let replacements = 0;
  const resets = [];
  installShuffleInterceptor({
    document,
    requestContext: async () => ({ accountId: '7', userId: '7', clientId: 'cid' }),
    request: async () => ({ ok: false, error: 'Не удалось синхронизировать понравившиеся треки.' }),
    replaceQueue: async () => { replacements += 1; },
    scheduleReset: (fn) => { resets.push(fn); },
  });

  const click = await document.click();
  await click.pending;
  assert.equal(replacements, 0);
  assert.match(button.title, /Не удалось синхронизировать/);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(resets.length, 1);
});

test('intercepts the alternate .shuffleControl selector used by current SoundCloud UI variants', async () => {
  const button = fakeButton('shuffleControl');
  const document = fakeDocument(button);
  let requests = 0;
  installShuffleInterceptor({
    document,
    requestContext: async () => ({ accountId: '7', userId: '7', clientId: 'cid' }),
    request: async () => { requests += 1; return { ok: true, tracks: [{ id: 2 }] }; },
    replaceQueue: async () => ({ ok: true, queuedCount: 1 }),
    scheduleReset: () => {},
  });

  const click = await document.click();
  await click.pending;
  assert.equal(click.prevented, true);
  assert.equal(requests, 1);
});
