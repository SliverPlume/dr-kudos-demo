import type { Message } from './api';

export type UiMessage = Message & { key: string; pending?: boolean; failed?: boolean };
export type Thread = { items: UiMessage[]; hasMore: boolean; oldestSeq?: number };

export function mergeMessage(messages: UiMessage[], message: Message, overrides: Partial<UiMessage> = {}): UiMessage[] {
  const key = message.clientId ?? message.id;
  const existingIndex = messages.findIndex((existingMessage) => existingMessage.key === key);
  const existing = existingIndex >= 0 ? messages[existingIndex] : undefined;
  const nextMessage: UiMessage = {
    ...(existing ?? {}),
    ...message,
    translation: message.translation ?? existing?.translation,
    key,
    pending: false,
    failed: false,
    ...overrides,
  };
  // A late mutation response must not overwrite a delivery receipt.
  if (existingIndex >= 0 && messages[existingIndex].status === 'DELIVERED') {
    nextMessage.status = 'DELIVERED';
  }
  nextMessage.readAt = (existingIndex >= 0 ? messages[existingIndex].readAt : null) ?? message.readAt;
  const updatedMessages = existingIndex >= 0
    ? messages.map((existingMessage, index) => (index === existingIndex ? nextMessage : existingMessage))
    : [...messages, nextMessage];
  return updatedMessages.sort((a, b) => (a.pending || a.failed ? 1e15 : a.seq) - (b.pending || b.failed ? 1e15 : b.seq));
}

export function mergePage(thread: Thread | undefined, items: Message[], oldestSeq: number | undefined, hasMore: boolean): Thread {
  const keepCursor = thread?.oldestSeq != null && (oldestSeq == null || thread.oldestSeq < oldestSeq);
  return {
    oldestSeq: keepCursor ? thread.oldestSeq : oldestSeq,
    hasMore: keepCursor ? thread.hasMore : hasMore,
    items: items.reduce<UiMessage[]>((all, message) => mergeMessage(all, message), thread?.items ?? []),
  };
}

export function mergeReceipt(threads: Record<string, Thread>, message: Message) {
  const thread = threads[message.conversationId];
  if (!thread?.items.some((item) => item.key === (message.clientId ?? message.id))) return threads;
  return { ...threads, [message.conversationId]: { ...thread, items: mergeMessage(thread.items, message) } };
}
