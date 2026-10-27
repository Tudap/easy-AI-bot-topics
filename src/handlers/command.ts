import type { Context } from 'grammy';
import { dbService, normalizeNoteKey } from '../db/index.js';
import { formatUserName, getThreadId } from '../services/reply-chain.js';
import { generateAIResponse, getModelPoolStatus } from '../services/ai.js';
import { formatAIResponseToHTML } from '../utils/html.js';
import { sendLongMessage } from '../utils/chunker.js';

export async function handleHelpCommand(ctx: Context): Promise<void> {
  const me = ctx.me;
  const botHandle = me?.username ? `@${me.username}` : 'бота';

  const helpText = [
    `🤖 <b>Командный AI-ассистент группы</b>`,
    ``,
    `Я помогаю команде решать рабочие задачи, анализирую код, изображения и веду базу знаний проекта.`,
    ``,
    `<b>Как со мной общаться:</b>`,
    `• Упомяни меня: <code>${botHandle} твой вопрос</code>`,
    `• Сделай Reply на любое моё предыдущее сообщение`,
    `• Пришли фото или скриншот с подписью и упомяни меня`,
    ``,
    `<b>Команды:</b>`,
    `• <code>/help</code> — Справка по работе с ботом`,
    `• <code>/status</code> — Статус моделей, лимитов запросов и активной модели`,
    `• <code>/summary</code> — Краткая выжимка недавних обсуждений в этом топике`,
    `• <code>/notes</code> — Список сохранённых заметок и договорённостей группы`,
    `• <code>/delnote #ключ</code> — Удалить выполненную задачу или заметку`,
    `• <code>/clear</code> — Очистить сохранённый контекст диалога в этом топике`,
    ``,
    `<b>Встроенные навыки:</b>`,
    `• <i>Поиск в интернете</i> — найду свежую инфу, новости или документацию`,
    `• <i>Точное время и дата</i> — подскажу время в любой момент`,
    `• <i>Заметки группы</i> — попроси меня «запомни #пароли: ...» или «сохрани #деплой: ...»`,
  ].join('\n');

  await ctx.reply(helpText, {
    parse_mode: 'HTML',
    reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
  });
}

export async function handleClearCommand(ctx: Context): Promise<void> {
  const threadId = getThreadId(ctx);
  const deletedCount = dbService.clearThread(threadId);

  await ctx.reply(
    `🧹 Контекст топика очищен (удалено записей: <b>${deletedCount}</b>). Готов к новым вопросам!`,
    {
      parse_mode: 'HTML',
      reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
    }
  );
}

export async function handleNotesCommand(ctx: Context): Promise<void> {
  const groupId = ctx.chat?.id.toString() || '';
  const notes = dbService.listNotes(groupId);
  const botHandle = ctx.me?.username ? `@${ctx.me.username}` : '@bot';

  if (notes.length === 0) {
    await ctx.reply(
      `📝 В базе знаний группы пока нет заметок. Вы можете сказать боту, например:\n<code>${botHandle} сохрани #деплой: инструкция по выкатке...</code>`,
      {
        parse_mode: 'HTML',
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

  await sendLongMessage(ctx, lines.join('\n'), ctx.message?.message_id);
}

export async function handleSummaryCommand(ctx: Context): Promise<void> {
  const threadId = getThreadId(ctx);
  const recentMessages = dbService.getRecentMessages(threadId, 30);

  if (recentMessages.length < 2) {
    await ctx.reply(
      'ℹ️ В этом топике пока недостаточно сохраненных сообщений для саммари.',
      { reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined }
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
        'Ты — аналитик команды. Сделай краткое, структурированное саммари недавней переписки в группе. Выдели: 1) Ключевые темы обсуждения; 2) Принятые решения / соглашения; 3) Нерешенные вопросы / следующие шаги. Форматируй в чистый HTML для Telegram.',
    },
    {
      role: 'user' as const,
      content: `Вот недавние сообщения:\n\n${formattedHistory}`,
    },
  ];

  try {
    const rawSummary = await generateAIResponse(summaryPrompt, {
      groupId: ctx.chat?.id.toString() || '',
      author: formatUserName(ctx.from),
    });

    const htmlResponse = formatAIResponseToHTML(rawSummary);
    await sendLongMessage(ctx, `📊 <b>Саммари обсуждения:</b>\n\n${htmlResponse}`, ctx.message?.message_id);
  } catch (err) {
    console.error('[Summary] Error generating summary:', err);
    await ctx.reply('❌ Не удалось сгенерировать саммари. Попробуйте позже.', {
      reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
    });
  }
}

export async function handleDeleteNoteCommand(ctx: Context): Promise<void> {
  const groupId = ctx.chat?.id.toString() || '';
  const text = ctx.message?.text || '';
  const parts = text.trim().split(/\s+/);
  const rawKey = parts.slice(1).join(' ').trim();

  if (!rawKey) {
    await ctx.reply(
      'ℹ️ Укажите ключ заметки или задачи для удаления.\n<i>Пример:</i> <code>/delnote #деплой</code>',
      {
        parse_mode: 'HTML',
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
        reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
      }
    );
  } else {
    await ctx.reply(
      `⚠️ Заметка с ключом <b>${key}</b> не найдена в базе знаний группы.`,
      {
        parse_mode: 'HTML',
        reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
      }
    );
  }
}

export async function handleStatusCommand(ctx: Context): Promise<void> {
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
    reply_parameters: ctx.message?.message_id ? { message_id: ctx.message.message_id } : undefined,
  });
}


