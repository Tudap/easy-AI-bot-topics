import type { Context } from 'grammy';
import type {
  ChatCompletionMessageParam,
  ChatCompletionUserMessageParam,
  ChatCompletionAssistantMessageParam,
} from 'openai/resources/chat/completions';
import { buildSystemPrompt } from '../config.js';
import { dbService, type StoredMessage } from '../db/index.js';

export function getThreadId(ctx: Context): string {
  const chatId = ctx.chat?.id.toString() || '';
  const messageThreadId = ctx.message?.message_thread_id;
  return messageThreadId ? `${chatId}_${messageThreadId}` : chatId;
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

interface BuildContextOptions {
  ctx: Context;
  botUsername: string;
  photoUrl?: string;
}

/**
 * Построение контекста для LLM:
 * - Если БЕЗ Reply: только системный промпт и текущий вопрос [Имя]: текст (без галлюцинаций старой истории).
 * - Если С Reply: цепочка reply_to_message до 5 уровней в глубину с разметкой ролей и авторов.
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
  const currentUserName = formatUserName(message.from);
  const rawText = message.text || message.caption || '';
  const cleanedText = cleanBotMention(rawText, botUsername);

  // 1. Системный промпт
  const systemMessage: ChatCompletionMessageParam = {
    role: 'system',
    content: buildSystemPrompt(groupTitle, currentUserName),
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

  // 3. Если запрос БЕЗ Reply — отдаем строго системный промпт и текущий вопрос
  if (!message.reply_to_message) {
    return [systemMessage, currentUserMessage];
  }

  // 4. Если запрос С Reply — разворачиваем цепочку до 5 шагов
  const chain: ChatCompletionMessageParam[] = [];
  const visitedMsgIds = new Set<number>();
  let currentReplyTargetId: number | null | undefined = message.reply_to_message.message_id;

  // Если непосредственное сообщение в Telegram доступно, начнем с него или сверим с SQLite
  let directReplyMsg = message.reply_to_message;

  for (let depth = 0; depth < 5; depth++) {
    if (!currentReplyTargetId || visitedMsgIds.has(currentReplyTargetId)) {
      break;
    }
    visitedMsgIds.add(currentReplyTargetId);

    // Сверяем с базой данных SQLite
    const stored: StoredMessage | undefined = dbService.getMessageByMsgId(currentReplyTargetId);

    if (stored) {
      if (stored.role === 'assistant') {
        const assistantMsg: ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: stored.content,
        };
        chain.unshift(assistantMsg);
      } else {
        const userMsg: ChatCompletionUserMessageParam = {
          role: 'user',
          content: `[${stored.author}]: ${stored.content}`,
        };
        chain.unshift(userMsg);
      }

      // Переходим к следующему сообщению в цепочке
      currentReplyTargetId = stored.reply_to_msg_id;
    } else if (directReplyMsg && directReplyMsg.message_id === currentReplyTargetId) {
      // Сообщения нет в SQLite (например, старое сообщение до старта бота), берем из Telegram
      const isBot = directReplyMsg.from?.is_bot === true;
      const author = formatUserName(directReplyMsg.from);
      const text = directReplyMsg.text || directReplyMsg.caption || '';

      if (isBot) {
        chain.unshift({
          role: 'assistant',
          content: text,
        });
      } else {
        chain.unshift({
          role: 'user',
          content: `[${author}]: ${text}`,
        });
      }

      // Если в Telegram-объекте есть вложенный reply_to_message
      const nextTelegramReply = (directReplyMsg as { reply_to_message?: { message_id: number; from?: any; text?: string; caption?: string } }).reply_to_message;
      if (nextTelegramReply) {
        currentReplyTargetId = nextTelegramReply.message_id;
        directReplyMsg = nextTelegramReply as typeof directReplyMsg;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return [systemMessage, ...chain, currentUserMessage];
}
