/** Create more than one page while test clients are offline, then reconnect them. */
import { randomUUID } from 'node:crypto';

const endpoint = process.env.URL ?? 'http://localhost:4000/graphql';
const runId = randomUUID().slice(0, 8);

async function requestGraphQL(query: string, variables: Record<string, unknown> = {}) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (!response.ok || result.errors) throw new Error(JSON.stringify(result));
  return result.data;
}

await requestGraphQL('mutation { takeOver(conversationId: "conv-chloe", staffName: "Reconnect test") { id } }');
try {
  const texts = Array.from({ length: 36 }, (_, i) => `Reconnect ${runId} · ${String(i + 1).padStart(2, '0')}/36`);
  await Promise.all(texts.map(text => requestGraphQL(`mutation($input: SendMessageInput!) {
    sendStaffMessage(input: $input, staffName: "Reconnect test") { id }
  }`, { input: { conversationId: 'conv-chloe', clientId: randomUUID(), deviceId: 'reconnect-fixture', text } })));
  console.log(JSON.stringify({ runId, count: texts.length, texts }, null, 2));
} finally {
  await requestGraphQL('mutation { handBack(conversationId: "conv-chloe") { id } }');
}
