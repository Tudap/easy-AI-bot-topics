/**
 * Безопасное экранирование и санитизация HTML для Telegram Bot API.
 * Поддерживаемые Telegram теги:
 * <b>, <i>, <u>, <s>, <code>, <pre>, <blockquote>, <a href="...">, <tg-spoiler>
 */

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Преобразует Markdown / смешанный ответ LLM в валидный Telegram HTML.
 */
export function formatAIResponseToHTML(text: string): string {
  if (!text) return '';

  // Шаг 1: Извлекаем блоки кода ```lang ... ```, чтобы не повредить их содержимое
  const codeBlocks: string[] = [];
  let processed = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escapedCode = escapeHtml(code.trimEnd());
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    const replacement = `<pre><code${langAttr}>${escapedCode}</code></pre>`;
    codeBlocks.push(replacement);
    return `@@CODE_BLOCK_${codeBlocks.length - 1}@@`;
  });

  // Шаг 2: Извлекаем инлайн-код `code`
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
    const escaped = `<code>${escapeHtml(code)}</code>`;
    inlineCodes.push(escaped);
    return `@@INLINE_CODE_${inlineCodes.length - 1}@@`;
  });

  // Шаг 3: Сохраняем уже существующие допустимые теги Telegram
  // Допустимые открывающие и закрывающие теги
  const allowedTagPattern = /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|blockquote|tg-spoiler)(?:\s+class="[^"]*")?>|<a\s+href="[^"]*">|<\/a>/gi;
  const preservedTags: string[] = [];
  processed = processed.replace(allowedTagPattern, (match) => {
    preservedTags.push(match);
    return `@@PRESERVED_TAG_${preservedTags.length - 1}@@`;
  });

  // Шаг 4: Экранируем все оставшиеся <, >, & в обычном тексте
  processed = escapeHtml(processed);

  // Шаг 5: Восстанавливаем сохраненные валидные HTML теги
  processed = processed.replace(/@@PRESERVED_TAG_(\d+)@@/g, (_, idx) => preservedTags[Number(idx)] || '');

  // Шаг 6: Конвертируем стандартный Markdown в HTML
  // Жирный: **текст** или __текст__
  processed = processed.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/(^|[^\w])__([^_]+)__([^\w]|$)/g, '$1<b>$2</b>$3');

  // Курсив: *текст* или _текст_ (не внутри слов)
  processed = processed.replace(/(^|[^\w])\*([^*\n]+)\*([^\w]|$)/g, '$1<i>$2</i>$3');
  processed = processed.replace(/(^|[^\w])_([^_\\n]+)_([^\w]|$)/g, '$1<i>$2</i>$3');

  // Зачеркнутый: ~~текст~~
  processed = processed.replace(/~~(.*?)~~/g, '<s>$1</s>');

  // Ссылки: [текст](url)
  processed = processed.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // Цитаты: строки начинающиеся с >
  const lines = processed.split('\n');
  const quoteGrouped: string[] = [];
  let inQuote = false;
  let currentQuote: string[] = [];

  for (const line of lines) {
    if (line.startsWith('&gt; ') || line.startsWith('> ')) {
      const cleanLine = line.replace(/^(?:&gt;|>)\s?/, '');
      inQuote = true;
      currentQuote.push(cleanLine);
    } else {
      if (inQuote) {
        quoteGrouped.push(`<blockquote>${currentQuote.join('\n')}</blockquote>`);
        currentQuote = [];
        inQuote = false;
      }
      quoteGrouped.push(line);
    }
  }
  if (inQuote) {
    quoteGrouped.push(`<blockquote>${currentQuote.join('\n')}</blockquote>`);
  }
  processed = quoteGrouped.join('\n');

  // Шаг 7: Возвращаем инлайн-код
  processed = processed.replace(/@@INLINE_CODE_(\d+)@@/g, (_, idx) => inlineCodes[Number(idx)] || '');

  // Шаг 8: Возвращаем блоки кода
  processed = processed.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, idx) => codeBlocks[Number(idx)] || '');

  return processed;
}
