import * as Crypto from 'expo-crypto';
import { requestGraphQL, onConnectionChange, subscribe, type ConnectionState } from '../api/client';
import { chatOperations, type ChatMessage, type Conversation, type Message, type MessageStatus } from '../api/types';
import { PAGE_SIZE } from '../config';

export interface ChatState {
  messages: ChatMessage[];
  conversation: Conversation | null;
  connection: ConnectionState;
  initialLoading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  error: string | null;
}

const STATUS_RANK: Record<MessageStatus, number> = { FAILED: 0, SENDING: 0, SENT: 1, DELIVERED: 2 };

export class ChatStore {
  private messagesByKey = new Map<string, ChatMessage>();
  private readsInFlight = new Set<string>();
  private stopped = false;
  private listeners = new Set<() => void>();
  private cleanups: (() => void)[] = [];
  private hasLoaded = false;
  private conversationRevision = 0;
  private syncInFlight: Promise<void> | null = null;
  private state: ChatState = {
    messages: [],
    conversation: null,
    connection: 'connecting',
    initialLoading: true,
    loadingOlder: false,
    hasMore: true,
    error: null,
  };

  constructor(private conversationId: string, readonly deviceId: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;

  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  start() {
    if (this.cleanups.length) return;
    this.stopped = false;
    const conversationId = this.conversationId;
    // Start subscriptions first to reduce the fetch/subscribe gap.
    this.cleanups.push(
      subscribe<{ onMessageAdded: Message }>(chatOperations.onMessageAdded, { conversationId }, (data) => this.mergeMessage(data.onMessageAdded)),
      subscribe<{ onMessageUpdated: Message }>(chatOperations.onMessageUpdated, { conversationId }, (data) => {
        const message = data.onMessageUpdated;
        // Receipts from another device must not expand this device's history.
        // clientId also matches optimistic messages awaiting their server id.
        if (this.messagesByKey.has(message.clientId ?? message.id)) this.mergeMessage(message);
      }),
      subscribe<{ onConversationUpdated: Conversation }>(chatOperations.onConversationUpdated, { id: conversationId }, (data) => {
        this.conversationRevision++;
        this.set({ conversation: data.onConversationUpdated });
      }),
      onConnectionChange((connection) => {
        this.set({ connection });
        // Subscriptions resume automatically; HTTP fills messages missed offline.
        if (connection === 'connected') {
          // Let graphql-ws send its subscription operations before the snapshot.
          const timer = setTimeout(() => {
            void this.resync();
          }, 0);
          this.cleanups.push(() => clearTimeout(timer));
        }
      }),
    );
    this.resync().finally(() => this.set({ initialLoading: false }));
  }

  stop() {
    this.stopped = true;
    this.cleanups.forEach((cleanup) => cleanup());
    this.cleanups = [];
  }

  resync() {
    // Serialize snapshots so a slow startup request cannot overwrite a reconnect.
    const next = (this.syncInFlight ?? Promise.resolve()).then(() => this.fetchSnapshot());
    this.syncInFlight = next;
    void next.finally(() => {
      if (this.syncInFlight === next) this.syncInFlight = null;
    });
    return next;
  }

  private async fetchSnapshot() {
    try {
      const revision = this.conversationRevision;
      const oldestLoaded = this.state.messages.find((message) => message.seq != null)?.seq;
      const [page, conversationResult] = await Promise.all([
        requestGraphQL<{ messages: { items: Message[]; hasMore: boolean } }>(chatOperations.messages, {
          conversationId: this.conversationId,
          limit: PAGE_SIZE,
        }),
        requestGraphQL<{ conversation: Conversation | null }>(chatOperations.conversation, { id: this.conversationId }),
      ]);
      if (!conversationResult.conversation) {
        this.set({ error: "Chatroom not found", hasMore: false });
        return;
      }
      page.messages.items.forEach((message) => this.mergeMessage(message, false));
      // Walk to the oldest loaded cursor, even if a new live event arrived first.
      let cursorPage = page.messages;
      while (oldestLoaded != null && cursorPage.hasMore && cursorPage.items[0]?.seq > oldestLoaded) {
        const older = await requestGraphQL<{ messages: { items: Message[]; hasMore: boolean } }>(chatOperations.messages, {
          conversationId: this.conversationId,
          before: cursorPage.items[0].seq,
          limit: PAGE_SIZE,
        });
        cursorPage = older.messages;
        cursorPage.items.forEach((message) => this.mergeMessage(message, false));
      }
      const isFirstLoad = !this.hasLoaded;
      this.hasLoaded = true;
      this.set({
        ...(revision === this.conversationRevision ? { conversation: conversationResult.conversation } : {}),
        error: null,
        ...(isFirstLoad ? { hasMore: page.messages.hasMore } : {}),
      });
      this.emitMessages();
      this.retryFailed();
    } catch {
      this.set({ error: 'Cannot reach the clinic server' });
    }
  }

  send(text: string) {
    const trimmedText = text.trim();
    if (!trimmedText) return;
    const clientId = Crypto.randomUUID();
    const optimisticMessage: ChatMessage = {
      key: clientId,
      id: clientId,
      clientId,
      seq: null,
      conversationId: this.conversationId,
      sender: 'PATIENT',
      senderName: null,
      senderDeviceId: this.deviceId,
      text: trimmedText,
      createdAt: new Date().toISOString(),
      status: 'SENDING',
      deliveredAt: null,
      readAt: null,
    };
    this.messagesByKey.set(clientId, optimisticMessage);
    this.emitMessages();
    void this.deliver(optimisticMessage);
  }

  retry(key: string) {
    const message = this.messagesByKey.get(key);
    if (!message || message.status !== 'FAILED') return;
    this.messagesByKey.set(key, { ...message, status: 'SENDING' });
    this.emitMessages();
    void this.deliver(message);
  }

  async loadOlder() {
    const { loadingOlder, hasMore } = this.state;
    if (loadingOlder || !hasMore) return;
    const oldestSeq = this.state.messages.find((message) => message.seq != null)?.seq;
    this.set({ loadingOlder: true });
    try {
      const { messages } = await requestGraphQL<{ messages: { items: Message[]; hasMore: boolean } }>(chatOperations.messages, {
        conversationId: this.conversationId,
        before: oldestSeq,
        limit: PAGE_SIZE,
      });
      messages.items.forEach((message) => this.mergeMessage(message, false));
      this.emitMessages();
      this.set({ hasMore: messages.hasMore, loadingOlder: false, error: null });
    } catch {
      this.set({ loadingOlder: false, error: 'Could not load older messages' });
    }
  }

  private async deliver(message: ChatMessage) {
    try {
      const { sendMessage } = await requestGraphQL<{ sendMessage: Message }>(chatOperations.sendMessage, {
        input: {
          conversationId: message.conversationId,
          clientId: message.clientId,
          text: message.text,
          deviceId: this.deviceId,
        },
      });
      this.mergeMessage(sendMessage);
    } catch {
      const current = this.messagesByKey.get(message.key);
      if (current?.status === 'SENDING') {
        this.messagesByKey.set(message.key, { ...current, status: 'FAILED' });
        this.emitMessages();
      }
    }
  }

  private retryFailed() {
    for (const message of this.messagesByKey.values()) {
      if (message.status === 'FAILED') this.retry(message.key);
    }
  }

  private mergeMessage(message: Message, emit = true) {
    const key = message.clientId ?? message.id;
    const existing = this.messagesByKey.get(key);
    // A delayed SENT response must not overwrite an existing delivery receipt.
    const status =
      existing && STATUS_RANK[existing.status] > STATUS_RANK[message.status] ? existing.status : message.status;
    const merged: ChatMessage = {
      ...existing,
      ...message,
      key,
      status,
      deliveredAt: existing?.deliveredAt ?? message.deliveredAt,
      readAt: existing?.readAt ?? message.readAt,
    };
    if (existing && (Object.keys(merged) as (keyof ChatMessage)[]).every((field) => existing[field] === merged[field])) return;
    this.messagesByKey.set(key, merged);
    if (emit) this.emitMessages();
  }

  async markVisibleMessagesRead(messageIds: string[]) {
    if (this.stopped) return;
    const ids = [...new Set(messageIds)].filter((id) => {
      const message = this.state.messages.find((item) => item.id === id);
      return message && message.seq != null && !message.readAt &&
        (message.sender === 'AI' || message.sender === 'STAFF') && !this.readsInFlight.has(id);
    });
    if (!ids.length) return;
    ids.forEach((id) => this.readsInFlight.add(id));
    try {
      const { markMessagesRead } = await requestGraphQL<{ markMessagesRead: Message[] }>(chatOperations.markMessagesRead, {
        conversationId: this.conversationId, messageIds: ids,
      });
      if (!this.stopped) {
        markMessagesRead.forEach((message) => this.mergeMessage(message, false));
        if (markMessagesRead.length) this.emitMessages();
      }
    } catch {
      // The next visibility check or reconnect retries only messages still onscreen.
    } finally {
      ids.forEach((id) => this.readsInFlight.delete(id));
    }
  }

  private emitMessages() {
    const messages = [...this.messagesByKey.values()];
    messages.sort((a, b) => {
      if (a.seq != null && b.seq != null) return a.seq - b.seq;
      if (a.seq != null) return -1; // saved messages before pending ones
      if (b.seq != null) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
    // A mutation response may repeat a subscription receipt already applied.
    // Preserve the list reference for unchanged batches and snapshots too.
    if (messages.length === this.state.messages.length &&
        messages.every((message, index) => message === this.state.messages[index])) return;
    this.set({ messages });
  }
}
