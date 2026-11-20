import { createPubSub } from 'graphql-yoga';
import type { Conversation, Message } from './db.ts';

export const pubSub = createPubSub<{
  messageAdded: [Message];
  messageUpdated: [Message];
  conversationUpdated: [Conversation];
}>();
