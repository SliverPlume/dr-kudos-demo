import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergePage, mergeReceipt } from '../src/thread.ts';

const message = (seq) => ({
  id: String(seq), conversationId: 'room', seq, clientId: null, sender: 'PATIENT',
  status: 'SENT', text: 'Hello', readAt: null, createdAt: '2026-01-01T00:00:00Z',
});
const page = (start) => Array.from({ length: 30 }, (_, i) => message(start + i));

test('an unloaded receipt cannot create a gap or change the pagination cursor', () => {
  const threads = { room: mergePage(undefined, page(71), 71, true) };
  assert.equal(mergeReceipt(threads, message(20)), threads);
  const loaded = mergeReceipt(threads, { ...message(80), readAt: '2026-01-02T00:00:00Z' }).room;
  assert.equal(loaded.items.find((item) => item.seq === 80).readAt, '2026-01-02T00:00:00Z');
  assert.equal(loaded.oldestSeq, 71);
  const older = mergePage(loaded, page(41), 41, true);
  const afterRefresh = mergePage(older, page(71), 71, true);
  assert.equal(afterRefresh.oldestSeq, 41);
  assert.deepEqual(afterRefresh.items.map((item) => item.seq), Array.from({length: 60}, (_, i) => 41 + i));
});
