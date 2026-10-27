import type { Context } from 'grammy';
import { dbService } from '../db/index.js';

export interface TopicInfo {
  /** Числовой идентификатор темы в Telegram (1 для General топика, либо ID созданного топика) */
  threadId: number | undefined;
  /** Сырой message_thread_id из сообщения (может быть undefined в основном топике форума) */
  rawThreadId: number | undefined;
  /** Уникальный строковый ключ для изоляции истории в SQLite (например, -100123456_42 или -100123456_1) */
  storageThreadId: string;
  /** Человекочитаемое название темы («Разработка», «Дизайн», «Основная тема») */
  name: string;
  /** Является ли группа супергруппой с темами (форумом) */
  isForum: boolean;
}

/**
 * Определяет полную информацию о теме (топике), в которой находится сообщение.
 * Автоматически подхватывает сервисные события Telegram и сохраняет имена тем в базу.
 */
export function getTopicInfo(ctx: Context): TopicInfo {
  const chatId = ctx.chat?.id.toString() || '';
  const message = ctx.message;
  const isForum = Boolean(
    (ctx.chat as { is_forum?: boolean } | undefined)?.is_forum ||
    message?.is_topic_message ||
    message?.message_thread_id
  );
  const rawThreadId = message?.message_thread_id;

  // Если это обычная группа без тем
  if (!isForum) {
    return {
      threadId: undefined,
      rawThreadId: undefined,
      storageThreadId: chatId,
      name: 'Общий чат',
      isForum: false,
    };
  }

  // Если это конкретная пользовательская тема (threadId > 1)
  if (rawThreadId && rawThreadId > 1) {
    let topicName: string | undefined;

    // 1. Проверяем в базе SQLite
    const stored = dbService.getTopic(chatId, rawThreadId);
    if (stored?.name) {
      topicName = stored.name;
    }

    // 2. Если в сообщении есть событие создания темы
    if (!topicName && message.forum_topic_created?.name) {
      topicName = message.forum_topic_created.name.trim();
      dbService.saveTopic(chatId, rawThreadId, topicName);
    }

    // 3. Если сообщение отправлено как Reply на первое сервисное сообщение темы
    if (!topicName && message.reply_to_message?.forum_topic_created?.name) {
      topicName = message.reply_to_message.forum_topic_created.name.trim();
      dbService.saveTopic(chatId, rawThreadId, topicName);
    }

    // 4. Фоллбэк: если имя еще не определено
    if (!topicName) {
      topicName = `Тема #${rawThreadId}`;
    }

    return {
      threadId: rawThreadId,
      rawThreadId,
      storageThreadId: `${chatId}_${rawThreadId}`,
      name: topicName,
      isForum: true,
    };
  }

  // Основная / общая тема форума (General topic, thread_id = 1 или undefined)
  const generalStored = dbService.getTopic(chatId, 1);
  const generalName = generalStored?.name || 'Основная тема';

  return {
    threadId: 1,
    rawThreadId,
    storageThreadId: `${chatId}_1`,
    name: generalName,
    isForum: true,
  };
}
