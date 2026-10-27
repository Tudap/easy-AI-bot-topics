import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { datetimeToolDefinition, executeGetCurrentDatetime } from './datetime.js';
import { executeWebSearch, webSearchToolDefinition } from './web-search.js';
import {
  deleteGroupNoteToolDefinition,
  executeDeleteGroupNote,
  executeGetGroupNotes,
  executeSaveGroupNote,
  getGroupNotesToolDefinition,
  saveGroupNoteToolDefinition,
} from './group-notes.js';

export const availableTools: ChatCompletionTool[] = [
  datetimeToolDefinition,
  webSearchToolDefinition,
  saveGroupNoteToolDefinition,
  getGroupNotesToolDefinition,
  deleteGroupNoteToolDefinition,
];

export interface ToolExecutionContext {
  groupId: string;
  author: string;
}

export async function executeTool(
  name: string,
  argsJson: string,
  context: ToolExecutionContext
): Promise<string> {
  let parsedArgs: Record<string, any> = {};
  try {
    parsedArgs = argsJson ? JSON.parse(argsJson) : {};
  } catch (parseErr) {
    return JSON.stringify({ error: `Неверный JSON аргументов: ${String(parseErr)}` });
  }

  switch (name) {
    case 'get_current_datetime':
      return executeGetCurrentDatetime();

    case 'web_search':
      return executeWebSearch({ query: parsedArgs.query || '' });

    case 'save_group_note':
      return executeSaveGroupNote(context.groupId, context.author, {
        key: parsedArgs.key || '',
        content: parsedArgs.content || '',
      });

    case 'get_group_notes':
      return executeGetGroupNotes(context.groupId, {
        key: parsedArgs.key,
      });

    case 'delete_group_note':
      return executeDeleteGroupNote(context.groupId, {
        key: parsedArgs.key || '',
      });

    default:
      return JSON.stringify({ error: `Неизвестный инструмент: ${name}` });
  }
}
