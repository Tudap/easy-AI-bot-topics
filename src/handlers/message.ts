import type { Context } from 'grammy';
import { config } from '../config.js';
import { dbService } from '../db/index.js';
import {
  buildConversationContext,
  formatUserName,
  getThreadId,
} from '../services/reply-chain.js';
import { generateAIResponse } from '../services/ai.js';
import { formatAIResponseToHTML } from '../utils/html.js';
import { sendLongMessage } from '../utils/chunker.js';

/**
 * Проверяет, должен ли бот отвечать на сообщение.
 * Бот вступает в диалог ТОЛЬКО если:
 * 1. Сообщение начинается со знака / (команда).
 * 2. В тексте или подписи к фото есть прямое упоминание @botusername.
 * 3. Сообщение отправлено в режиме Reply на сообщение бота (from.is_bot === true).
 */
export function shouldReply(ctx: Context, botUsername: string): boolean {
  const message = ctx.message;
  if (!message) return false;

  const text = message.text || message.caption || '';

  // 1. Команда
  if (text.startsWith('/')) {
    return true;
  }

  // 2. Прямое упоминание @botusername
  if (botUsername) {
    const mentionRegex = new RegExp(`@${botUsername}\\b`, 'i');
    if (mentionRegex.test(text)) {
      return true;
    }
  }

  // 3. Ответ (Reply) на сообщение бота
  if (message.reply_to_message?.from?.is_bot) {
    return true;
  }

  return false;
}

/**
 * Главный хэндлер обработки текста и фото
 */
export async function handleIncomingMessage(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message) return;

  const botUsername = ctx.me.username;
  const threadId = getThreadId(ctx);
  const currentUserName = formatUserName(message.from);
  const rawText = message.text || message.caption || '';

  // Сохраняем сообщение в SQLite для возможности восстановления контекста цепочек
  dbService.saveMessage({
    threadId,
    msgId: message.message_id,
    replyToMsgId: message.reply_to_message?.message_id,
    author: currentUserName,
    role: 'user',
    content: rawText || (message.photo ? '[Изображение]' : '[Вложение]'),
  });

  // Проверяем фильтр реакции shouldReply
  if (!shouldReply(ctx, botUsername)) {
    return;
  }

  // Если это команда (например, неизвестная или необработанная в command.ts),
  // но начинается с /, и не содержит упоминания - пропускаем, если не наш случай
  if (message.text?.startsWith('/') && !message.text.includes(`@${botUsername}`)) {
    const commandName = message.text.split(' ')[0].replace('/', '');
    const knownCommands = [
      'help',
      'start',
      'clear',
      'summary',
      'notes',
      'delnote',
      'del',
      'done',
      'status',
      'model',
      'models',
    ];
    if (knownCommands.includes(commandName)) {
      // Уже обработано в command.ts
      return;
    }
  }

  // Показываем индикатор набора текста
  await ctx.replyWithChatAction('typing');

  // Интервал отправки typing для долгих запросов/вызовов инструментов
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  try {
    let photoUrl: string | undefined;

    // Если есть фото, берем самое высокое разрешение
    if (message.photo && message.photo.length > 0) {
      const highestPhoto = message.photo[message.photo.length - 1];
      const file = await ctx.api.getFile(highestPhoto.file_id);
      if (file.file_path) {
        photoUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      }
    }

    // Собираем контекст с учетом Reply Chain и системного промпта
    const messages = await buildConversationContext({
      ctx,
      botUsername,
      photoUrl,
    });

    // Запускаем единую мультимодальную модель с циклом вызова инструментов
    const rawAnswer = await generateAIResponse(messages, {
      groupId: ctx.chat?.id.toString() || '',
      author: currentUserName,
    });

    // Форматируем в безопасный Telegram HTML
    const formattedHtml = formatAIResponseToHTML(rawAnswer);

    // Отправляем ответ частями с защитой от 429
    const sentMsgId = await sendLongMessage(ctx, formattedHtml, message.message_id);

    // Сохраняем ответ ассистента в базу данных
    if (sentMsgId) {
      dbService.saveMessage({
        threadId,
        msgId: sentMsgId,
        replyToMsgId: message.message_id,
        author: botUsername,
        role: 'assistant',
        content: rawAnswer,
      });
    }
  } catch (err: unknown) {
    console.error('[Handler] Error processing message:', err);
    const errorDetails = err instanceof Error ? err.message : String(err);
    await ctx.reply(
      `⚠️ Произошла ошибка при обработке запроса:\n<code>${errorDetails}</code>`,
      {
        parse_mode: 'HTML',
        reply_parameters: { message_id: message.message_id },
      }
    );
  } finally {
    clearInterval(typingInterval);
  }
}
