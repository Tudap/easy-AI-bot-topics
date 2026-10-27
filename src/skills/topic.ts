import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { dbService } from '../db/index.js';

export const setTopicNameToolDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'set_topic_name',
    description:
      'Установить или уточнить название текущей темы (топика) группы в памяти бота. Вызывай, когда пользователь просит запомнить или изменить название текущей темы, либо говорит, чему посвящена эта тема.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Название темы (например: «Разработка», «Дизайн», «Маркетинг», «Деплой и сервера»)',
        },
      },
      required: ['name'],
    },
  },
};

export async function executeSetTopicName(
  groupId: string,
  threadId: number | undefined,
  args: { name: string }
): Promise<string> {
  const name = (args.name || '').trim();
  if (!name) {
    return JSON.stringify({ success: false, error: 'Название темы не может быть пустым.' });
  }

  const tid = threadId ?? 1;
  dbService.saveTopic(groupId, tid, name);

  return JSON.stringify({
    success: true,
    message: `Тема #${tid} успешно названа «${name}» и сохранена в памяти бота.`,
    topic: {
      threadId: tid,
      name,
    },
  });
}
