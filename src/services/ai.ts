import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions';
import { config, getAllConfiguredModels } from '../config.js';
import { dbService, getTodayDateKey } from '../db/index.js';
import { availableTools, executeTool, type ToolExecutionContext } from '../skills/index.js';

export const openai = new OpenAI({
  apiKey: config.ODIROUTER_API_KEY,
  baseURL: config.ODIROUTER_BASE_URL,
});

const MAX_TOOL_ITERATIONS = 5;

export interface ModelStatusInfo {
  model: string;
  isPrimary: boolean;
  usedToday: number;
  limit: number;
  status: 'active' | 'exhausted' | 'standby';
}

/**
 * Проверяет, указывает ли ошибка на превышение суточного лимита/квоты или 429
 */
export function isRateLimitOrQuotaError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const status = (err as any)?.status;
  return (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('too many requests') ||
    msg.includes('limit exceeded') ||
    msg.includes('limit reached') ||
    msg.includes('100 requests')
  );
}

/**
 * Возвращает список кандидатов для текущего дня в порядке приоритета.
 * Модели, исчерпавшие дневной лимит, сдвигаются в конец либо исключаются.
 */
export function getActiveModelCandidates(): string[] {
  const allModels = getAllConfiguredModels();
  const today = getTodayDateKey();
  const limit = config.DAILY_LIMIT_PER_MODEL;

  const available = allModels.filter((model) => {
    const used = dbService.getModelUsage(model, today);
    return used < limit;
  });

  // Если все модели формально исчерпали лимит, пробуем все равно
  return available.length > 0 ? available : allModels;
}

/**
 * Возвращает сводку по текущему пулу моделей и использованию квоты за сегодня
 */
export function getModelPoolStatus(): {
  date: string;
  totalLimit: number;
  totalUsed: number;
  models: ModelStatusInfo[];
} {
  const today = getTodayDateKey();
  const allModels = getAllConfiguredModels();
  const limit = config.DAILY_LIMIT_PER_MODEL;
  const usage = dbService.getAllModelUsageForDay(today);

  let activeFound = false;
  let totalUsed = 0;

  const models: ModelStatusInfo[] = allModels.map((m, idx) => {
    const used = usage[m] || 0;
    totalUsed += used;
    const isPrimary = idx === 0;
    let status: 'active' | 'exhausted' | 'standby' = 'standby';

    if (used >= limit) {
      status = 'exhausted';
    } else if (!activeFound) {
      status = 'active';
      activeFound = true;
    }

    return {
      model: m,
      isPrimary,
      usedToday: used,
      limit,
      status,
    };
  });

  return {
    date: today,
    totalLimit: allModels.length * limit,
    totalUsed,
    models,
  };
}

/**
 * Выполнение цикла генерации и вызова инструментов для конкретной модели
 */
async function runModelCompletionLoop(
  model: string,
  messages: ChatCompletionMessageParam[],
  toolContext: ToolExecutionContext
): Promise<string> {
  const messageHistory: ChatCompletionMessageParam[] = [...messages];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await openai.chat.completions.create({
      model,
      messages: messageHistory,
      tools: availableTools,
      tool_choice: 'auto',
      temperature: 0.7,
    });

    const choice = response.choices[0];
    if (!choice || !choice.message) {
      throw new Error(`Модель ${model} не вернула ответа в choice.`);
    }

    const assistantMessage = choice.message;

    // Если модель не вызывает инструменты, возвращаем финальный ответ
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return assistantMessage.content || 'Ответ от модели пуст.';
    }

    // Сохраняем шаг ассистента с вызовами инструментов
    messageHistory.push(assistantMessage);

    // Выполняем каждый вызванный инструмент
    for (const toolCall of assistantMessage.tool_calls) {
      console.log(`[AI Tool Call] Executing: ${toolCall.function.name} with args: ${toolCall.function.arguments}`);

      let toolResult: string;
      try {
        toolResult = await executeTool(
          toolCall.function.name,
          toolCall.function.arguments,
          toolContext
        );
      } catch (toolError: unknown) {
        console.error(`[AI Tool Call Error] ${toolCall.function.name}:`, toolError);
        toolResult = JSON.stringify({
          error: `Ошибка вызова функции: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
        });
      }

      const toolMessage: ChatCompletionToolMessageParam = {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      };

      messageHistory.push(toolMessage);
    }
  }

  // Если достигнут лимит итераций, делаем один финальный запрос без tools
  const finalResponse = await openai.chat.completions.create({
    model,
    messages: messageHistory,
    temperature: 0.7,
  });

  return finalResponse.choices[0]?.message?.content || 'Завершено после выполнения инструментов.';
}

/**
 * Единый сервис LLM с мультимодальностью, подсчетом лимитов и автоматическим Failover
 */
export async function generateAIResponse(
  messages: ChatCompletionMessageParam[],
  toolContext: ToolExecutionContext
): Promise<string> {
  const candidates = getActiveModelCandidates();
  const today = getTodayDateKey();
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i++) {
    const currentModel = candidates[i];
    const isLastModel = i === candidates.length - 1;
    const currentUsage = dbService.getModelUsage(currentModel, today);

    console.log(
      `[AI Request] Отправка запроса к «${currentModel}» (${currentUsage + 1}/${config.DAILY_LIMIT_PER_MODEL} за ${today})`
    );

    try {
      const result = await runModelCompletionLoop(currentModel, messages, toolContext);
      // Успешно! Фиксируем инкремент счетчика
      dbService.incrementModelUsage(currentModel, today);
      return result;
    } catch (err: unknown) {
      lastError = err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[AI Failover] Модель «${currentModel}» вернула ошибку: ${errorMsg}`);

      // Если лимит исчерпан у провайдера, помечаем модель на сегодня
      if (isRateLimitOrQuotaError(err)) {
        console.warn(`[AI Failover] Превышен лимит квоты для «${currentModel}». Фиксируем исчерпание.`);
        dbService.setModelUsage(currentModel, config.DAILY_LIMIT_PER_MODEL, today);
      }

      if (isLastModel) {
        console.error('[AI Failover] Все доступные модели в пуле исчерпаны или недоступны.');
        throw err;
      }

      const nextModel = candidates[i + 1];
      console.log(`[AI Failover] Автоматическое переключение на следующую модель: «${nextModel}»...`);
    }
  }

  throw lastError || new Error('Не удалось получить ответ ни от одной модели из пула.');
}

