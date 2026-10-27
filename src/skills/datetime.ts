import type { ChatCompletionTool } from 'openai/resources/chat/completions';

export const datetimeToolDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'get_current_datetime',
    description: 'Возвращает текущую дату, точное время, день недели и часовой пояс сервера.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

export async function executeGetCurrentDatetime(): Promise<string> {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'full',
    timeStyle: 'long',
    timeZone,
  }).format(now);

  return JSON.stringify({
    iso: now.toISOString(),
    formatted,
    timeZone,
    timestamp: now.getTime(),
  });
}
