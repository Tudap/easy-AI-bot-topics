import type { Context, NextFunction } from 'grammy';
import { config } from '../config.js';

/**
 * Middleware строгой изоляции:
 * Пропускает запросы ТОЛЬКО из разрешенной группы (ALLOWED_GROUP_ID).
 * В личных чатах вежливо сообщает об ограничении или молча сбрасывает.
 * Чужие группы полностью игнорируются (silent drop).
 */
export async function groupGuard(ctx: Context, next: NextFunction): Promise<void> {
  const chat = ctx.chat;

  if (!chat) {
    return;
  }

  // Личные сообщения
  if (chat.type === 'private') {
    try {
      await ctx.reply('⚠️ Я работаю только в рабочей группе проекта.');
    } catch {
      // Игнорируем сетевые ошибки отправки в приват
    }
    return;
  }

  // Проверка соответствия разрешенной группе
  const currentChatId = chat.id.toString();
  if (currentChatId !== config.ALLOWED_GROUP_ID) {
    // Тихо игнорируем любые посторонние группы/каналы
    return;
  }

  return next();
}
