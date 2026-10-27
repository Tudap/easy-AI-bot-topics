import type { Context } from 'grammy';

const MAX_CHUNK_LENGTH = 3900;
const CHUNK_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Разбивает длинный текст на части не длиннее maxLen,
 * стараясь делить по абзацам (\n\n), строкам (\n) или пробелам.
 */
export function splitIntoChunks(text: string, maxLen = MAX_CHUNK_LENGTH): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = -1;

    // Ищем перевод строки (абзац)
    const doubleNewlineIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (doubleNewlineIdx > maxLen * 0.5) {
      splitIndex = doubleNewlineIdx + 2;
    } else {
      // Ищем одиночный перевод строки
      const singleNewlineIdx = remaining.lastIndexOf('\n', maxLen);
      if (singleNewlineIdx > maxLen * 0.5) {
        splitIndex = singleNewlineIdx + 1;
      } else {
        // Ищем пробел
        const spaceIdx = remaining.lastIndexOf(' ', maxLen);
        if (spaceIdx > maxLen * 0.3) {
          splitIndex = spaceIdx + 1;
        } else {
          // Жёсткий разрез, если нет разделителей
          splitIndex = maxLen;
        }
      }
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Отправляет длинное сообщение по частям с задержкой 300мс и авто-фоллбэком на чистый текст.
 */
export async function sendLongMessage(
  ctx: Context,
  text: string,
  replyToMessageId?: number
): Promise<number | undefined> {
  const chunks = splitIntoChunks(text);
  let firstSentMessageId: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isFirstChunk = i === 0;

    const extra: Parameters<typeof ctx.reply>[1] = {
      parse_mode: 'HTML',
      reply_parameters: isFirstChunk && replyToMessageId ? { message_id: replyToMessageId } : undefined,
    };

    try {
      const sent = await ctx.reply(chunk, extra);
      if (isFirstChunk && sent?.message_id) {
        firstSentMessageId = sent.message_id;
      }
    } catch (err: unknown) {
      // Если Telegram отклонил разметку HTML (например, незакрытый тег на стыке кусков),
      // отправляем как обычный текст без parse_mode
      console.warn('[Chunker] HTML parse error, fallback to plain text:', err);
      try {
        const plainText = chunk.replace(/<[^>]*>/g, '');
        const sent = await ctx.reply(plainText, {
          reply_parameters: isFirstChunk && replyToMessageId ? { message_id: replyToMessageId } : undefined,
        });
        if (isFirstChunk && sent?.message_id) {
          firstSentMessageId = sent.message_id;
        }
      } catch (fallbackErr) {
        console.error('[Chunker] Failed to send fallback message:', fallbackErr);
      }
    }

    // Задержка между кусками для исключения 429
    if (i < chunks.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }

  return firstSentMessageId;
}
