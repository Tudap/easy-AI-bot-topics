import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

function getEnvOrThrow(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`[Config Error] Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  TELEGRAM_BOT_TOKEN: getEnvOrThrow('TELEGRAM_BOT_TOKEN'),
  ALLOWED_GROUP_ID: getEnvOrThrow('ALLOWED_GROUP_ID'),
  ODIROUTER_API_KEY: getEnvOrThrow('ODIROUTER_API_KEY'),
  ODIROUTER_BASE_URL: process.env.ODIROUTER_BASE_URL?.trim() || 'https://odirouter.ai/v1',
  MODEL_NAME: process.env.MODEL_NAME?.trim() || 'free-gemini-3.1-flash-lite',
  FALLBACK_MODELS: (process.env.FALLBACK_MODELS || 'free-gemini-2.5-flash,free-gemini-3-flash-preview')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),
  DAILY_LIMIT_PER_MODEL: Number.parseInt(process.env.DAILY_LIMIT_PER_MODEL || '100', 10),
  PORT: Number.parseInt(process.env.PORT || '3000', 10),
  DATABASE_PATH: process.env.DATABASE_PATH?.trim() || path.resolve(process.cwd(), 'data', 'bot.db'),
  TAVILY_API_KEY: process.env.TAVILY_API_KEY?.trim() || '',
};

export function getAllConfiguredModels(): string[] {
  const models = [config.MODEL_NAME, ...config.FALLBACK_MODELS];
  return Array.from(new Set(models));
}

export function buildSystemPrompt(
  groupTitle: string,
  topicName: string = 'Общий чат',
  currentUserName: string = 'Участник',
  topicId?: number
): string {
  const topicDesc = topicId
    ? `«${topicName}» (ID темы: ${topicId})`
    : `«${topicName}»`;

  return [
    `Ты — ассистент группы «${groupTitle}».`,
    `Сейчас ты находишься и ведёшь диалог в теме (топике): ${topicDesc}.`,
    `ОБЯЗАТЕЛЬНО учитывай специфику, предметную область и контекст текущей темы (${topicDesc}) во всех ответах. Не путай контекст этой темы с другими темами группы. Если пользователь спрашивает, в какой теме вы находитесь или о чём эта тема — прямо называй тему ${topicDesc}.`,
    `Твой ТЕКУЩИЙ собеседник — ${currentUserName}. Отвечай конкретно ему на его вопрос или реплику в контексте текущей темы.`,
    `Сообщения других участников в этой теме используй исключительно как контекст обсуждения. Не отвечай за других.`,
    `Отвечай кратко, ёмко, по существу, вежливо и профессионально.`,
    `Для форматирования используй поддерживаемый Telegram HTML (<b>жирный</b>, <i>курсив</i>, <code>код</code>, <pre><code>блоки кода</code></pre>, <blockquote>цитаты</blockquote>). Не используй Markdown-заголовки со знаками # (для заголовков используй <b>жирный текст</b>).`,
    `База знаний и заметки группы: все ключи (теги) заметок ВСЕГДА обозначаются со знаком решётки # (например, #деплой, #пароли, #митинг, #правила). Для сохранения используй save_group_note, для поиска — get_group_notes, а для удаления выполненных задач или устаревших заметок — delete_group_note (всегда передавай ключ вида "#ключ"). В своих ответах, примерах и подсказках пользователям всегда пиши ключ через решётку (например: «Сохрани заметку #деплой: текст...», «Покажи #деплой» или «Удали #деплой»).`,
    `Если тебе нужны актуальные факты, текущая дата/время, информация из базы заметок группы или сохранение названия темы — вызывай соответствующие инструменты (functions/tools).`
  ].join('\n');
}
