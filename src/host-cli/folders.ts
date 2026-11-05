import { conversationFolderOrder, conversationFoldersSchema, FOLDER_PIN_CAPABILITY, folderChangeSchema } from '../client-protocol/conversation-folders.js';
import type { LocalHostClient } from './client.js';

export async function runFoldersCommand(client: Pick<LocalHostClient, 'request' | 'ready'>, action: string | undefined, id: string | undefined, flags: { unfiled?: boolean; enabled?: string; revision?: string }) {
  const route = '/api/conversation-folders';
  if (action === 'list') {
    if (id !== undefined || flags.unfiled !== undefined || flags.enabled !== undefined || flags.revision !== undefined) throw new Error('folders list 不接受修改参数。');
    const state = conversationFoldersSchema.parse(await client.request(route));
    return { ...state, order: conversationFolderOrder(state) };
  }
  if (action !== 'pin') throw new Error('请使用 folders list 或 folders pin ID --enabled on|off --revision N；未分组用 --unfiled 代替 ID。');
  if (!client.ready.serverCapabilities.includes(FOLDER_PIN_CAPABILITY)) throw new Error('请更新主机后使用置顶分组。');
  if (flags.unfiled ? id !== undefined : !id) throw new Error('请指定分组 ID，或单独使用 --unfiled。');
  if (!['on', 'off'].includes(flags.enabled ?? '') || !/^\d+$/.test(flags.revision ?? '')) throw new Error('先用 folders list 读取 revision，再用 --enabled on|off --revision N 提交。');
  const command = folderChangeSchema.parse({ type: 'pin', id: flags.unfiled ? null : id, pinned: flags.enabled === 'on', revision: Number(flags.revision) });
  // Same revision-checked API as the Apps. Never retry an uncertain mutation.
  const state = conversationFoldersSchema.parse(await client.request(route, 'PATCH', command));
  return { ...state, order: conversationFolderOrder(state) };
}
