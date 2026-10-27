import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { config } from '../config.js';

export const webSearchToolDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Поиск актуальной информации, новостей, фактов и документации в интернете.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Поисковый запрос на русском или английском языке',
        },
      },
      required: ['query'],
    },
  },
};

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export async function executeWebSearch(args: { query: string }): Promise<string> {
  const query = args.query?.trim();
  if (!query) {
    return JSON.stringify({ error: 'Пустой поисковый запрос.' });
  }

  // 1. Если настроен Tavily API — используем его
  if (config.TAVILY_API_KEY) {
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: config.TAVILY_API_KEY,
          query,
          search_depth: 'basic',
          max_results: 5,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as { results?: Array<{ title: string; url: string; content: string }> };
        const results = (data.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content,
        }));
        return JSON.stringify({ source: 'tavily', results });
      }
    } catch (tavilyErr) {
      console.warn('[WebSearch] Tavily search failed, falling back to DuckDuckGo:', tavilyErr);
    }
  }

  // 2. DuckDuckGo HTML / Lite поиск без API ключа
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    // Регулярное выражение для извлечения блоков результатов поиска DuckDuckGo HTML
    const resultBlockRegex = /<a class="result__snippet[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const titleRegex = /<a class="result__url[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

    // Парсим сниппеты
    const rawMatches = [...html.matchAll(/<div class="result__body">([\s\S]*?)<\/div>/gi)];

    for (const match of rawMatches.slice(0, 5)) {
      const block = match[1];
      const titleMatch = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      const snippetMatch = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);

      if (titleMatch) {
        let cleanUrl = titleMatch[1];
        // DuckDuckGo часто оборачивает ссылки в редирект /l/?kh=-1&uddg=...
        const uddgMatch = /uddg=([^&]+)/.exec(cleanUrl);
        if (uddgMatch) {
          cleanUrl = decodeURIComponent(uddgMatch[1]);
        }

        const cleanTitle = titleMatch[2].replace(/<[^>]*>/g, '').trim();
        const cleanSnippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '';

        results.push({
          title: cleanTitle,
          url: cleanUrl,
          content: cleanSnippet,
        });
      }
    }

    if (results.length > 0) {
      return JSON.stringify({ source: 'duckduckgo', results });
    }

    // Если парсинг ничего не нашел — возвращаем статус
    return JSON.stringify({
      source: 'duckduckgo',
      message: 'По вашему запросу не удалось извлечь структурированные результаты. Попробуйте уточнить запрос.',
      results: [],
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[WebSearch] Error searching:', errorMsg);
    return JSON.stringify({
      error: `Ошибка при выполнении веб-поиска: ${errorMsg}`,
    });
  }
}
