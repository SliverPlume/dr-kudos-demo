export type Sender = 'PATIENT' | 'AI' | 'STAFF' | 'SYSTEM';
export type ServerStatus = 'SENT' | 'DELIVERED';
/** Client-side superset: SENDING (clock) and FAILED exist only on the device. */
export type MessageStatus = 'SENDING' | 'FAILED' | ServerStatus;

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
  status: ServerStatus;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface Conversation {
  id: string;
  patientName: string;
  mode: 'AI' | 'STAFF';
  staffName: string | null;
  aiTyping: boolean;
}

/** What the UI renders: a server message or an optimistic local one. */
export interface ChatMessage extends Omit<Message, 'status' | 'seq'> {
  key: string;
  seq: number | null; // null until the server has saved it
  status: MessageStatus;
}

const MESSAGE_FIELDS = `id clientId seq conversationId sender senderName senderDeviceId text createdAt status deliveredAt readAt`;
const CONVERSATION_FIELDS = `id patientName mode staffName aiTyping`;

export const chatOperations = {
  conversation: `query($id: ID!) { conversation(id: $id) { ${CONVERSATION_FIELDS} } }`,
  messages: `query($conversationId: ID!, $before: Int, $limit: Int) {
    messages(conversationId: $conversationId, beforeSeq: $before, limit: $limit) { hasMore items { ${MESSAGE_FIELDS} } }
  }`,
  sendMessage: `mutation($input: SendMessageInput!) { sendMessage(input: $input) { ${MESSAGE_FIELDS} } }`,
  markMessagesRead: `mutation($conversationId: ID!, $messageIds: [ID!]!) {
    markMessagesRead(conversationId: $conversationId, messageIds: $messageIds, readerRole: PATIENT) { ${MESSAGE_FIELDS} }
  }`,
  markDelivered: `mutation($id: ID!, $deviceId: String!) { markDelivered(messageId: $id, deviceId: $deviceId) { id status } }`,
  onMessageAdded: `subscription($conversationId: ID!) { onMessageAdded(conversationId: $conversationId) { ${MESSAGE_FIELDS} } }`,
  onMessageUpdated: `subscription($conversationId: ID!) { onMessageUpdated(conversationId: $conversationId) { ${MESSAGE_FIELDS} } }`,
  onConversationUpdated: `subscription($id: ID) { onConversationUpdated(id: $id) { ${CONVERSATION_FIELDS} } }`,
};
