import express from 'express';
import { Bot } from 'grammy';
import { config } from './config.js';
import { dbService } from './db/index.js';
import { groupGuard } from './middlewares/group-guard.js';
import {
  handleClearCommand,
  handleDeleteNoteCommand,
  handleHelpCommand,
  handleNotesCommand,
  handleStatusCommand,
  handleSummaryCommand,
} from './handlers/command.js';
import { handleIncomingMessage } from './handlers/message.js';
import { getModelPoolStatus } from './services/ai.js';

// 1. Инициализация Telegram-бота
export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// 2. Middleware строгой изоляции: пускает ТОЛЬКО ALLOWED_GROUP_ID
bot.use(groupGuard);

// 3. Регистрация базовых сервисных команд группы
bot.command('help', handleHelpCommand);
bot.command('start', handleHelpCommand);
bot.command('clear', handleClearCommand);
bot.command('notes', handleNotesCommand);
bot.command(['delnote', 'del', 'done'], handleDeleteNoteCommand);
bot.command(['status', 'model', 'models'], handleStatusCommand);
bot.command('summary', handleSummaryCommand);

// 4. Регистрация обработчика входящих сообщений (текст и фото)
bot.on(['message:text', 'message:photo'], handleIncomingMessage);

// 5. Глобальный обработчик ошибок grammY
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[Bot Error] Ошибка в обновлении ${ctx.update.update_id}:`, err.error);
});

// 6. Инициализация Express Health-Check сервера
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  const pool = getModelPoolStatus();
  res.status(200).json({
    status: 'ok',
    botUsername: bot.botInfo?.username ?? 'unknown',
    allowedGroupId: config.ALLOWED_GROUP_ID,
    primaryModel: config.MODEL_NAME,
    models: pool.models,
    totalUsedToday: pool.totalUsed,
    totalDailyLimit: pool.totalLimit,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

const server = app.listen(config.PORT, () => {
  console.log(`[Health-Check] HTTP сервер запущен на порту ${config.PORT} (/health)`);
});

// 7. Graceful Shutdown
let isShuttingDown = false;

async function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Shutdown] Получен сигнал ${signal}. Завершение работы бота...`);

  try {
    // Останавливаем прием новых сообщений
    if (bot.isInited()) {
      await bot.stop();
      console.log('[Shutdown] Telegram бот остановлен.');
    }

    // Закрываем HTTP сервер
    server.close(() => {
      console.log('[Shutdown] HTTP сервер закрыт.');
    });

    // Закрываем базу данных SQLite
    dbService.close();
    console.log('[Shutdown] Соединение с SQLite закрыто.');

    process.exit(0);
  } catch (err) {
    console.error('[Shutdown Error] Ошибка при завершении:', err);
    process.exit(1);
  }
}

process.once('SIGINT', () => handleShutdown('SIGINT'));
process.once('SIGTERM', () => handleShutdown('SIGTERM'));

// 8. Запуск бота
async function startBot() {
  try {
    await bot.init();
    console.log(`[Bot Ready] Бот @${bot.botInfo.username} успешно инициализирован.`);
    console.log(`[Bot Config] Разрешенная группа: ${config.ALLOWED_GROUP_ID}`);
    console.log(`[Bot Config] Модель: ${config.MODEL_NAME}`);

    await bot.start({
      onStart: (botInfo) => {
        console.log(`[Bot Started] Long-polling запущен для @${botInfo.username}`);
      },
    });
  } catch (err) {
    console.error('[Startup Fatal Error] Не удалось запустить бота:', err);
    process.exit(1);
  }
}

startBot();
