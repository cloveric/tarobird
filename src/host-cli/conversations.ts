import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { conversationSchema, idSchema } from '../client-protocol/index.js';
import { CONVERSATION_BATCH_CAPABILITY, CONVERSATION_RESTORE_CAPABILITY, conversationBatchSchema, conversationBatchResultSchema } from '../client-protocol/conversation-batch.js';
import { CONVERSATION_PINS_CAPABILITY, conversationPinsSchema, pinChangeSchema } from '../client-protocol/conversation-pins.js';
import { createBotSchema, type BotCatalog, type CreateBotInput } from '../client-protocol/bots.js';
import { ENGINE_QUOTA_CAPABILITY, quotaDirectorySchema, type QuotaDirectory } from '../client-protocol/engine-quota.js';
import { HOST_BALANCE_RESOURCES_CAPABILITY, HOST_BALANCE_RESOURCES_PATH, hostBalanceResourcesSchema } from '../client-protocol/host-balance-resources.js';
import {
  evaluateHostEngineCandidate,
  isQuotaScopeExhausted,
  isQuotaScopeLoginRequired,
  selectBalancedHost,
  type HostBalanceCandidate,
} from '../client-protocol/host-balancer.js';
import { HostCliError, type LocalHostClient } from './client.js';

export async function runConversationPinsCommand(
  client: Pick<LocalHostClient, 'request' | 'ready'>,
  action: 'pins' | 'pin',
  id: string | undefined,
  flags: { global?: boolean; enabled?: string; revision?: string },
) {
  const route = '/api/conversation-pins';
  if (!client.ready.serverCapabilities.includes(CONVERSATION_PINS_CAPABILITY)) throw new Error('请更新主机后使用同步置顶。');
  if (action === 'pins') {
    if (id !== undefined || flags.global !== undefined || flags.enabled !== undefined || flags.revision !== undefined) {
      throw new Error('conversations pins 不接受修改参数。');
    }
    return conversationPinsSchema.parse(await client.request(route));
  }
  if (!id) throw new Error('请指定对话 ID。');
  if (!['on', 'off'].includes(flags.enabled ?? '') || !/^\d+$/.test(flags.revision ?? '')) {
    throw new Error('先用 conversations pins 读取 revision，再用 --enabled on|off --revision N 提交。');
  }
  const command = pinChangeSchema.parse({
    type: 'set',
    scope: flags.global ? 'global' : 'group',
    conversationId: id,
    pinned: flags.enabled === 'on',
    revision: Number(flags.revision),
  });
  try {
    return conversationPinsSchema.parse(await client.request(route, 'PATCH', command));
  } catch (error) {
    if (error instanceof HostCliError) {
      const hints: Record<string, string> = {
        pins_changed: '置顶状态已在其他设备更新，先运行 conversations pins 读取最新 revision 再重试。',
        conversation_not_available: '对话已归档、不可用或无权访问，请用 conversations local 核对可用 ID。',
        pin_limit: '置顶对话数量已达上限。',
      };
      if (hints[error.code]) error.message = `${error.code}：${hints[error.code]}`;
    }
    throw error;
  }
}

export async function runConversationsCommand(client: Pick<LocalHostClient, 'request' | 'ready'>, action: string | undefined,
  flags: { ids?: string; yes?: boolean; folder?: string; unfiled?: boolean; newFolder?: string; revision?: string; requestId?: string; host?: string; engine?: string; model?: string; title?: string; workspace?: string; bot?: string },
  announce: (requestId: string) => void = () => undefined) {
  if (action === 'local') {
    if (Object.values(flags).some(value => value !== undefined)) throw new Error('conversations local 不接受修改参数。');
    return z.array(conversationSchema).parse(await client.request('/api/conversations'));
  }
  if (action === 'create') {
    if ([flags.ids, flags.yes, flags.folder, flags.unfiled, flags.newFolder, flags.revision].some(value => value !== undefined)) {
      throw new Error('conversations create 不接受批量整理参数。');
    }
    if (flags.host && flags.host !== 'auto' && flags.host !== 'local') {
      throw new Error('conversations create 目前支持 --host auto 或本地主机（省略 --host）。');
    }
    const rawEngine = flags.engine?.trim();
    const botFlag = flags.bot?.trim();
    if (!botFlag && !rawEngine) {
      throw new Error('conversations create 需要 --bot ID 或 --engine ENGINE。');
    }
    let engine: CreateBotInput['engine'] | undefined;
    if (rawEngine) {
      const parsedEngine = createBotSchema.shape.engine.safeParse(rawEngine);
      if (!parsedEngine.success) throw new Error(`不支持的引擎：${rawEngine}。`);
      engine = parsedEngine.data;
    }

    const requestedModel = flags.model?.trim() ?? '';
    const requestId = flags.requestId ? idSchema.parse(flags.requestId) : `cc_${randomUUID()}`;
    const workspace = flags.workspace?.trim() ? path.resolve(flags.workspace.trim()) : '';
    const allBots = client.ready.bots ?? [];

    let explicitBot: (typeof allBots)[number] | undefined;
    if (botFlag) {
      const found = allBots.find(b => b.id === botFlag);
      if (!found || found.deletedAt) throw new Error(`找不到可用的 Bot：${botFlag}。`);
      if (found.role === 'dispatcher') throw new Error(`Bot ${botFlag} 是幕僚长，不支持通过 conversations create 创建新对话。`);
      if (found.role === 'worker') throw new Error(`Bot ${botFlag} 是内部工作 Bot，不能直接创建对话。`);
      if (engine && found.engine !== engine) {
        throw new Error(`Bot ${botFlag} 使用引擎 ${found.engine}，与 --engine ${engine} 不一致。`);
      }
      explicitBot = found;
    }

    const caps = client.ready.serverCapabilities ?? [];
    const profile = await client.request('/api/host-profile').catch(() => ({ name: 'local' })) as { name?: string };
    const resources = caps.includes(HOST_BALANCE_RESOURCES_CAPABILITY)
      ? await client.request(HOST_BALANCE_RESOURCES_PATH).then(raw => hostBalanceResourcesSchema.parse(raw)).catch(() => undefined)
      : undefined;
    const quotas: QuotaDirectory | undefined = caps.includes(ENGINE_QUOTA_CAPABILITY)
      ? await client.request('/api/engine-quotas').then(raw => {
        const parsed = quotaDirectorySchema.safeParse(raw);
        return parsed.success ? parsed.data : undefined;
      }).catch(() => undefined)
      : undefined;

    let chosenBot = explicitBot;
    let engineAvailable = Boolean(chosenBot);
    let quotaExhausted = false;
    let loginRequired = false;
    let createDefaults: { model: string; effort: CreateBotInput['effort']; permission?: CreateBotInput['permission'] } | undefined;

    if (explicitBot) {
      const scope = quotas?.scopes.find(s => s.id === explicitBot.id || s.botIds.includes(explicitBot.id));
      loginRequired = scope ? isQuotaScopeLoginRequired(scope) : false;
      quotaExhausted = !loginRequired && scope
        ? isQuotaScopeExhausted(scope, { model: requestedModel || explicitBot.model })
        : false;
    } else if (engine) {
      const usableMatching = allBots.some(
        bot => !bot.deletedAt && bot.role !== 'worker' && bot.role !== 'dispatcher'
          && bot.engine === engine && (!requestedModel || (bot.model ?? '') === requestedModel),
      );
      const catalog: BotCatalog | undefined = usableMatching
        ? undefined
        : await client.request(`/api/bots/catalog?includePi=1${workspace ? `&workspace=${encodeURIComponent(workspace)}` : ''}`)
          .catch(() => undefined) as BotCatalog | undefined;
      const evaluated = evaluateHostEngineCandidate({
        engine,
        requestedModel,
        bots: allBots,
        canCreateBot: true,
        catalog,
        quotas,
      });
      engineAvailable = evaluated.engineAvailable;
      quotaExhausted = evaluated.quotaExhausted;
      loginRequired = evaluated.loginRequired;
      if (evaluated.matchingBot) {
        chosenBot = allBots.find(b => b.id === evaluated.matchingBot!.id);
      }
      createDefaults = evaluated.createDefaults;
    }

    if (flags.host === 'auto') {
      const candidates: HostBalanceCandidate[] = [{
        hostId: 'local',
        hostName: profile.name ?? 'local',
        online: true,
        preference: 'normal',
        engineAvailable,
        quotaExhausted,
        loginRequired,
        latencyMs: 1,
        resources,
        ...(chosenBot ? { matchingBotId: chosenBot.id, matchingBotName: chosenBot.name } : {}),
      }];
      const selection = selectBalancedHost(candidates, { requireResources: true });
      if (!selection.selected) {
        throw new Error(`自动选择主机失败（${selection.excluded.map(e => `${e.hostName}:${e.reason}`).join(', ') || 'no_eligible_host'}），请手动指定主机或检查引擎状态。`);
      }
    }

    let botId = chosenBot?.id;
    let botName = chosenBot?.name;
    let createdBot = false;
    if (!botId) {
      if (!engine) throw new Error('conversations create 需要 --bot ID 或 --engine ENGINE。');
      if (!createDefaults) {
        throw new Error(`引擎 ${engine} 在当前主机上不可用或缺少可用默认模型，无法自动创建 Bot。`);
      }
      const botRequestId = requestId.length <= 124
        ? `bot_${requestId}`
        : `bot_${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`;
      const botInput = createBotSchema.parse({
        requestId: botRequestId,
        name: engine,
        engine,
        model: createDefaults.model,
        effort: createDefaults.effort,
        workspace,
        ...(createDefaults.permission ? { permission: createDefaults.permission } : {}),
      });
      const res = await client.request('/api/bots', 'POST', botInput) as { bot?: { id: string; name: string }; id?: string; name?: string };
      botId = res.bot?.id ?? res.id;
      botName = res.bot?.name ?? res.name ?? engine;
      createdBot = true;
      if (!botId) throw new Error('自动创建 Bot 失败。');
    }

    const title = (flags.title?.trim() || `与 ${botName ?? botId} 的新对话`).slice(0, 256);
    const conversation = conversationSchema.parse(await client.request('/api/conversations', 'POST', {
      v: 1,
      type: 'conversation.create',
      conversationType: 'direct',
      botIds: [botId],
      title,
      clientActionId: requestId,
    }));
    return { host: profile.name ?? 'local', hostSelection: flags.host === 'auto' ? 'auto' : 'local', botId, createdBot, conversation };
  }
  if (!['archive', 'restore', 'move'].includes(action ?? '')) throw new Error('使用 conversations local、create、archive、restore 或 move。');
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
