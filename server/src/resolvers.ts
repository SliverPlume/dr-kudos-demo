import { GraphQLError } from 'graphql';
import { filter, pipe } from 'graphql-yoga';
import { repo, transaction, type Conversation, type Message } from './db.ts';
import { pubSub } from './pubsub.ts';
import { cancelAiReply, scheduleAiReply } from './ai.ts';
import { phraseTranslator, translator, LANGUAGES } from './translate.ts';

const MAX_TEXT = 2000;
// Make the sending state visible even on localhost.
const SIMULATED_LATENCY_MS = Number(process.env.SIMULATED_LATENCY_MS ?? 700);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requireConversation(id: string): Conversation {
  const conversation = repo.getConversation(id);
  if (!conversation) {
    throw new GraphQLError(`Conversation ${id} not found`, { extensions: { code: 'NOT_FOUND' } });
  }
  return conversation;
}

function validateText(text: string) {
  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new GraphQLError('Message is empty', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (trimmedText.length > MAX_TEXT) {
    throw new GraphQLError('Message too long', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return trimmedText;
}

function postSystemMessage(conversationId: string, text: string) {
  const message = repo.insertMessage({ conversationId, sender: 'SYSTEM', senderDeviceId: 'server', text });
  pubSub.publish('messageAdded', message);
}

type SendInput = { conversationId: string; clientId: string; text: string; deviceId: string };

export const resolvers = {
  Query: {
    conversations: () => repo.listConversations(),
    conversation: (_: unknown, { id }: { id: string }) => repo.getConversation(id),
    messages: (
      _: unknown,
      { conversationId, beforeSeq, limit }: { conversationId: string; beforeSeq?: number; limit?: number },
    ) => repo.page(conversationId, beforeSeq ?? null, Math.min(Math.max(limit ?? 20, 1), 100)),
    languages: () => LANGUAGES,
  },

  Mutation: {
    sendMessage: async (_: unknown, { input }: { input: SendInput }) => {
      requireConversation(input.conversationId);
      const existingMessage = repo.findByClientId(input.clientId);
      if (existingMessage) return existingMessage;
      if (SIMULATED_LATENCY_MS) await sleep(SIMULATED_LATENCY_MS);
      // Another request with the same clientId may have saved during the await.
      const savedDuringDelay = repo.findByClientId(input.clientId);
      if (savedDuringDelay) return savedDuringDelay;

      const message = repo.insertMessage({
        conversationId: input.conversationId,
        clientId: input.clientId,
        sender: 'PATIENT',
        senderDeviceId: input.deviceId,
        text: validateText(input.text),
      });
      pubSub.publish('messageAdded', message);
      scheduleAiReply(input.conversationId);
      return message;
    },

    sendStaffMessage: async (_: unknown, { input, staffName }: { input: SendInput; staffName: string }) => {
      // A retry can arrive after staff has handed the conversation back to AI.
      const existingMessage = repo.findByClientId(input.clientId);
      if (existingMessage) return existingMessage;
      if (SIMULATED_LATENCY_MS) await sleep(SIMULATED_LATENCY_MS);
      const conversation = requireConversation(input.conversationId);
      if (conversation.mode !== 'STAFF') {
        throw new GraphQLError('Take over the conversation before replying', {
          extensions: { code: 'FORBIDDEN' },
        });
      }
      const savedDuringDelay = repo.findByClientId(input.clientId);
      if (savedDuringDelay) return savedDuringDelay;

      const message = repo.insertMessage({
        conversationId: input.conversationId,
        clientId: input.clientId,
        sender: 'STAFF',
        senderName: staffName,
        senderDeviceId: input.deviceId,
        text: validateText(input.text),
      });
      pubSub.publish('messageAdded', message);
      return message;
    },

    markDelivered: (_: unknown, { messageId, deviceId }: { messageId: string; deviceId: string }) => {
      const updated = repo.markDelivered(messageId, deviceId);
      if (updated) pubSub.publish('messageUpdated', updated);
      const message = updated ?? repo.getMessage(messageId);
      if (!message) {
        throw new GraphQLError('Message not found', { extensions: { code: 'NOT_FOUND' } });
      }
      return message;
    },

    markMessagesRead: (_: unknown, { conversationId, messageIds, readerRole }: {
      conversationId: string; messageIds: string[]; readerRole: 'PATIENT' | 'STAFF';
    }) => {
      requireConversation(conversationId);
      for (const id of new Set(messageIds)) {
        if (repo.getMessage(id)?.conversationId !== conversationId) {
          throw new GraphQLError('Message not found in this conversation', { extensions: { code: 'BAD_USER_INPUT' } });
        }
      }
      const updated = transaction(() => repo.markMessagesRead(messageIds, readerRole));
      updated.forEach((message) => pubSub.publish('messageUpdated', message));
      return updated;
    },

    takeOver: (_: unknown, { conversationId, staffName }: { conversationId: string; staffName: string }) => {
      const conversation = requireConversation(conversationId);
      if (conversation.mode === 'STAFF' && conversation.staffName === staffName) return conversation;
      cancelAiReply(conversationId);
      const updated = repo.setMode(conversationId, 'STAFF', staffName);
      pubSub.publish('conversationUpdated', updated);
      postSystemMessage(conversationId, `${staffName} from the clinic has joined the chat`);
      return updated;
    },

    handBack: (_: unknown, { conversationId }: { conversationId: string }) => {
      const conversation = requireConversation(conversationId);
      if (conversation.mode === 'AI') return conversation;
      const updated = repo.setMode(conversationId, 'AI', null);
      pubSub.publish('conversationUpdated', updated);
      postSystemMessage(conversationId, `${conversation.staffName ?? 'Staff'} handed the chat back to the AI assistant`);
      // Only messages after the last staff/AI reply remain unanswered.
      scheduleAiReply(conversationId);
      return repo.getConversation(conversationId)!;
    },
  },

  Subscription: {
    // Omitting a filter lets the clinic console listen to every conversation.
    onMessageAdded: {
      subscribe: (_: unknown, { conversationId }: { conversationId?: string }) =>
        pipe(
          pubSub.subscribe('messageAdded'),
          filter((message: Message) => !conversationId || message.conversationId === conversationId),
        ),
      resolve: (message: Message) => message,
    },
    onMessageUpdated: {
      subscribe: (_: unknown, { conversationId }: { conversationId?: string }) =>
        pipe(
          pubSub.subscribe('messageUpdated'),
          filter((message: Message) => !conversationId || message.conversationId === conversationId),
        ),
      resolve: (message: Message) => message,
    },
    onConversationUpdated: {
      subscribe: (_: unknown, { id }: { id?: string }) =>
        pipe(
          pubSub.subscribe('conversationUpdated'),
          filter((conversation: Conversation) => !id || conversation.id === id),
        ),
      resolve: (conversation: Conversation) => conversation,
    },
  },

  Message: {
    // The console only shows translations of patient messages, so only those use the model.
    translation: (message: Message, { lang }: { lang: string }) =>
      (message.sender === 'PATIENT' ? translator : phraseTranslator).translate(message.text, lang),
  },
  Conversation: {
    latestVisit: (conversation: Conversation) => repo.latestVisit(conversation.id),
    lastMessage: (conversation: Conversation) => repo.lastMessage(conversation.id),
  },
};
