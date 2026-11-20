/**
 * End-to-end smoke test against a running server: `npm run smoke`
 * Exercises send -> ack, batching, typing, AI reply via subscription,
 * idempotent retry, delivery receipts, pagination and staff takeover.
 */
import { createClient } from 'graphql-ws';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const URL = process.env.URL ?? 'http://localhost:4000/graphql';
const CONVERSATION_ID = 'conv-chloe';

async function requestGraphQL<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const result = (await response.json()) as any;
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  return result.data;
}

const wsClient = createClient({ url: URL.replace(/^http/, 'ws'), webSocketImpl: WebSocket });
const events: string[] = [];
const log = (text: string) => {
  events.push(text);
  console.log(`${new Date().toISOString().slice(11, 23)}  ${text}`);
};

function subscribe(query: string, variables: Record<string, unknown>, onData: (data: any) => void) {
  return wsClient.subscribe({ query, variables }, { next: ({ data }) => onData(data), error: console.error, complete: () => {} });
}

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
};

const SEND_MESSAGE = `mutation($input: SendMessageInput!) { sendMessage(input: $input) { id clientId seq status readAt } }`;
const MIN_DELAY_MS = Number(process.env.AI_MIN_DELAY_MS ?? 3000);
const MAX_DELAY_MS = Number(process.env.AI_MAX_DELAY_MS ?? 10000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Start each run in AI mode with no unanswered patient messages or old timer.
await requestGraphQL(`mutation { takeOver(conversationId: "${CONVERSATION_ID}", staffName: "Smoke test") { mode } }`);
await requestGraphQL(`mutation($input: SendMessageInput!) { sendStaffMessage(input: $input, staffName: "Smoke test") { id } }`, {
  input: { conversationId: CONVERSATION_ID, clientId: randomUUID(), text: 'Starting verification.', deviceId: 'smoke-staff' },
});
await requestGraphQL(`mutation { handBack(conversationId: "${CONVERSATION_ID}") { mode } }`);

let aiReply: any = null;
let aiReceivedAt = 0;
const unsubscribeCallbacks = [
  subscribe(`subscription($conversationId: ID!) { onMessageAdded(conversationId: $conversationId) { id sender text status senderDeviceId } }`, { conversationId: CONVERSATION_ID }, (data) => {
    const message = data.onMessageAdded;
    log(`[device B] onMessageAdded ${message.sender}: ${message.text.slice(0, 50)}`);
    if (message.sender === 'AI') { aiReply = message; aiReceivedAt = Date.now(); }
    if (message.sender !== 'SYSTEM' && message.senderDeviceId !== 'device-B' && message.status === 'SENT') {
      requestGraphQL(`mutation($id: ID!) { markDelivered(messageId: $id, deviceId: "device-B") { id status } }`, { id: message.id }).catch(console.error);
    }
  }),
  subscribe(`subscription($conversationId: ID!) { onMessageUpdated(conversationId: $conversationId) { id status readAt } }`, { conversationId: CONVERSATION_ID }, (data) =>
    log(`[device A] onMessageUpdated ${data.onMessageUpdated.id.slice(0, 8)} -> ${data.onMessageUpdated.readAt ? "READ" : data.onMessageUpdated.status}`),
  ),
  subscribe(`subscription($conversationId: ID) { onConversationUpdated(id: $conversationId) { id aiTyping mode } }`, { conversationId: CONVERSATION_ID }, (data) =>
    log(`[device A] onConversationUpdated aiTyping=${data.onConversationUpdated.aiTyping} mode=${data.onConversationUpdated.mode}`),
  ),
];

await new Promise((resolve) => setTimeout(resolve, 500));

const firstClientId = randomUUID();
const firstResponse = await requestGraphQL(SEND_MESSAGE, { input: { conversationId: CONVERSATION_ID, clientId: firstClientId, text: 'Hi there', deviceId: 'device-A' } });
assert(firstResponse.sendMessage.status === 'SENT' && firstResponse.sendMessage.clientId === firstClientId, 'first message acked (one tick)');
const savedAt = Date.now();
const secondResponse = await requestGraphQL(SEND_MESSAGE, { input: { conversationId: CONVERSATION_ID, clientId: randomUUID(), text: 'How much is an Emface session?', deviceId: 'device-A' } });
const retry = await requestGraphQL(SEND_MESSAGE, { input: { conversationId: CONVERSATION_ID, clientId: firstClientId, text: 'Hi there', deviceId: 'device-A' } });
assert(retry.sendMessage.id === firstResponse.sendMessage.id, 'retry with same clientId is idempotent');

const READ = `mutation($conversationId: ID!, $messageIds: [ID!]!, $readerRole: ReaderRole!) {
  markMessagesRead(conversationId: $conversationId, messageIds: $messageIds, readerRole: $readerRole) { id readAt }
}`;
const read = async (messageIds: string[], readerRole = 'STAFF') => (await requestGraphQL(READ, { conversationId: CONVERSATION_ID, messageIds, readerRole })).markMessagesRead;
const snapshot = async () => (await requestGraphQL(`query { messages(conversationId: "${CONVERSATION_ID}", limit: 100) { items { id sender readAt status } } }`)).messages.items;
const patientIds = [firstResponse.sendMessage.id, secondResponse.sendMessage.id];
assert((await read(patientIds, 'PATIENT')).length === 0, 'same patient on another device cannot mark patient messages read');
assert((await snapshot()).filter((message: any) => patientIds.includes(message.id)).every((message: any) => !message.readAt), 'typing and transport delivery do not mark read');

const start = Date.now();
while (!aiReply && Date.now() - start < MAX_DELAY_MS + 2000) await new Promise((resolve) => setTimeout(resolve, 100));
const waited = (Date.now() - start) / 1000;
assert(aiReply, `AI reply arrived via subscription after ~${waited.toFixed(1)}s`);
assert(aiReceivedAt - savedAt >= MIN_DELAY_MS - 150 && aiReceivedAt - savedAt <= MAX_DELAY_MS + 1000,
  `AI delay is within configured ${MIN_DELAY_MS}–${MAX_DELAY_MS} ms window`);
assert(events.some((event) => event.includes('aiTyping=true')), 'typing indicator was published');
assert(events.filter((event) => event.includes('AI:')).length === 1, 'two patient messages batched into one AI reply');
await new Promise((resolve) => setTimeout(resolve, 300));
assert(events.some((event) => event.includes('-> DELIVERED')), 'transport receipt published independently of read receipt');

const afterReply = await snapshot();
assert(patientIds.every((id) => afterReply.find((message: any) => message.id === id)?.readAt), 'AI reply marks every patient message in its batch read');
assert(!afterReply.find((message: any) => message.id === aiReply.id)?.readAt, 'AI reply remains unread without a patient visibility receipt');
assert((await read([aiReply.id], 'STAFF')).length === 0, 'staff cannot read their own side of a conversation');
assert((await read([aiReply.id], 'PATIENT')).length === 1, 'patient visibility marks an AI reply read');
assert((await read([aiReply.id], 'PATIENT')).length === 0, 'repeated receipt is a no-op');
assert(events.filter((event) => event.includes('-> READ')).length >= 2, 'read receipts are published to other devices');

const firstPage = await requestGraphQL(`query { messages(conversationId: "${CONVERSATION_ID}", limit: 10) { hasMore items { seq } } }`);
const oldest = firstPage.messages.items[0].seq;
const olderPage = await requestGraphQL(`query($beforeSeq: Int) { messages(conversationId: "${CONVERSATION_ID}", beforeSeq: $beforeSeq, limit: 10) { hasMore items { seq } } }`, { beforeSeq: oldest });
assert(firstPage.messages.hasMore && olderPage.messages.items.length > 0 && olderPage.messages.items.every((message: any) => message.seq < oldest), 'pagination returns nonempty, strictly older messages');

// Cancel an already-pending AI reply, then wait past its maximum deadline.
const cancelled = await requestGraphQL(SEND_MESSAGE, { input: { conversationId: CONVERSATION_ID, clientId: randomUUID(), text: 'Can I book Saturday?', deviceId: 'device-A' } });
await requestGraphQL(`mutation { takeOver(conversationId: "${CONVERSATION_ID}", staffName: "Amy") { mode } }`);
aiReply = null;
await requestGraphQL(SEND_MESSAGE, { input: { conversationId: CONVERSATION_ID, clientId: randomUUID(), text: 'Are you a real person?', deviceId: 'device-A' } });
await sleep(MAX_DELAY_MS + 250);
assert(!aiReply, 'takeover cancels pending timer and pauses AI beyond its deadline');
assert(!(await snapshot()).find((message: any) => message.id === cancelled.sendMessage.id)?.readAt, 'cancelled AI reply does not mark read');
const otherRoom = await requestGraphQL(`query { messages(conversationId: "conv-marcus", limit: 1) { items { id } } }`);
for (const invalidId of ['missing-message', otherRoom.messages.items[0].id]) {
  let rejected = false;
  try { await read([cancelled.sendMessage.id, invalidId]); } catch { rejected = true; }
  assert(rejected, 'invalid or cross-room ID rejects the entire batch');
  assert(!(await snapshot()).find((message: any) => message.id === cancelled.sendMessage.id)?.readAt, 'rejected batch leaves valid messages unchanged');
}
assert((await read([cancelled.sendMessage.id, cancelled.sendMessage.id])).length === 1, 'staff read is deduplicated within a batch');
assert((await read([cancelled.sendMessage.id])).length === 0, 'repeated staff read does not change its timestamp');
const systemId = (await snapshot()).find((message: any) => message.sender === 'SYSTEM').id;
assert((await read([systemId])).length === 0, 'system messages are never marked read');
const paused = await requestGraphQL(`query { conversation(id: "${CONVERSATION_ID}") { mode aiTyping } }`);
assert(paused.conversation.mode === 'STAFF' && !paused.conversation.aiTyping, 'staff mode clears typing indicator');
const staffClientId = randomUUID();
await requestGraphQL(`mutation($input: SendMessageInput!) { sendStaffMessage(input: $input, staffName: "Amy") { id } }`, {
  input: { conversationId: CONVERSATION_ID, clientId: staffClientId, text: 'Yes! This is Amy from the clinic.', deviceId: 'web' },
});
await requestGraphQL(SEND_MESSAGE, { input: { conversationId: CONVERSATION_ID, clientId: randomUUID(), text: 'Thank you!', deviceId: 'device-A' } });
await requestGraphQL(`mutation { handBack(conversationId: "${CONVERSATION_ID}") { mode } }`);
assert(events.some((event) => event.includes('mode=STAFF')) && events.some((event) => event.includes('STAFF: Yes!')), 'staff takeover + reply pushed live');
const resumed = Date.now();
while (!aiReply && Date.now() - resumed < MAX_DELAY_MS + 2000) await sleep(100);
assert(aiReply, 'handback resumes AI for messages received while staff was handling chat');
const staffRetry = await requestGraphQL(`mutation($input: SendMessageInput!) { sendStaffMessage(input: $input, staffName: "Amy") { clientId } }`, {
  input: { conversationId: CONVERSATION_ID, clientId: staffClientId, text: 'Yes! This is Amy from the clinic.', deviceId: 'web' },
});
assert(staffRetry.sendStaffMessage.clientId === staffClientId, 'staff retry remains idempotent after handback');

const translationResponse = await requestGraphQL(`query { messages(conversationId: "conv-sakura", limit: 2) { items { text translation(lang: "en") { text translated } } } }`);
assert(translationResponse.messages.items[0].translation.translated && translationResponse.messages.items[0].translation.text === 'Can I reschedule my appointment?', 'offline Japanese → English translation matches dictionary');

unsubscribeCallbacks.forEach((unsubscribe) => unsubscribe());
await wsClient.dispose();
console.log('\nAll checks passed.');
process.exit(0);
