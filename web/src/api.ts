import { createClient } from 'graphql-ws';

const host = window.location.hostname || 'localhost';
const HTTP_URL = `http://${host}:4000/graphql`;
const WS_URL = `ws://${host}:4000/graphql`;

export async function requestGraphQL<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(HTTP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Server returned HTTP ${response.status}`);
  }
  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(result.errors[0].message);
  }
  return result.data as T;
}

type ConnectionListener = (connected: boolean, isReconnect: boolean) => void;
const connectionListeners = new Set<ConnectionListener>();
let connectedOnce = false;
let connected = false;
let pongTimeout: ReturnType<typeof setTimeout> | undefined;

export const wsClient = createClient({
  url: WS_URL,
  lazy: false,
  keepAlive: 10_000,
  retryAttempts: Infinity,
  shouldRetry: () => true,
  retryWait: async (attempt) => {
    const delay = Math.min(5000, 500 * 2 ** Math.min(attempt, 10));
    await new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random() / 2)));
  },
  on: {
    ping: (received) => {
      if (!received) pongTimeout = setTimeout(() => wsClient.terminate(), 5000);
    },
    pong: (received) => {
      if (received) clearTimeout(pongTimeout);
    },
    connected: () => {
      const isReconnect = connectedOnce;
      connectedOnce = true;
      connected = true;
      connectionListeners.forEach((listener) => listener(true, isReconnect));
    },
    closed: () => {
      clearTimeout(pongTimeout);
      connected = false;
      connectionListeners.forEach((listener) => listener(false, false));
    },
  },
});

export function onConnectionChange(listener: ConnectionListener) {
  connectionListeners.add(listener);
  listener(connected, false);
  return () => {
    connectionListeners.delete(listener);
  };
}

export function subscribe<T>(query: string, variables: Record<string, unknown>, onData: (data: T) => void) {
  return wsClient.subscribe<T>(
    { query, variables },
    {
      next: ({ data }) => data && onData(data as T),
      error: console.warn,
      complete: () => {},
    },
  );
}

export const DEVICE_ID = `web-${crypto.randomUUID()}`;

export type Sender = 'PATIENT' | 'AI' | 'STAFF' | 'SYSTEM';
export interface Message {
  id: string;
  clientId: string | null;
  seq: number;
  conversationId: string;
  sender: Sender;
  senderName: string | null;
  senderDeviceId: string | null;
  text: string;
  createdAt: string;
  status: 'SENT' | 'DELIVERED';
  readAt: string | null;
  translation?: { lang: string; text: string; translated: boolean };
}
export interface Conversation {
  id: string;
  patientName: string;
  mode: 'AI' | 'STAFF';
  staffName: string | null;
  aiTyping: boolean;
  updatedAt: string;
  lastMessage: Message | null;
}

const MESSAGE_CORE_FIELDS = `id clientId seq conversationId sender senderName senderDeviceId text createdAt status readAt`;
const MESSAGE_FIELDS = `${MESSAGE_CORE_FIELDS} translation(lang: $lang) { lang text translated }`;
const CONVERSATION_FIELDS = `id patientName mode staffName aiTyping updatedAt lastMessage { id text sender createdAt }`;

export const chatOperations = {
  latestVisit: `query($id: ID!) { conversation(id: $id) { id latestVisit { date treatment clinician } } }`,
  conversations: `query { conversations { ${CONVERSATION_FIELDS} } }`,
  languages: `query { languages { code label } }`,
  messagesCore: `query($conversationId: ID!, $before: Int) { messages(conversationId: $conversationId, beforeSeq: $before, limit: 30) { hasMore items { ${MESSAGE_CORE_FIELDS} } } }`,
  messages: `query($conversationId: ID!, $before: Int, $lang: String!) { messages(conversationId: $conversationId, beforeSeq: $before, limit: 30) { hasMore items { ${MESSAGE_FIELDS} } } }`,
  sendStaff: `mutation($input: SendMessageInput!, $staff: String!) { sendStaffMessage(input: $input, staffName: $staff) { ${MESSAGE_CORE_FIELDS} } }`,
  takeOver: `mutation($conversationId: ID!, $staff: String!) { takeOver(conversationId: $conversationId, staffName: $staff) { id mode staffName aiTyping } }`,
  handBack: `mutation($conversationId: ID!) { handBack(conversationId: $conversationId) { id mode staffName aiTyping } }`,
  markMessagesRead: `mutation($conversationId: ID!, $messageIds: [ID!]!) {
    markMessagesRead(conversationId: $conversationId, messageIds: $messageIds, readerRole: STAFF) { ${MESSAGE_CORE_FIELDS} }
  }`,
  markDelivered: `mutation($id: ID!, $deviceId: String!) { markDelivered(messageId: $id, deviceId: $deviceId) { id } }`,
  // Subscriptions omit translation so new messages appear immediately while translation loads.
  onMessageAdded: `subscription { onMessageAdded { ${MESSAGE_CORE_FIELDS} } }`,
  onMessageUpdated: `subscription { onMessageUpdated { ${MESSAGE_CORE_FIELDS} } }`,
  onConversationUpdated: `subscription { onConversationUpdated { ${CONVERSATION_FIELDS} } }`,
};
