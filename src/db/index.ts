import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const dbDir = path.dirname(config.DATABASE_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(config.DATABASE_PATH);

// Включаем WAL-режим для максимальной производительности и надежности
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Инициализация структуры таблиц
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    msg_id INTEGER NOT NULL,
    reply_to_msg_id INTEGER,
    author TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_thread_msg ON messages(thread_id, msg_id);
  CREATE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(msg_id);

  CREATE TABLE IF NOT EXISTS topics (
    chat_id TEXT NOT NULL,
    thread_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, thread_id)
  );

  CREATE INDEX IF NOT EXISTS idx_topics_chat ON topics(chat_id);

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    author TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(group_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_notes_group ON notes(group_id);

  CREATE TABLE IF NOT EXISTS model_daily_usage (
    model TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (model, day)
  );
`);

export interface StoredMessage {
  id: number;
  thread_id: string;
  msg_id: number;
  reply_to_msg_id?: number | null;
  author: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
}

export interface StoredNote {
  id: number;
  group_id: string;
  key: string;
  content: string;
  author: string;
  updated_at: number;
}

export interface StoredTopic {
  chat_id: string;
  thread_id: number;
  name: string;
  updated_at: number;
}

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (thread_id, msg_id, reply_to_msg_id, author, role, content, created_at)
  VALUES (@thread_id, @msg_id, @reply_to_msg_id, @author, @role, @content, @created_at)
`);

const getMessageByMsgIdStmt = db.prepare(`
  SELECT * FROM messages WHERE msg_id = ? ORDER BY id DESC LIMIT 1
`);

const getRecentMessagesStmt = db.prepare(`
  SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?
`);

const getRecentMessagesWithGeneralStmt = db.prepare(`
  SELECT * FROM messages WHERE thread_id = ? OR thread_id = ? ORDER BY id DESC LIMIT ?
`);

const deleteMessagesByThreadStmt = db.prepare(`
  DELETE FROM messages WHERE thread_id = ?
`);

const deleteMessagesByThreadGeneralStmt = db.prepare(`
  DELETE FROM messages WHERE thread_id = ? OR thread_id = ?
`);

const getThreadMessageCountStmt = db.prepare(`
  SELECT count(*) as count FROM messages WHERE thread_id = ?
`);

const upsertTopicStmt = db.prepare(`
  INSERT INTO topics (chat_id, thread_id, name, updated_at)
  VALUES (@chat_id, @thread_id, @name, @updated_at)
  ON CONFLICT(chat_id, thread_id) DO UPDATE SET
    name = excluded.name,
    updated_at = excluded.updated_at
`);

const getTopicStmt = db.prepare(`
  SELECT * FROM topics WHERE chat_id = ? AND thread_id = ? LIMIT 1
`);

const listTopicsStmt = db.prepare(`
  SELECT * FROM topics WHERE chat_id = ? ORDER BY thread_id ASC
`);

const deleteTopicStmt = db.prepare(`
  DELETE FROM topics WHERE chat_id = ? AND thread_id = ?
`);

const upsertNoteStmt = db.prepare(`
  INSERT INTO notes (group_id, key, content, author, updated_at)
  VALUES (@group_id, @key, @content, @author, @updated_at)
  ON CONFLICT(group_id, key) DO UPDATE SET
    content = excluded.content,
    author = excluded.author,
    updated_at = excluded.updated_at
`);

const getNoteStmt = db.prepare(`
  SELECT * FROM notes WHERE group_id = ? AND key = ? LIMIT 1
`);

const listNotesStmt = db.prepare(`
  SELECT * FROM notes WHERE group_id = ? ORDER BY updated_at DESC
`);

const deleteNoteStmt = db.prepare(`
  DELETE FROM notes WHERE group_id = ? AND key = ?
`);

const getModelUsageStmt = db.prepare(`
  SELECT count FROM model_daily_usage WHERE model = ? AND day = ? LIMIT 1
`);

const incrementModelUsageStmt = db.prepare(`
  INSERT INTO model_daily_usage (model, day, count)
  VALUES (?, ?, 1)
  ON CONFLICT(model, day) DO UPDATE SET count = count + 1
`);

const setModelUsageStmt = db.prepare(`
  INSERT INTO model_daily_usage (model, day, count)
  VALUES (?, ?, ?)
  ON CONFLICT(model, day) DO UPDATE SET count = excluded.count
`);

const listModelUsageForDayStmt = db.prepare(`
  SELECT model, count FROM model_daily_usage WHERE day = ?
`);

export function getTodayDateKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeNoteKey(rawKey: string): string {
  let cleaned = (rawKey || '').trim().toLowerCase();
  while (cleaned.startsWith('#')) {
    cleaned = cleaned.slice(1).trim();
  }
  return cleaned ? `#${cleaned}` : '';
}

export const dbService = {
  saveMessage(params: {
    threadId: string;
    msgId: number;
    replyToMsgId?: number | null;
    author: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
  }): void {
    insertMessageStmt.run({
      thread_id: params.threadId,
      msg_id: params.msgId,
      reply_to_msg_id: params.replyToMsgId ?? null,
      author: params.author,
      role: params.role,
      content: params.content,
      created_at: Date.now(),
    });
  },

  getMessageByMsgId(msgId: number): StoredMessage | undefined {
    return getMessageByMsgIdStmt.get(msgId) as StoredMessage | undefined;
  },

  getRecentMessages(threadId: string, limit = 20): StoredMessage[] {
    // Если это общая тема вида chatId_1, захватываем и старый формат chatId
    if (threadId.endsWith('_1')) {
      const baseChatId = threadId.slice(0, -2);
      const rows = getRecentMessagesWithGeneralStmt.all(threadId, baseChatId, limit) as StoredMessage[];
      return rows.reverse();
    }
    const rows = getRecentMessagesStmt.all(threadId, limit) as StoredMessage[];
    return rows.reverse(); // вернуть в хронологическом порядке
  },

  clearThread(threadId: string): number {
    if (threadId.endsWith('_1')) {
      const baseChatId = threadId.slice(0, -2);
      const result = deleteMessagesByThreadGeneralStmt.run(threadId, baseChatId);
      return Number(result.changes);
    }
    const result = deleteMessagesByThreadStmt.run(threadId);
    return Number(result.changes);
  },

  getThreadMessageCount(threadId: string): number {
    const row = getThreadMessageCountStmt.get(threadId) as { count: number } | undefined;
    return row ? row.count : 0;
  },

  saveTopic(chatId: string, threadId: number, name: string): void {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    upsertTopicStmt.run({
      chat_id: chatId,
      thread_id: threadId,
      name: trimmed,
      updated_at: Date.now(),
    });
  },

  getTopic(chatId: string, threadId: number): StoredTopic | undefined {
    return getTopicStmt.get(chatId, threadId) as StoredTopic | undefined;
  },

  listTopics(chatId: string): StoredTopic[] {
    return listTopicsStmt.all(chatId) as StoredTopic[];
  },

  deleteTopic(chatId: string, threadId: number): boolean {
    const result = deleteTopicStmt.run(chatId, threadId);
    return result.changes > 0;
  },

  saveNote(params: {
    groupId: string;
    key: string;
    content: string;
    author: string;
  }): void {
    const key = normalizeNoteKey(params.key);
    if (!key) return;
    upsertNoteStmt.run({
      group_id: params.groupId,
      key,
      content: params.content.trim(),
      author: params.author,
      updated_at: Date.now(),
    });
  },

  getNote(groupId: string, key: string): StoredNote | undefined {
    const normalizedKey = normalizeNoteKey(key);
    if (!normalizedKey) return undefined;
    return getNoteStmt.get(groupId, normalizedKey) as StoredNote | undefined;
  },

  listNotes(groupId: string): StoredNote[] {
    return listNotesStmt.all(groupId) as StoredNote[];
  },

  deleteNote(groupId: string, key: string): boolean {
    const normalizedKey = normalizeNoteKey(key);
    if (!normalizedKey) return false;
    const result = deleteNoteStmt.run(groupId, normalizedKey);
    return result.changes > 0;
  },

  getModelUsage(model: string, day = getTodayDateKey()): number {
    const row = getModelUsageStmt.get(model, day) as { count: number } | undefined;
    return row ? row.count : 0;
  },

  incrementModelUsage(model: string, day = getTodayDateKey()): number {
    incrementModelUsageStmt.run(model, day);
    return this.getModelUsage(model, day);
  },

  setModelUsage(model: string, count: number, day = getTodayDateKey()): void {
    setModelUsageStmt.run(model, day, count);
  },

  getAllModelUsageForDay(day = getTodayDateKey()): Record<string, number> {
    const rows = listModelUsageForDayStmt.all(day) as { model: string; count: number }[];
    const result: Record<string, number> = {};
    for (const r of rows) {
      result[r.model] = r.count;
    }
    return result;
  },

  close(): void {
    try {
      db.close();
    } catch {
      // Игнорируем ошибку при повторном закрытии
    }
  },
};
