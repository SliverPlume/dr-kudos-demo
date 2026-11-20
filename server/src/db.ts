import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type Sender = 'PATIENT' | 'AI' | 'STAFF' | 'SYSTEM';
export type MessageStatus = 'SENT' | 'DELIVERED';
export type ConversationMode = 'AI' | 'STAFF';

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
  status: MessageStatus;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface Conversation {
  id: string;
  patientName: string;
  mode: ConversationMode;
  staffName: string | null;
  aiTyping: boolean;
  updatedAt: string;
}

export interface PatientRecords {
  visits: { date: string; treatment: string; clinician: string; summary: string }[];
  nextAppointment: { startsAtHongKong: string; service: string; clinician: string } | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE ?? path.join(here, '..', 'data.sqlite');

export const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS conversations (
    id           TEXT PRIMARY KEY,
    patient_name TEXT NOT NULL,
    mode         TEXT NOT NULL DEFAULT 'AI',
    staff_name   TEXT,
    ai_typing    INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    seq              INTEGER PRIMARY KEY AUTOINCREMENT,
    id               TEXT NOT NULL UNIQUE,
    client_id        TEXT UNIQUE,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id),
    sender           TEXT NOT NULL,
    sender_name      TEXT,
    sender_device_id TEXT,
    text             TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'SENT',
    delivered_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
  CREATE TABLE IF NOT EXISTS clinical_visits (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    visit_date TEXT NOT NULL,
    treatment TEXT NOT NULL,
    clinician TEXT NOT NULL,
    summary TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_visits_conversation_date ON clinical_visits(conversation_id, visit_date);
  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    starts_at TEXT NOT NULL,
    service TEXT NOT NULL,
    clinician TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled', 'completed'))
  );
  CREATE INDEX IF NOT EXISTS idx_appointments_conversation ON appointments(conversation_id, status, starts_at);
  CREATE TABLE IF NOT EXISTS translations (
    source_text TEXT NOT NULL,
    lang        TEXT NOT NULL,
    text        TEXT NOT NULL,
    translated  INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (source_text, lang)
  );
`);

// Additive migration preserves delivery receipts and leaves old messages unread.
const columns = db.prepare('PRAGMA table_info(messages)').all();
if (!columns.some((column) => column.name === 'read_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN read_at TEXT');
}

export function transaction<T>(work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

type Row = Record<string, any>;

const toMessage = (row: Row): Message => ({
  id: row.id,
  clientId: row.client_id,
  seq: Number(row.seq),
  conversationId: row.conversation_id,
  sender: row.sender,
  senderName: row.sender_name,
  senderDeviceId: row.sender_device_id,
  text: row.text,
  createdAt: row.created_at,
  status: row.status,
  deliveredAt: row.delivered_at,
  readAt: row.read_at,
});

const toConversation = (row: Row): Conversation => ({
  id: row.id,
  patientName: row.patient_name,
  mode: row.mode,
  staffName: row.staff_name,
  aiTyping: !!row.ai_typing,
  updatedAt: row.updated_at,
});

const statements = {
  latestVisit: db.prepare(`
    SELECT visit_date AS date, treatment, clinician FROM clinical_visits
    WHERE conversation_id = ? AND visit_date <= date('now', '+8 hours')
    ORDER BY visit_date DESC, id LIMIT 1`),
  visits: db.prepare(`
    SELECT visit_date AS date, treatment, clinician, summary FROM clinical_visits
    WHERE conversation_id = ? AND visit_date <= date(?, '+8 hours')
    ORDER BY visit_date DESC, id`),
  nextAppointment: db.prepare(`
    SELECT strftime('%Y-%m-%d %H:%M', starts_at, '+8 hours') AS startsAtHongKong, service, clinician
    FROM appointments WHERE conversation_id = ? AND status = 'confirmed' AND julianday(starts_at) > julianday(?)
    ORDER BY julianday(starts_at), id LIMIT 1`),
  getConversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
  listConversations: db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC'),
  insertConversation: db.prepare(
    'INSERT INTO conversations (id, patient_name, updated_at) VALUES (?, ?, ?)',
  ),
  touchConversation: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
  setTyping: db.prepare('UPDATE conversations SET ai_typing = ? WHERE id = ?'),
  setMode: db.prepare('UPDATE conversations SET mode = ?, staff_name = ? WHERE id = ?'),
  resetTyping: db.prepare('UPDATE conversations SET ai_typing = 0'),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  getMessageByClientId: db.prepare('SELECT * FROM messages WHERE client_id = ?'),
  insertMessage: db.prepare(`
    INSERT INTO messages (id, client_id, conversation_id, sender, sender_name, sender_device_id, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  pageLatest: db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?',
  ),
  pageBefore: db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
  ),
  lastMessage: db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1',
  ),
  lastReplySeq: db.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS seq FROM messages
     WHERE conversation_id = ? AND sender IN ('AI', 'STAFF')`,
  ),
  patientAfter: db.prepare(
    `SELECT * FROM messages WHERE conversation_id = ? AND sender = 'PATIENT' AND seq > ? ORDER BY seq`,
  ),
  markRead: db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL'),
  markDelivered: db.prepare(
    `UPDATE messages SET status = 'DELIVERED', delivered_at = ?
     WHERE id = ? AND status = 'SENT' AND COALESCE(sender_device_id, '') <> ?`,
  ),
  getTranslation: db.prepare('SELECT text, translated FROM translations WHERE source_text = ? AND lang = ?'),
  saveTranslation: db.prepare(
    'INSERT OR REPLACE INTO translations (source_text, lang, text, translated, created_at) VALUES (?, ?, ?, ?, ?)',
  ),
};

export const repo = {
  latestVisit(conversationId: string) {
    return statements.latestVisit.get(conversationId) ?? null;
  },
  patientRecords(conversationId: string, now = new Date()): PatientRecords {
    const at = now.toISOString();
    const visits = statements.visits.all(conversationId, at) as PatientRecords['visits'];
    const appointment = statements.nextAppointment.get(conversationId, at);
    return { visits, nextAppointment: (appointment ?? null) as PatientRecords['nextAppointment'] };
  },
  getConversation(id: string): Conversation | null {
    const row = statements.getConversation.get(id) as Row | undefined;
    return row ? toConversation(row) : null;
  },
  listConversations(): Conversation[] {
    return (statements.listConversations.all() as Row[]).map(toConversation);
  },
  createConversation(id: string, patientName: string, at = new Date().toISOString()) {
    statements.insertConversation.run(id, patientName, at);
  },
  setAiTyping(id: string, typing: boolean) {
    statements.setTyping.run(typing ? 1 : 0, id);
    return this.getConversation(id)!;
  },
  setMode(id: string, mode: ConversationMode, staffName: string | null) {
    statements.setMode.run(mode, staffName, id);
    return this.getConversation(id)!;
  },
  resetAllTyping() {
    statements.resetTyping.run();
  },

  getMessage(id: string): Message | null {
    const row = statements.getMessage.get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  },
  findByClientId(clientId: string): Message | null {
    const row = statements.getMessageByClientId.get(clientId) as Row | undefined;
    return row ? toMessage(row) : null;
  },
  insertMessage(message: {
    conversationId: string;
    sender: Sender;
    text: string;
    clientId?: string | null;
    senderName?: string | null;
    senderDeviceId?: string | null;
    createdAt?: string;
  }): Message {
    const id = randomUUID();
    const at = message.createdAt ?? new Date().toISOString();
    statements.insertMessage.run(
      id,
      message.clientId ?? null,
      message.conversationId,
      message.sender,
      message.senderName ?? null,
      message.senderDeviceId ?? null,
      message.text,
      at,
    );
    statements.touchConversation.run(at, message.conversationId);
    return this.getMessage(id)!;
  },
  /** Returns messages oldest-first plus whether older ones exist. */
  page(conversationId: string, beforeSeq: number | null, limit: number) {
    const rows = (
      beforeSeq == null
        ? statements.pageLatest.all(conversationId, limit + 1)
        : statements.pageBefore.all(conversationId, beforeSeq, limit + 1)
    ) as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toMessage).reverse();
    return { items, hasMore };
  },
  lastMessage(conversationId: string): Message | null {
    const row = statements.lastMessage.get(conversationId) as Row | undefined;
    return row ? toMessage(row) : null;
  },
  /** Patient messages that arrived after the last AI/staff reply. */
  unansweredPatientMessages(conversationId: string): Message[] {
    const { seq } = statements.lastReplySeq.get(conversationId) as Row;
    return (statements.patientAfter.all(conversationId, seq) as Row[]).map(toMessage);
  },
  // Caller validates the whole batch before starting a transaction.
  markMessagesRead(messageIds: string[], readerRole: 'PATIENT' | 'STAFF', at = new Date().toISOString()): Message[] {
    const updated: Message[] = [];
    for (const id of new Set(messageIds)) {
      const message = this.getMessage(id);
      const opposite = readerRole === 'STAFF'
        ? message?.sender === 'PATIENT'
        : message?.sender === 'STAFF' || message?.sender === 'AI';
      if (!message || !opposite || message.readAt) continue;
      if (statements.markRead.run(at, id).changes) updated.push(this.getMessage(id)!);
    }
    return updated;
  },
  /** Returns the updated message, or null if nothing changed. */
  markDelivered(messageId: string, deviceId: string): Message | null {
    const result = statements.markDelivered.run(new Date().toISOString(), messageId, deviceId);
    return result.changes > 0 ? this.getMessage(messageId) : null;
  },
  getTranslation(sourceText: string, lang: string): { text: string; translated: boolean } | null {
    const row = statements.getTranslation.get(sourceText, lang) as Row | undefined;
    return row ? { text: row.text, translated: !!row.translated } : null;
  },
  saveTranslation(sourceText: string, lang: string, text: string, translated: boolean) {
    statements.saveTranslation.run(sourceText, lang, text, translated ? 1 : 0, new Date().toISOString());
  },
};
