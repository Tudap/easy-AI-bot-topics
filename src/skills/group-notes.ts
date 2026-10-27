import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { dbService, normalizeNoteKey } from '../db/index.js';

export const saveGroupNoteToolDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'save_group_note',
    description: 'Сохранить важную договоренность, факт, заметку, регламент или задачу группы в базу знаний. Ключи заметок всегда обозначаются через знак решётки # (например, "#деплой", "#сервер", "#пароли").',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Короткий идентификатор/хэштег заметки со знаком # перед ним (например, "#деплой", "#пароли_тест", "#митинг", "#задача_дизайн")',
        },
        content: {
          type: 'string',
          description: 'Текст заметки или решения команды',
        },
      },
      required: ['key', 'content'],
    },
  },
};

export const getGroupNotesToolDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'get_group_notes',
    description: 'Получить список сохраненных заметок и решений группы, либо прочитать конкретную заметку по ключу-хэштегу (например, "#деплой").',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Необязательный ключ заметки с решёткой # для точного поиска (например, "#деплой"). Если не указан — возвращает все заметки группы.',
        },
      },
      required: [],
    },
  },
};

export async function executeSaveGroupNote(
  groupId: string,
  author: string,
  args: { key: string; content: string }
): Promise<string> {
  const key = normalizeNoteKey(args.key || '');
  const content = args.content?.trim();

  if (!key || !content) {
    return JSON.stringify({ success: false, error: 'Ключ (#хэштег) и содержание заметки обязательны.' });
  }

  dbService.saveNote({
    groupId,
    key,
    content,
    author,
  });

  return JSON.stringify({
    success: true,
    message: `Заметка «${key}» успешно сохранена в базе знаний группы.`,
  });
}

export async function executeGetGroupNotes(
  groupId: string,
  args: { key?: string }
): Promise<string> {
  if (args.key?.trim()) {
    const key = normalizeNoteKey(args.key);
    const note = dbService.getNote(groupId, key);
    if (!note) {
      return JSON.stringify({
        found: false,
        message: `Заметка с ключом «${key}» не найдена.`,
      });
    }
    return JSON.stringify({
      found: true,
      note: {
        key: note.key,
        content: note.content,
        author: note.author,
        updated_at: new Date(note.updated_at).toLocaleString('ru-RU'),
      },
    });
  }

  const notes = dbService.listNotes(groupId);
  if (notes.length === 0) {
    return JSON.stringify({
      found: false,
      message: 'В базе знаний группы пока нет сохраненных заметок.',
      notes: [],
    });
  }

  return JSON.stringify({
    found: true,
    count: notes.length,
    notes: notes.map((n) => ({
      key: n.key,
      content: n.content,
      author: n.author,
      updated_at: new Date(n.updated_at).toLocaleString('ru-RU'),
    })),
  });
}

export const deleteGroupNoteToolDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'delete_group_note',
    description: 'Удалить выполненную задачу, устаревшую договоренность или заметку из базы знаний группы по её ключу/хэштегу.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Ключ или хэштег заметки/задачи со знаком # перед ним для удаления (например, "#деплой", "#дизайн", "#баг")',
        },
      },
      required: ['key'],
    },
  },
};

export async function executeDeleteGroupNote(
  groupId: string,
  args: { key: string }
): Promise<string> {
  const key = normalizeNoteKey(args.key || '');
  if (!key) {
    return JSON.stringify({ success: false, error: 'Ключ (#хэштег) заметки для удаления обязателен.' });
  }

  const deleted = dbService.deleteNote(groupId, key);
  if (!deleted) {
    return JSON.stringify({
      success: false,
      message: `Заметка с ключом «${key}» не найдена в базе знаний группы.`,
    });
  }

  return JSON.stringify({
    success: true,
    message: `Заметка «${key}» успешно удалена из базы знаний группы.`,
  });
}
