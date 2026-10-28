import type { Context, NextFunction } from 'grammy';
import { config } from '../config.js';

/**
 * Middleware строгой изоляции:
 * Пропускает запросы ТОЛЬКО из разрешенной группы (ALLOWED_GROUP_ID).
 * В личных чатах вежливо сообщает об ограничении.
 * При обращении из неизвестной группы подсказывает её реальный ID, чтобы легко настроить .env.
 */
export async function groupGuard(ctx: Context, next: NextFunction): Promise<void> {
  const chat = ctx.chat;

  if (!chat) {
    return;
  }

  // Личные сообщения
  if (chat.type === 'private') {
    console.log(`[GroupGuard] Сообщение из личного чата от @${ctx.from?.username || ctx.from?.id}`);
    try {
      await ctx.reply('⚠️ Я работаю только в рабочей группе проекта.');
    } catch {
      // Игнорируем сетевые ошибки отправки в приват
    }
    return;
  }

  // Проверка соответствия разрешенной группе (поддерживается один ID или список через запятую)
  const currentChatId = chat.id.toString();
  const allowedIds = config.ALLOWED_GROUP_ID.split(',').map((id) => id.trim());

  if (!allowedIds.includes(currentChatId)) {
    console.warn(
      `[GroupGuard] ⚠️ ВНИМАНИЕ: Получено сообщение из чата ID: ${currentChatId} (название: «${(chat as any).title || 'без названия'}», тип: ${chat.type}). В .env указан: ALLOWED_GROUP_ID=${config.ALLOWED_GROUP_ID}`
    );

    // Если к боту обратились напрямую (@botusername или команда /), отправляем в чат понятное уведомление с точным ID
    const text = ctx.message?.text || ctx.message?.caption || '';
    const botUsername = ctx.me?.username;
    const isDirectMention = botUsername ? new RegExp(`@${botUsername}\\b`, 'i').test(text) : false;
    const isCommand = text.startsWith('/');

    if (isDirectMention || isCommand) {
      try {
        await ctx.reply(
          `⚠️ <b>Бот не настроен для работы в этой группе!</b>\n\n` +
            `• <b>ID этой группы:</b> <code>${currentChatId}</code>\n` +
            `• <b>В .env сейчас разрешён:</b> <code>ALLOWED_GROUP_ID=${config.ALLOWED_GROUP_ID}</code>\n\n` +
            `👉 <b>Чтобы бот отвечал в этой группе:</b>\n` +
            `1. Откройте файл <code>.env</code> проекта.\n` +
            `2. Измените строку на:\n<code>ALLOWED_GROUP_ID=${currentChatId}</code>\n` +
            `3. Сохраните файл.`,
          {
            parse_mode: 'HTML',
            message_thread_id: ctx.message?.message_thread_id,
          }
        );
      } catch (replyErr) {
        console.error('[GroupGuard] Не удалось отправить подсказку в чат:', replyErr);
      }
    }
    return;
  }

  return next();
}
