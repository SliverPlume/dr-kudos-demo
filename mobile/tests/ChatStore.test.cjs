/* global __dirname */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

// Run the actual store with a simulated transport, without loading native Expo
// modules in Node. TypeScript is already a project dependency.
function loadSource(relativePath, dependencies = {}) {
  const filename = path.join(__dirname, '..', relativePath);
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  const exports = {};
  new Function('require', 'exports', outputText)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

const types = loadSource('src/api/types.ts');
const operations = types.chatOperations;
const PAGE_SIZE = 15;
const makeMessage = (seq, overrides = {}) => ({
  id: `message-${seq}`, clientId: null, seq, conversationId: 'room',
  sender: 'AI', senderName: null, senderDeviceId: null, text: `Message ${seq}`,
  createdAt: new Date(1700000000000 + seq * 1000).toISOString(),
  status: 'DELIVERED', deliveredAt: '2026-11-17T00:00:00Z', readAt: null,
  ...overrides,
});

function setup(t) {
  const records = Array.from({ length: 60 }, (_, index) => makeMessage(index + 1));
  const subscriptions = new Map();
  const connections = new Set();
  const requests = [];
  let sendResponse;
  const broadcast = (operation, field, message) => {
    for (const callback of subscriptions.get(operation) ?? []) callback({ [field]: { ...message } });
  };
  const api = {
    subscribe(operation, variables, callback) {
      if (!subscriptions.has(operation)) subscriptions.set(operation, new Set());
      subscriptions.get(operation).add(callback);
      return () => subscriptions.get(operation).delete(callback);
    },
    onConnectionChange(callback) {
      connections.add(callback);
      return () => connections.delete(callback);
    },
    async requestGraphQL(operation, variables) {
      requests.push({ operation, variables });
      if (operation === operations.conversation) return { conversation: { id: 'room', mode: 'AI', aiTyping: false } };
      if (operation === operations.messages) {
        const eligible = records.filter((message) => variables.before == null || message.seq < variables.before);
        return { messages: { items: eligible.slice(-variables.limit).map((message) => ({ ...message })), hasMore: eligible.length > variables.limit } };
      }
      if (operation === operations.markMessagesRead) {
        const changed = records.filter((message) => variables.messageIds.includes(message.id) && !message.readAt);
        changed.forEach((message) => {
          message.readAt = '2026-11-17T01:00:00Z';
          broadcast(operations.onMessageUpdated, 'onMessageUpdated', message);
        });
        return { markMessagesRead: changed.map((message) => ({ ...message })) };
      }
      if (operation === operations.sendMessage) {
        return new Promise((resolve) => { sendResponse = resolve; });
      }
      throw new Error(`Unexpected operation: ${operation}`);
    },
  };
  const { ChatStore } = loadSource('src/chat/ChatStore.ts', {
    'expo-crypto': { randomUUID }, '../api/client': api,
    '../api/types': types, '../config': { PAGE_SIZE },
  });
  const stores = [new ChatStore('room', 'A'), new ChatStore('room', 'B')];
  t.after(() => stores.forEach((store) => store.stop()));
  return {
    records, requests, stores,
    async start() {
      stores.forEach((store) => store.start());
      await new Promise((resolve) => setImmediate(resolve));
      stores.forEach((store) => assert.equal(store.getState().initialLoading, false));
    },
    update: (message) => broadcast(operations.onMessageUpdated, 'onMessageUpdated', message),
    add: (message) => broadcast(operations.onMessageAdded, 'onMessageAdded', message),
    finishSend: (message) => sendResponse({ sendMessage: message }),
    reconnect: () => connections.forEach((callback) => callback('connected')),
  };
}

test('another device reading multiple history pages does not expand local history or skip pages', async (t) => {
  const fixture = setup(t);
  await fixture.start();
  const [a, b] = fixture.stores;
  const original = b.getState();
  let notifications = 0;
  b.subscribe(() => notifications++);
  for (let page = 0; page < 2; page++) {
    await a.loadOlder();
    await a.markVisibleMessagesRead(a.getState().messages.filter((message) => message.seq < 46).map((message) => message.id));
  }
  assert.strictEqual(b.getState(), original);
  assert.equal(notifications, 0);
  assert.equal(b.getState().hasMore, true);
  assert.equal(b.getState().messages[0].seq, 46);
  assert.equal(b.getState().messages.length, PAGE_SIZE);

  fixture.requests.length = 0;
  await b.loadOlder();
  assert.equal(fixture.requests[0].variables.before, 46);
  assert.deepEqual(b.getState().messages.map((message) => message.seq), Array.from({ length: 30 }, (_, index) => index + 31));
  assert.ok(b.getState().messages.slice(0, PAGE_SIZE).every((message) => message.readAt));
  await b.loadOlder();
  await b.loadOlder();
  assert.equal(b.getState().hasMore, false);
  assert.deepEqual(b.getState().messages.map((message) => message.seq), Array.from({ length: 60 }, (_, index) => index + 1));
});

test('loaded receipts synchronize once, preserving references for repeated or stale receipts', async (t) => {
  const fixture = setup(t);
  await fixture.start();
  const [a, b] = fixture.stores;
  const untouched = b.getState().messages[1];
  let aNotifications = 0;
  let bNotifications = 0;
  a.subscribe(() => aNotifications++);
  b.subscribe(() => bNotifications++);
  await a.markVisibleMessagesRead(['message-46']);
  assert.equal(aNotifications, 1); // subscription + HTTP response, one effective change
  assert.equal(bNotifications, 1);
  assert.ok(b.getState().messages[0].readAt);
  assert.strictEqual(b.getState().messages[1], untouched);
  const state = b.getState();
  fixture.update(fixture.records[45]);
  fixture.update(makeMessage(46, { status: 'SENT', deliveredAt: null }));
  assert.strictEqual(b.getState(), state);
  assert.equal(bNotifications, 1);
});

test('new messages insert, optimistic updates match clientId and delayed send responses cannot regress receipts', async (t) => {
  const fixture = setup(t);
  await fixture.start();
  const [a, b] = fixture.stores;
  fixture.add(makeMessage(61));
  assert.equal(b.getState().messages.at(-1).seq, 61);
  a.send('hello');
  const optimistic = a.getState().messages.at(-1);
  const saved = makeMessage(62, {
    clientId: optimistic.clientId, sender: 'PATIENT', senderDeviceId: 'A', text: 'hello',
    readAt: '2026-11-17T02:00:00Z',
  });
  fixture.update(saved);
  assert.equal(a.getState().messages.at(-1).id, saved.id);
  assert.equal(a.getState().messages.at(-1).key, optimistic.key);
  assert.equal(b.getState().messages.at(-1).seq, 61);
  const confirmed = a.getState().messages;
  fixture.add(saved);
  assert.strictEqual(a.getState().messages, confirmed);
  assert.equal(b.getState().messages.at(-1).seq, 62);
  fixture.finishSend({ ...saved, status: 'SENT', deliveredAt: null, readAt: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(a.getState().messages, confirmed);
});

test('reconnect fills offline gaps while preserving the loaded history and updated receipts', async (t) => {
  const fixture = setup(t);
  await fixture.start();
  const [a] = fixture.stores;
  await a.loadOlder();
  fixture.records[30].readAt = '2026-11-17T03:00:00Z';
  fixture.records.push(...Array.from({ length: 20 }, (_, index) => makeMessage(index + 61)));
  fixture.reconnect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await a.resync();
  // Snapshot recovery uses full pages, including the page crossing the old cursor.
  assert.deepEqual(a.getState().messages.map((message) => message.seq), Array.from({ length: 60 }, (_, index) => index + 21));
  assert.ok(a.getState().messages.find((message) => message.seq === 31).readAt);
  const messages = a.getState().messages;
  await a.resync();
  assert.strictEqual(a.getState().messages, messages);
});
