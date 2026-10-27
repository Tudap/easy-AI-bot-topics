import type { Context } from 'grammy';
import type {
  ChatCompletionMessageParam,
  ChatCompletionUserMessageParam,
  ChatCompletionAssistantMessageParam,
} from 'openai/resources/chat/completions';
import { buildSystemPrompt } from '../config.js';
import { dbService, type StoredMessage } from '../db/index.js';
import { getTopicInfo, type TopicInfo } from './topic.js';

export function getThreadId(ctx: Context): string {
  return getTopicInfo(ctx).storageThreadId;
}

export function formatUserName(from?: { first_name?: string; last_name?: string; username?: string }): string {
  if (!from) return 'Участник';
  const nameParts = [from.first_name, from.last_name].filter(Boolean);
  if (nameParts.length > 0) {
    return nameParts.join(' ');
  }
  return from.username ? `@${from.username}` : 'Участник';
}

export function cleanBotMention(text: string, botUsername?: string): string {
  if (!text) return '';
  if (!botUsername) return text.trim();
  const regex = new RegExp(`@${botUsername}\\b`, 'gi');
  return text.replace(regex, '').trim();
}

/**
 * Проверяет, является ли текст системной командой бота, которую не стоит передавать в диалоговый контекст
 */
function isBotCommandText(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return false;
  const cmd = trimmed.split(/\s+/)[0].toLowerCase().replace('/', '').split('@')[0];
  const serviceCommands = ['help', 'start', 'clear', 'summary', 'notes', 'delnote', 'del', 'done', 'status', 'model', 'models', 'topic', 'thread'];
  return serviceCommands.includes(cmd);
}

interface BuildContextOptions {
  ctx: Context;
  botUsername: string;
  photoUrl?: string;
}

/**
 * Построение контекста для LLM с полной поддержкой топиков (тем) и истории:
 * 1. Системный промпт с точным указанием текущей темы и группы.
 * 2. История недавних сообщений именно из этой темы (до 15 сообщений).
 * 3. Если было цитирование (Reply) старого сообщения, не вошедшего в последние 15,
 *    разворачивается цепочка предков (до 5 шагов).
 * 4. Текущее сообщение пользователя с разметкой автора и фото (при наличии).
 */
export async function buildConversationContext({
  ctx,
  botUsername,
  photoUrl,
}: BuildContextOptions): Promise<ChatCompletionMessageParam[]> {
  const message = ctx.message;
  if (!message) {
    return [];
  }

  const groupTitle = ctx.chat?.title || 'Рабочая группа';
  const topicInfo: TopicInfo = getTopicInfo(ctx);
  const currentUserName = formatUserName(message.from);
  const rawText = message.text || message.caption || '';
  const cleanedText = cleanBotMention(rawText, botUsername);

  // 1. Системный промпт с информацией о группе и теме
  const systemMessage: ChatCompletionMessageParam = {
    role: 'system',
    content: buildSystemPrompt(groupTitle, topicInfo.name, currentUserName, topicInfo.threadId),
  };

  // 2. Текущее сообщение пользователя
  const currentUserMessage: ChatCompletionUserMessageParam = photoUrl
    ? {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[${currentUserName}]: ${cleanedText || 'Опиши и проанализируй это изображение'}`,
          },
          {
            type: 'image_url',
            image_url: { url: photoUrl },
          },
        ],
      }
    : {
        role: 'user',
        content: `[${currentUserName}]: ${cleanedText || 'Привет!'}`,
      };

  // 3. Загружаем недавние сообщения именно этой темы из базы данных
  const recentStored = dbService.getRecentMessages(topicInfo.storageThreadId, 20);

  // Исключаем текущее сообщение и служебные команды
  const filteredHistory = recentStored.filter((m) => {
    if (m.msg_id === message.message_id) return false;
    if (isBotCommandText(m.content)) return false;
    return true;
  });

  const knownMsgIds = new Set<number>(filteredHistory.map((m) => m.msg_id));
  const replyChainPrepends: StoredMessage[] = [];

  // 4. Если пользователь ответил (Reply) на сообщение, проверяем, есть ли оно в истории
  if (message.reply_to_message?.message_id) {
    let currentReplyTargetId: number | null | undefined = message.reply_to_message.message_id;
    let directReplyMsg = message.reply_to_message;

    for (let depth = 0; depth < 5; depth++) {
      if (!currentReplyTargetId || knownMsgIds.has(currentReplyTargetId)) {
        break;
      }
      knownMsgIds.add(currentReplyTargetId);

      const stored: StoredMessage | undefined = dbService.getMessageByMsgId(currentReplyTargetId);
      if (stored) {
        if (!isBotCommandText(stored.content)) {
          replyChainPrepends.unshift(stored);
        }
        currentReplyTargetId = stored.reply_to_msg_id;
      } else if (directReplyMsg && directReplyMsg.message_id === currentReplyTargetId) {
        const isBot = directReplyMsg.from?.is_bot === true;
        const author = formatUserName(directReplyMsg.from);
        const text = directReplyMsg.text || directReplyMsg.caption || '';
        if (text && !isBotCommandText(text)) {
          replyChainPrepends.unshift({
            id: 0,
            thread_id: topicInfo.storageThreadId,
            msg_id: directReplyMsg.message_id,
            author,
            role: isBot ? 'assistant' : 'user',
            content: text,
            created_at: directReplyMsg.date * 1000,
          });
        }
        const nextReply = (directReplyMsg as { reply_to_message?: { message_id: number; from?: any; text?: string; caption?: string; date: number } }).reply_to_message;
        if (nextReply) {
          currentReplyTargetId = nextReply.message_id;
          directReplyMsg = nextReply as typeof directReplyMsg;
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }

  // Объединяем сообщения цепочки ответа (если были более ранние) и недавнюю историю
  const combinedHistory = [...replyChainPrepends, ...filteredHistory];

  // Форматируем для OpenAI Chat Completions
  const historyParams: ChatCompletionMessageParam[] = combinedHistory.map((m) => {
    if (m.role === 'assistant') {
      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.content,
      };
      return assistantMsg;
    }
    const userMsg: ChatCompletionUserMessageParam = {
      role: 'user',
      content: `[${m.author}]: ${m.content}`,
    };
    return userMsg;
  });

  return [systemMessage, ...historyParams, currentUserMessage];
}
