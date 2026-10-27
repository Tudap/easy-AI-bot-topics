import type { Context } from 'grammy';
import { dbService, normalizeNoteKey } from '../db/index.js';
import { formatUserName } from '../services/reply-chain.js';
import { getTopicInfo } from '../services/topic.js';
import { generateAIResponse, getModelPoolStatus } from '../services/ai.js';
import { formatAIResponseToHTML } from '../utils/html.js';
import { sendLongMessage } from '../utils/chunker.js';

export async function handleHelpCommand(ctx: Context): Promise<void> {
  const me = ctx.me;
  const botHandle = me?.username ? `@${me.username}` : 'бота';
  const topicInfo = getTopicInfo(ctx);

  const helpText = [
    `🤖 <b>Командный AI-ассистент группы с поддержкой тем (топиков)</b>`,
    ``,
    `Я помогаю команде решать рабочие задачи, помню контекст диалога <b>раздельно по каждой теме</b>, анализирую код и изображения, веду базу знаний группы.`,
    ``,
    `<b>Как со мной общаться:</b>`,
    `• Упомяни меня: <code>${botHandle} твой вопрос</code>`,
    `• Сделай Reply на любое моё предыдущее сообщение`,
    `• Пришли фото или скриншот с подписью и упомяни меня`,
    ``,
    `<b>Управление темами форума:</b>`,
    `• <code>/topic</code> — Узнать текущую тему и статус памяти диалога в ней`,
    `• <code>/topic Название</code> — Задать или переименовать текущую тему для бота`,
    `• <code>/clear</code> — Очистить сохранённый контекст диалога <i>только в текущей теме</i>`,
    `• <code>/summary</code> — Краткая выжимка недавних обсуждений в этой теме`,
    ``,
    `<b>База знаний и заметки группы:</b>`,
    `• <code>/notes</code> — Список всех заметок и договорённостей группы`,
    `• <code>/delnote #ключ</code> — Удалить выполненную задачу или заметку`,
    `• Или просто напиши: «<i>${botHandle} сохрани #деплой: инструкция...</i>»`,
    ``,
    `<b>Системные команды:</b>`,
    `• <code>/status</code> — Статус AI-моделей, суточных лимитов и квот`,
    `• <code>/help</code> — Эта справка`,
    ``,
    `<b>Встроенные навыки:</b>`,
    `• <i>Поиск в интернете</i> — актуальные данные, новости, документация`,
    `• <i>Точное время и дата</i> — текущее время в любой момент`,
    `• <i>Память тем</i> — бот понимает, в какой теме находится, и помнит нить разговора`,
  ].join('\n');

  await ctx.reply(helpText, {
    parse_mode: 'HTML',
    message_thread_id: topicInfo.rawThreadId,
    reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
  });
}

export async function handleTopicCommand(ctx: Context): Promise<void> {
  const topicInfo = getTopicInfo(ctx);
  const chatId = ctx.chat?.id.toString() || '';
  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const newName = parts.slice(1).join(' ').trim();

  // Если передано новое имя — переименовываем тему в базе данных
  if (newName) {
    const tid = topicInfo.threadId ?? 1;
    dbService.saveTopic(chatId, tid, newName);

    await ctx.reply(
      `✅ Название темы успешно сохранено: <b>«${newName}»</b>!\n\nТеперь бот знает, что этот топик называется «<b>${newName}</b>», и будет учитывать это при ответах.`,
      {
        parse_mode: 'HTML',
        message_thread_id: topicInfo.rawThreadId,
        reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
      }
    );
    return;
  }

  // Если аргументов нет — показываем информацию о текущей теме
  const msgCount = dbService.getThreadMessageCount(topicInfo.storageThreadId);
  const infoLines = [
    `📌 <b>Информация о текущей теме:</b>`,
    ``,
    `• <b>Название темы:</b> «<b>${topicInfo.name}</b>»`,
    `• <b>ID темы (thread_id):</b> <code>${topicInfo.threadId ?? 1}</code>`,
    `• <b>Сообщений в памяти этой темы:</b> <b>${msgCount}</b>`,
    `• <b>Режим форума (topics):</b> ${topicInfo.isForum ? 'включён ✅' : 'обычный чат'}`,
    ``,
    `💡 <i>Чтобы задать или изменить понятное название для этой темы, напишите:</i>\n<code>/topic Ваше Название</code>`,
  ];

  await ctx.reply(infoLines.join('\n'), {
    parse_mode: 'HTML',
    message_thread_id: topicInfo.rawThreadId,
    reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
  });
}

export async function handleClearCommand(ctx: Context): Promise<void> {
  const topicInfo = getTopicInfo(ctx);
  const deletedCount = dbService.clearThread(topicInfo.storageThreadId);

  await ctx.reply(
    `🧹 Контекст темы «<b>${topicInfo.name}</b>» очищен (удалено записей: <b>${deletedCount}</b>).\nБот готов к новым обсуждениям в этой теме!`,
    {
      parse_mode: 'HTML',
      message_thread_id: topicInfo.rawThreadId,
      reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
    }
  );
}

export async function handleNotesCommand(ctx: Context): Promise<void> {
  const groupId = ctx.chat?.id.toString() || '';
  const topicInfo = getTopicInfo(ctx);
  const notes = dbService.listNotes(groupId);
  const botHandle = ctx.me?.username ? `@${ctx.me.username}` : '@bot';

  if (notes.length === 0) {
    await ctx.reply(
      `📝 В базе знаний группы пока нет заметок. Вы можете сказать боту, например:\n<code>${botHandle} сохрани #деплой: инструкция по выкатке...</code>`,
      {
        parse_mode: 'HTML',
        message_thread_id: topicInfo.rawThreadId,
        reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
      }
    );
    return;
  }

  const lines = ['📋 <b>Заметки и решения группы:</b>', ''];
  for (const n of notes) {
    const dateStr = new Date(n.updated_at).toLocaleDateString('ru-RU');
    lines.push(`• <b>${n.key}</b> (от ${n.author}, ${dateStr}):\n${n.content}\n`);
  }

  await sendLongMessage(ctx, lines.join('\n'), ctx.message?.message_id, topicInfo.rawThreadId);
}

export async function handleSummaryCommand(ctx: Context): Promise<void> {
  const topicInfo = getTopicInfo(ctx);
  const groupTitle = ctx.chat?.title || 'Рабочая группа';
  const recentMessages = dbService.getRecentMessages(topicInfo.storageThreadId, 30);

  if (recentMessages.length < 2) {
    await ctx.reply(
      `ℹ️ В теме «<b>${topicInfo.name}</b>» пока недостаточно сохраненных сообщений для саммари.`,
      {
        parse_mode: 'HTML',
        message_thread_id: topicInfo.rawThreadId,
        reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
      }
    );
    return;
  }

  await ctx.replyWithChatAction('typing');

  const formattedHistory = recentMessages
    .map((m) => `${m.role === 'assistant' ? '[Бот]' : `[${m.author}]`}: ${m.content}`)
    .join('\n');

  const summaryPrompt = [
    {
      role: 'system' as const,
      content:
        `Ты — аналитик команды. Сделай краткое, структурированное саммари недавней переписки в теме «${topicInfo.name}» группы «${groupTitle}». Выдели: 1) Ключевые темы обсуждения; 2) Принятые решения / соглашения; 3) Нерешенные вопросы / следующие шаги. Форматируй в чистый HTML для Telegram.`,
    },
    {
      role: 'user' as const,
      content: `Вот недавние сообщения из темы «${topicInfo.name}»:\n\n${formattedHistory}`,
    },
  ];

  try {
    const rawSummary = await generateAIResponse(summaryPrompt, {
      groupId: ctx.chat?.id.toString() || '',
      author: formatUserName(ctx.from),
      threadId: topicInfo.threadId,
    });

    const htmlResponse = formatAIResponseToHTML(rawSummary);
    await sendLongMessage(
      ctx,
      `📊 <b>Саммари обсуждения в теме «${topicInfo.name}»:</b>\n\n${htmlResponse}`,
      ctx.message?.message_id,
      topicInfo.rawThreadId
    );
  } catch (err) {
    console.error('[Summary] Error generating summary:', err);
    await ctx.reply('❌ Не удалось сгенерировать саммари. Попробуйте позже.', {
      message_thread_id: topicInfo.rawThreadId,
      reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
    });
  }
}

export async function handleDeleteNoteCommand(ctx: Context): Promise<void> {
  const groupId = ctx.chat?.id.toString() || '';
  const topicInfo = getTopicInfo(ctx);
  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const rawKey = parts.slice(1).join(' ').trim();

  if (!rawKey) {
    await ctx.reply(
      'ℹ️ Укажите ключ заметки или задачи для удаления.\n<i>Пример:</i> <code>/delnote #деплой</code>',
      {
        parse_mode: 'HTML',
        message_thread_id: topicInfo.rawThreadId,
        reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
      }
    );
    return;
  }

  const key = normalizeNoteKey(rawKey);
  const deleted = dbService.deleteNote(groupId, key);

  if (deleted) {
    await ctx.reply(
      `🗑 Заметка <b>${key}</b> успешно удалена из базы знаний группы.`,
      {
        parse_mode: 'HTML',
        message_thread_id: topicInfo.rawThreadId,
        reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
      }
    );
  } else {
    await ctx.reply(
      `⚠️ Заметка с ключом <b>${key}</b> не найдена в базе знаний группы.`,
      {
        parse_mode: 'HTML',
        message_thread_id: topicInfo.rawThreadId,
        reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
      }
    );
  }
}

export async function handleStatusCommand(ctx: Context): Promise<void> {
  const topicInfo = getTopicInfo(ctx);
  const poolStatus = getModelPoolStatus();
  const lines = [
    `📊 <b>Статус AI-моделей и лимитов на сегодня</b> (<code>${poolStatus.date}</code>):`,
    '',
  ];

  for (const m of poolStatus.models) {
    const roleTag = m.isPrimary ? ' ⭐ <i>(основная)</i>' : ' 🔄 <i>(резерв)</i>';
    let statusIcon = '🟢';
    let statusText = 'готов';
    if (m.status === 'active') {
      statusIcon = '⚡';
      statusText = 'активна сейчас';
    } else if (m.status === 'exhausted') {
      statusIcon = '🔴';
      statusText = 'лимит исчерпан';
    }

    lines.push(
      `${statusIcon} <code>${m.model}</code>${roleTag}\n   Использовано: <b>${m.usedToday}/${m.limit}</b> [${statusText}]`
    );
  }

  lines.push('');
  lines.push(`📈 Всего использовано: <b>${poolStatus.totalUsed}/${poolStatus.totalLimit}</b> запросов.`);
  lines.push('💡 <i>В начале каждых суток (00:00) счётчики обнуляются и бот возвращается на основную модель. При исчерпании лимита или недоступности модели переключение происходит автоматически.</i>');

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    message_thread_id: topicInfo.rawThreadId,
    reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
  });
}
