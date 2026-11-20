import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

// Exercise the send/reply path without touching demo chats or a model provider.
process.env.DB_FILE = ':memory:';
process.env.AI_MIN_DELAY_MS = '0';
process.env.AI_MAX_DELAY_MS = '0';
process.env.SIMULATED_LATENCY_MS = '0';
process.env.AI_PROVIDER = 'openai';
process.env.CODEX_API_KEY = 'test';
process.env.CODEX_API_STYLE = 'chat';
const { db, repo } = await import('../src/db.ts');
const { seedDemoData } = await import('../src/seed.ts');
const { composeReply } = await import('../src/ai.ts');
const { resolvers } = await import('../src/resolvers.ts');

test('seed, read-only replies and conversation isolation', async (t) => {
  seedDemoData();
  const snapshot = () => ['clinical_visits', 'appointments', 'messages'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const first = snapshot();
  assert.deepEqual(first.slice(0, 2).map((rows) => rows.length), [6, 3]);
  seedDemoData(new Date(Date.now() + 86400000));
  assert.deepEqual(snapshot(), first);

  const chloe = repo.patientRecords('conv-chloe');
  const marcus = repo.patientRecords('conv-marcus');
  const sakura = repo.patientRecords('conv-sakura');
  assert.deepEqual(chloe.visits.map((v) => v.treatment), ['Emface', 'Emface']);
  assert.deepEqual(marcus.visits.map((v) => v.treatment), ['HIFU', 'Emface']);
  assert.deepEqual(sakura.visits.map((v) => v.treatment), ['Follow-up', 'Consultation']);
  assert.deepEqual([chloe, marcus, sakura].map((r) => r.nextAppointment?.startsAtHongKong.slice(-5)),
    ['11:30', '15:00', '10:30']);

  const systemPrompts: string[] = [];
  let failModel = false;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const request = JSON.parse(String(options.body));
    systemPrompts.push(request.messages[0].content);
    if (failModel) return new Response('test failure', { status: 500 });
    return Response.json({ choices: [{ message: { content: 'Test response' } }] });
  });
  async function send(conversationId: string, text: string) {
    const message = await resolvers.Mutation.sendMessage(null, {
      input: { conversationId, text, clientId: randomUUID(), deviceId: 'test' },
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      const last = repo.lastMessage(conversationId);
      if (last && last.seq > message.seq && last.sender === 'AI') return last.text;
      await sleep(10);
    }
    throw new Error('Missing AI reply');
  }

  for (const [id, records] of [['conv-chloe', chloe], ['conv-marcus', marcus], ['conv-sakura', sakura]] as const) {
    const question = id === 'conv-sakura' ? '我下次預約係幾時？' : '我上次幾時做 Emface？';
    const patientMessage = repo.insertMessage({ conversationId: id, sender: 'PATIENT', text: question });
    const offline = composeReply([patientMessage], records);
    if (id === 'conv-sakura') {
      assert.ok(offline.includes(records.nextAppointment!.startsAtHongKong));
      assert.ok(offline.includes('Dr. Chan') && offline.includes('諮詢'));
    } else {
      assert.ok(offline.includes(records.visits.find((v) => v.treatment === 'Emface')!.date));
      assert.ok(!offline.includes('三個月'));
    }
    failModel = false;
    await send(id, question);
    const prompt = systemPrompts.at(-1)!;
    const payload = prompt.split('Patient records: ')[1].split('\n')[0];
    assert.deepEqual(JSON.parse(payload), JSON.parse(JSON.stringify(records)));
    assert.match(prompt, /source of truth.*chat history disagrees/);
    for (const other of [chloe, marcus, sakura].filter((r) => r !== records)) {
      assert.ok(!payload.includes(other.nextAppointment!.clinician));
    }
    failModel = true;
    assert.equal(await send(id, question), offline);
  }

  assert.match(await send('conv-sakura', '我上次幾時做 Emface？'), /沒有符合/);
  assert.match(await send('conv-marcus', '我上次幾時做激光？'), /沒有符合/);
  const beforeChange = snapshot()[1];
  for (const question of ['幫我預約', '我想改期', '取消我的預約']) {
    assert.match(await send('conv-chloe', question), /職員確認/);
  }
  assert.deepEqual(snapshot()[1], beforeChange);
  // A later confirmed appointment must not displace the earlier one.
  db.exec(`INSERT INTO appointments (id, conversation_id, starts_at, service, clinician, status)
    SELECT 'later', conversation_id, datetime(starts_at, '+1 day'), service, clinician, status
    FROM appointments WHERE conversation_id = 'conv-sakura'`);
  assert.deepEqual(repo.patientRecords('conv-sakura').nextAppointment, sakura.nextAppointment);
  db.exec("UPDATE appointments SET status = 'cancelled' WHERE conversation_id = 'conv-chloe'");
  db.exec("UPDATE appointments SET starts_at = '2001-01-01T12:00:00+08:00' WHERE conversation_id = 'conv-marcus'");
  for (const id of ['conv-chloe', 'conv-marcus']) {
    assert.equal(repo.patientRecords(id).nextAppointment, null);
    assert.match(await send(id, '我下次預約係幾時？'), /沒有已確認/);
  }
  const edited = snapshot();
  seedDemoData();
  assert.deepEqual(snapshot(), edited);
});
