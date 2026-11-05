import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conversationSchema } from '../client-protocol/index.js';
import { CONVERSATION_BATCH_CAPABILITY, CONVERSATION_RESTORE_CAPABILITY, conversationBatchSchema, conversationBatchResultSchema } from '../client-protocol/conversation-batch.js';
import { HostCliError, type LocalHostClient } from './client.js';

export async function runConversationsCommand(client: Pick<LocalHostClient, 'request' | 'ready'>, action: string | undefined,
  flags: { ids?: string; yes?: boolean; folder?: string; unfiled?: boolean; newFolder?: string; revision?: string; requestId?: string },
  announce: (requestId: string) => void = () => undefined) {
  if (action === 'local') {
    if (Object.values(flags).some(value => value !== undefined)) throw new Error('conversations local 不接受修改参数。');
    return z.array(conversationSchema).parse(await client.request('/api/conversations'));
  }
  if (!['archive', 'restore', 'move'].includes(action ?? '')) throw new Error('使用 conversations local、archive、restore 或 move。');
  if (!client.ready.serverCapabilities.includes(CONVERSATION_BATCH_CAPABILITY)) throw new Error('请更新主机后使用批量整理对话。');
  if (action === 'restore' && !client.ready.serverCapabilities.includes(CONVERSATION_RESTORE_CAPABILITY)) throw new Error('请更新主机后使用恢复对话。');
  const requestId = flags.requestId ?? `cb_${randomUUID()}`;
  const conversationIds = flags.ids?.split(',').map(id => id.trim());
  let input;
  if (action === 'archive' || action === 'restore') {
    if (flags.folder !== undefined || flags.unfiled !== undefined || flags.newFolder !== undefined || flags.revision !== undefined) throw new Error(`${action} 不接受分组参数。`);
    if (flags.yes !== true) throw new Error(action === 'restore' ? '核对对话 ID 后加 --yes 恢复 App 对话；不会重启 Bot 或自动恢复讨论。' : '核对对话 ID 后加 --yes：可恢复归档，群内话题一并隐藏，当前回复继续，自动讨论在当前发言后暂停。');
    input = conversationBatchSchema.parse({ requestId, conversationIds, action });
  } else {
    if (flags.yes !== undefined) throw new Error('move 不接受 --yes。');
    if ([flags.folder !== undefined, flags.unfiled === true, flags.newFolder !== undefined].filter(Boolean).length !== 1 || flags.unfiled === false) throw new Error('请选择 --folder ID、--unfiled 或 --new-folder NAME 中的一项。');
    if (!/^\d+$/.test(flags.revision ?? '')) throw new Error('先用 folders list 读取 revision，再用 --revision N 提交。');
    input = conversationBatchSchema.parse({ requestId, conversationIds, action, revision: Number(flags.revision),
      target: flags.newFolder !== undefined ? { newFolder: { id: `folder_${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`, name: flags.newFolder } } : { folderId: flags.unfiled ? null : flags.folder } });
  }
  announce(requestId);
  try { return conversationBatchResultSchema.parse(await client.request('/api/conversations/batch', 'POST', input)); }
  catch (error) {
    if (error instanceof HostCliError) {
      const hints: Record<string, string> = {
        conversation_batch_topic_move: '话题随所属群组分组，请改用群 ID。',
        folders_changed: '分组已变化，先运行 folders list 读取最新 revision，再核对并提交新操作。',
        conversation_forbidden: '无权操作某个对话，请用 conversations local 核对可用 ID。',
        conversation_owner_required: '只有创建者可以归档或恢复对话；本次未作更改。',
        conversation_not_available: action === 'restore' ? '所属群组仍已归档，请先恢复群组或与话题一并选中。' : '对话已归档或不可用，请重新核对列表。',
        bot_deleted: '对话所属 Bot 已删除，无法恢复；请用 conversations local 核对目标。',
        conversation_batch_request_conflict: '此 request-id 已用于不同内容；核对原操作，勿复用编号修改目标。',
        folder_not_found: '目标分组不存在，请运行 folders list 核对。',
        folder_name_exists: '已有同名分组，请选择该分组或换一个名称。',
      };
      if (hints[error.code]) error.message = `${error.code}：${hints[error.code]}`;
    }
    throw error;
  }
}
