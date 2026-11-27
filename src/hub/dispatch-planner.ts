import type {
  DispatchEngine,
  DispatchNodeTarget,
  DispatchSplitBatch,
  DispatchSplitPlanInput,
  DispatchSplitPlanResponse,
  DispatchTicket,
  DispatcherSettings,
} from "../client-protocol/dispatch.js";

export interface ParsedSplitTask {
  totalItems?: number;
  perNode?: number;
  itemUnit?: string;
}

/** Extracts "N items of the same kind" and optional "M per machine" hints from a task prompt. */
export function parseSplitTaskSpec(
  request: string,
  explicit?: { totalItems?: number; perNode?: number; items?: readonly string[] },
): ParsedSplitTask {
  let perNode = explicit?.perNode;
  let remaining = request;
  if (perNode === undefined) {
    const zhPer = /(?:每(?:台|个节点|台主机|台机器|台电脑|机)|平均每台)\s*(?:最多|至多|分配|不超过|写|跑|做|生成|处理|负责|限|上限)?\s*(\d{1,4})\s*(?:个|条|份|篇|项|脚本|文件|任务)?/u.exec(request);
    const enPer = /\b(\d{1,4})\s+(?:items?|scripts?|files?|tasks?|tests?)\s+(?:per|on\s+each)\s+(?:machine|host|node|computer)\b|\b(\d{1,4})\s+(?:per|each)\s+(?:machine|host|node|computer)\b/iu.exec(request);
    const match = zhPer ?? enPer;
    const raw = zhPer?.[1] ?? enPer?.[1] ?? enPer?.[2];
    if (raw) {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0 && n <= 10_000) {
        perNode = n;
        if (match && match.index !== undefined) {
          remaining = `${request.slice(0, match.index)} ${request.slice(match.index + match[0].length)}`;
        }
      }
    }
  }

  if (explicit?.items?.length) {
    return { totalItems: explicit.items.length, perNode };
  }
  if (explicit?.totalItems !== undefined) {
    return { totalItems: explicit.totalItems, perNode };
  }

  const zhTotal = /(?:共|一共|总共|编写|写|生成|处理|创建|测试|分析|跑)\s*(\d{1,4})\s*(?:个|条|份|篇|项|套|只|段)?\s*([^\s，。,.；;！？!?]{1,24})/u.exec(remaining);
  const enTotal = /\b(?:write|create|generate|process|run|build|analyze|test|make|prepare)\s+(\d{1,4})\s+([a-z][a-z0-9_-]{1,24})/iu.exec(remaining)
    ?? /\b(\d{1,4})\s+(scripts?|tasks?|items?|files?|tests?|jobs?|prompts?|modules?)\b/iu.exec(remaining);
  const rawTotal = zhTotal?.[1] ?? enTotal?.[1];
  const unit = zhTotal?.[2] ?? enTotal?.[2];
  if (rawTotal) {
    const n = Number(rawTotal);
    if (Number.isInteger(n) && n > 1 && n <= 10_000) return { totalItems: n, perNode, ...(unit ? { itemUnit: unit } : {}) };
  }
  return { ...(perNode ? { perNode } : {}) };
}

export interface NodeEvaluation {
  eligible: boolean;
  reason: string;
  score: number;
}

/** Evaluates a node for running `engine` using #88 load/preference rules and #86 quota rules. */
export function evaluateNodeForEngine(
  node: Pick<DispatchNodeTarget, "enabled" | "online" | "authorized" | "preference" | "maxConcurrent" | "allowedEngines" | "activeOnNode" | "latencyMs" | "load">,
  engine: DispatchEngine,
  options: { force?: boolean; checkCapacity?: boolean; allowManual?: boolean } = {},
): NodeEvaluation {
  if (!node.enabled) return { eligible: false, reason: "node_disabled", score: -1000 };
  if (!node.online) return { eligible: false, reason: "offline", score: -1000 };
  if (!node.authorized) return { eligible: false, reason: "unauthorized", score: -1000 };
  if (node.preference === "manual_only" && !options.allowManual) return { eligible: false, reason: "manual_only", score: -1000 };
  if (node.allowedEngines && !node.allowedEngines.includes(engine)) return { eligible: false, reason: "engine_not_allowed", score: -1000 };

  const cap = node.load.engines.find(e => e.engine === engine);
  if (!cap || !cap.installed) return { eligible: false, reason: "engine_not_installed", score: -1000 };
  if (!options.force && cap.health && cap.health.state !== "ok") {
    return { eligible: false, reason: `engine_${cap.health.state}`, score: -1000 };
  }
  if (!options.force && cap.quotaState === "blocked") {
    return { eligible: false, reason: "quota_blocked", score: -1000 };
  }
  if (options.checkCapacity && node.activeOnNode >= node.maxConcurrent) {
    return { eligible: false, reason: "node_busy", score: -500 };
  }

  let score = 0;
  const reasons: string[] = [];

  if (node.preference === "prefer") {
    score += 30;
    reasons.push("preferred");
  } else if (node.preference === "less_often") {
    score -= 30;
    reasons.push("less_often");
  }

  if (cap.quotaState === "warning") {
    score -= 40;
    reasons.push("quota_warning");
  } else if (cap.quotaState === "ok") {
    score += 10;
  }

  const freeSlots = Math.max(0, node.maxConcurrent - node.activeOnNode);
  const slotRatio = node.maxConcurrent > 0 ? freeSlots / node.maxConcurrent : 0;
  score += slotRatio * 25;
  if (node.activeOnNode === 0 && node.load.cpuLoadRatio !== undefined && node.load.cpuLoadRatio < 0.7) {
    reasons.push("least_busy");
  }

  if (node.load.cpuLoadRatio !== undefined) {
    score -= Math.min(node.load.cpuLoadRatio, 4) * 15;
  }
  if (node.load.freeMemoryRatio !== undefined) {
    score += node.load.freeMemoryRatio * 10;
  }
  if (node.latencyMs !== undefined) {
    score -= Math.min(node.latencyMs / 200, 5);
  }

  return {
    eligible: true,
    reason: reasons[0] ?? "low_load",
    score: Math.round(score * 100) / 100,
  };
}

/** Selects the single best eligible node for an engine according to #88 load/preference/quota rules. */
export function selectBestNodeForEngine(
  nodes: readonly DispatchNodeTarget[],
  engine: DispatchEngine,
  options: { force?: boolean; checkCapacity?: boolean; excludeHostIds?: ReadonlySet<string> } = {},
): { node: DispatchNodeTarget; evaluation: NodeEvaluation } | undefined {
  let best: { node: DispatchNodeTarget; evaluation: NodeEvaluation } | undefined;
  for (const node of nodes) {
    if (options.excludeHostIds?.has(node.hostId)) continue;
    const evaluation = evaluateNodeForEngine(node, engine, { force: options.force, checkCapacity: options.checkCapacity ?? true });
    if (!evaluation.eligible) continue;
    if (!best || evaluation.score > best.evaluation.score) {
      best = { node, evaluation };
    }
  }
  return best;
}

/** Picks the best default engine available across the active nodes when none was explicitly requested. */
export function pickEngineForNodes(
  nodes: readonly DispatchNodeTarget[],
  preferredEngine?: DispatchEngine,
  allowedEngines?: readonly DispatchEngine[],
  options: { force?: boolean; allowManualHostIds?: ReadonlySet<string> } = {},
): DispatchEngine | undefined {
  if (preferredEngine) return preferredEngine;
  const candidates = allowedEngines?.length ? allowedEngines : (["codex", "claude", "deepseek", "kimi", "antigravity"] as const);
  let bestEngine: DispatchEngine | undefined;
  let bestScore = -Infinity;
  for (const engine of candidates) {
    let availableNodes = 0;
    let sumScore = 0;
    for (const node of nodes) {
      const evalResult = evaluateNodeForEngine(node, engine, {
        force: options.force,
        checkCapacity: false,
        allowManual: !!options.allowManualHostIds?.has(node.hostId),
      });
      if (evalResult.eligible) {
        availableNodes++;
        sumScore += evalResult.score;
      }
    }
    if (availableNodes > 0) {
      const total = availableNodes * 100 + sumScore;
      if (total > bestScore) {
        bestScore = total;
        bestEngine = engine;
      }
    }
  }
  return bestEngine;
}

/** Plans parallel batches across eligible nodes for a multi-item or multi-part task. */
export function planSplitBatches(
  input: DispatchSplitPlanInput,
  nodes: readonly DispatchNodeTarget[],
  settings: DispatcherSettings,
  batchId: string,
): DispatchSplitPlanResponse {
  const force = input.force ?? false;
  const parsed = parseSplitTaskSpec(input.request, {
    totalItems: input.totalItems,
    perNode: input.perNode,
    items: input.items,
  });

  const explicitHostIds = input.hostIds?.length ? new Set(input.hostIds) : undefined;
  const candidateNodes = explicitHostIds
    ? nodes.filter(n => explicitHostIds.has(n.hostId))
    : nodes;

  const engine = pickEngineForNodes(candidateNodes, input.engine, settings.allowedEngines, {
    force,
    allowManualHostIds: explicitHostIds,
  });
  const skippedNodes: DispatchSplitPlanResponse["skippedNodes"] = [];
  const eligible: { node: DispatchNodeTarget; evaluation: NodeEvaluation }[] = [];

  for (const node of candidateNodes) {
    if (!engine) {
      skippedNodes.push({ hostId: node.hostId, hostName: node.hostName, reason: "no_engine_available" });
      continue;
    }
    const evalResult = evaluateNodeForEngine(node, engine, {
      force,
      checkCapacity: false,
      allowManual: !!explicitHostIds?.has(node.hostId),
    });
    if (!evalResult.eligible) {
      skippedNodes.push({ hostId: node.hostId, hostName: node.hostName, reason: evalResult.reason });
    } else {
      eligible.push({ node, evaluation: evalResult });
    }
  }

  // Sort best nodes first; keep quota-warning nodes at the back unless no healthy nodes exist.
  eligible.sort((a, b) => b.evaluation.score - a.evaluation.score);
  const healthy = eligible.filter(item => item.evaluation.reason !== "quota_warning");
  const pool = healthy.length ? healthy : eligible;

  if (!pool.length || !engine) {
    return {
      batchId,
      ...(parsed.totalItems ? { totalItems: parsed.totalItems } : {}),
      ...(parsed.perNode ? { perNode: parsed.perNode } : {}),
      mode: settings.mode,
      requiresConfirmation: settings.mode === "ask",
      batches: [],
      skippedNodes,
    };
  }

  const baseTitle = (input.title ?? input.request.split(/\r?\n/, 1)[0]?.slice(0, 80) ?? "Task").trim();
  const batches: DispatchSplitBatch[] = [];

  let plannedTotalItems = parsed.totalItems;
  if (input.items?.length) {
    const items = input.items;
    const batchCount = parsed.perNode
      ? Math.ceil(items.length / parsed.perNode)
      : Math.min(items.length, Math.max(pool.length, pool.reduce((sum, item) => sum + item.node.maxConcurrent, 0)));
    const chunkSizes = parsed.perNode
      ? Array.from({ length: batchCount }, (_, i) => Math.min(parsed.perNode!, items.length - i * parsed.perNode!))
      : distributeCount(items.length, batchCount, pool);

    let cursor = 0;
    for (let i = 0; i < chunkSizes.length; i++) {
      const count = chunkSizes[i]!;
      const start = cursor + 1;
      const end = cursor + count;
      const slice = items.slice(cursor, cursor + count);
      cursor += count;
      const picked = pool[i % pool.length]!;
      batches.push({
        batchIndex: i,
        batchTotal: chunkSizes.length,
        title: `${baseTitle} (${start}-${end}/${items.length})`.slice(0, 200),
        request: `${input.request}\n\n[Batch ${i + 1}/${chunkSizes.length} — Host: ${picked.node.hostName} — Items ${start}..${end}]:\n${slice.map((item, idx) => `${start + idx}. ${item}`).join("\n")}`.slice(0, 20_000),
        hostId: picked.node.hostId,
        hostName: picked.node.hostName,
        engine,
        model: input.model ?? "",
        effort: input.effort ?? "",
        itemStart: start,
        itemEnd: end,
        itemCount: count,
        reason: picked.evaluation.reason,
      });
    }
  } else if (parsed.totalItems && parsed.totalItems > 1) {
    const total = parsed.totalItems;
    const batchCount = parsed.perNode
      ? Math.ceil(total / parsed.perNode)
      : Math.min(total, Math.max(pool.length, pool.reduce((sum, item) => sum + item.node.maxConcurrent, 0)));
    const chunkSizes = parsed.perNode
      ? Array.from({ length: batchCount }, (_, i) => Math.min(parsed.perNode!, total - i * parsed.perNode!))
      : distributeCount(total, batchCount, pool);

    let cursor = 0;
    for (let i = 0; i < chunkSizes.length; i++) {
      const count = chunkSizes[i]!;
      const start = cursor + 1;
      const end = cursor + count;
      cursor += count;
      const picked = pool[i % pool.length]!;
      batches.push({
        batchIndex: i,
        batchTotal: chunkSizes.length,
        title: `${baseTitle} (#${start}-#${end})`.slice(0, 200),
        request: `${input.request}\n\n[Batch ${i + 1}/${chunkSizes.length} assigned to node ${picked.node.hostName}: complete items #${start} to #${end} (${count} of ${total} total). Write output files into the ticket workspace and summarize what you produced.]`.slice(0, 20_000),
        hostId: picked.node.hostId,
        hostName: picked.node.hostName,
        engine,
        model: input.model ?? "",
        effort: input.effort ?? "",
        itemStart: start,
        itemEnd: end,
        itemCount: count,
        reason: picked.evaluation.reason,
      });
    }
  } else if (parsed.perNode && parsed.perNode > 0) {
    // Per-node-only prompt (e.g. "Write 10 scripts per machine"): allocate `perNode` items to each eligible node.
    const count = Math.min(pool.length, 8);
    const perNode = parsed.perNode;
    plannedTotalItems = count * perNode;
    for (let i = 0; i < count; i++) {
      const picked = pool[i]!;
      const start = i * perNode + 1;
      const end = (i + 1) * perNode;
      batches.push({
        batchIndex: i,
        batchTotal: count,
        title: count > 1 ? `${baseTitle} (#${start}-#${end})`.slice(0, 200) : baseTitle.slice(0, 200),
        request: `${input.request}\n\n[Batch ${i + 1}/${count} assigned to node ${picked.node.hostName}: complete items #${start} to #${end} (${perNode} items on this node). Write output files into the ticket workspace and summarize what you produced.]`.slice(0, 20_000),
        hostId: picked.node.hostId,
        hostName: picked.node.hostName,
        engine,
        model: input.model ?? "",
        effort: input.effort ?? "",
        itemStart: start,
        itemEnd: end,
        itemCount: perNode,
        reason: picked.evaluation.reason,
      });
    }
  } else {
    // Generic multi-node split when count isn't numeric: one batch per selected node (up to candidate nodes).
    const count = Math.min(pool.length, 8);
    for (let i = 0; i < count; i++) {
      const picked = pool[i]!;
      batches.push({
        batchIndex: i,
        batchTotal: count,
        title: count > 1 ? `${baseTitle} (${i + 1}/${count})`.slice(0, 200) : baseTitle.slice(0, 200),
        request: count > 1
          ? `${input.request}\n\n[Subtask ${i + 1}/${count} assigned to node ${picked.node.hostName}]`.slice(0, 20_000)
          : input.request,
        hostId: picked.node.hostId,
        hostName: picked.node.hostName,
        engine,
        model: input.model ?? "",
        effort: input.effort ?? "",
        reason: picked.evaluation.reason,
      });
    }
  }

  return {
    batchId,
    ...(plannedTotalItems ? { totalItems: plannedTotalItems } : {}),
    ...(parsed.perNode ? { perNode: parsed.perNode } : {}),
    mode: settings.mode,
    requiresConfirmation: settings.mode === "ask",
    batches,
    skippedNodes,
  };
}

/** Distributes `total` items across `batchCount` slots weighted by each node's maxConcurrent and score. */
function distributeCount(
  total: number,
  batchCount: number,
  pool: readonly { node: DispatchNodeTarget; evaluation: NodeEvaluation }[],
): number[] {
  if (batchCount <= 1) return [total];
  const weights = Array.from({ length: batchCount }, (_, i) => {
    const item = pool[i % pool.length]!;
    const prefFactor = item.node.preference === "prefer" ? 1.25 : item.node.preference === "less_often" ? 0.75 : 1;
    return Math.max(0.25, prefFactor);
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map(w => (total * w) / totalWeight);
  const sizes = exact.map(v => Math.max(1, Math.floor(v)));
  let assigned = sizes.reduce((a, b) => a + b, 0);
  // Adjust using largest-remainder ordering so preference weights (prefer / less_often) stay proportional.
  if (assigned < total) {
    const order = exact
      .map((v, i) => ({ i, rem: v - Math.floor(v), w: weights[i]! }))
      .sort((a, b) => b.rem - a.rem || b.w - a.w || a.i - b.i);
    let idx = 0;
    while (assigned < total) {
      sizes[order[idx % order.length]!.i]! += 1;
      assigned++;
      idx++;
    }
  } else if (assigned > total) {
    const order = exact
      .map((v, i) => ({ i, rem: v - Math.floor(v), w: weights[i]! }))
      .sort((a, b) => a.rem - b.rem || a.w - b.w || b.i - a.i);
    let idx = 0;
    while (assigned > total) {
      const pos = order[idx % order.length]!.i;
      if (sizes[pos]! > 1) {
        sizes[pos]! -= 1;
        assigned--;
      }
      idx++;
    }
  }
  return sizes;
}

/** Builds the consolidated Markdown summary for a completed/settled batch across nodes. */
export function buildBatchSummaryText(
  batchId: string,
  tickets: readonly DispatchTicket[],
  ownHostName: string,
): string {
  const ordered = [...tickets].sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0) || a.createdAt - b.createdAt);
  const doneCount = ordered.filter(t => t.status === "done" || t.status === "needs_review").length;
  const failedCount = ordered.filter(t => t.status === "blocked" || t.status === "cancelled").length;
  const allFiles = ordered.flatMap(t => t.artifacts ?? []);

  const byNode = new Map<string, DispatchTicket[]>();
  for (const ticket of ordered) {
    const attempt = ticket.attempts.at(-1);
    const nodeName = attempt?.hostName ?? ticket.hostName ?? ownHostName;
    const list = byNode.get(nodeName) ?? [];
    list.push(ticket);
    byNode.set(nodeName, list);
  }

  const lines: string[] = [
    `【跨主机任务汇总】批次 \`${batchId}\``,
    "",
    `总览：共 ${ordered.length} 个子任务 · ${doneCount} 个完成${failedCount ? ` · ${failedCount} 个未完成` : ""} · 参与节点 ${byNode.size} 台（${[...byNode.keys()].join("、")}）${allFiles.length ? ` · 回收文件 ${allFiles.length} 个` : ""}`,
  ];

  for (const [nodeName, nodeTickets] of byNode) {
    lines.push("", `### 节点：${nodeName}（${nodeTickets.length} 批）`);
    for (const ticket of nodeTickets) {
      const attempt = ticket.attempts.at(-1);
      const batchLabel = ticket.batchIndex !== undefined && ticket.batchTotal ? `批次 ${ticket.batchIndex + 1}/${ticket.batchTotal}` : ticket.id;
      const statusLabel = ticket.status === "needs_review" || ticket.status === "done" ? "已完成" : ticket.status === "cancelled" ? "已取消" : "未完成";
      const engineLabel = attempt ? ` · ${attempt.engine}${attempt.model ? ` (${attempt.model})` : ""}` : "";
      const summary = (ticket.result ?? ticket.note ?? "").replace(/\s+/g, " ").trim().slice(0, 320);
      const fileNames = (ticket.artifacts ?? []).map(f => f.name).join(", ");
      lines.push(`- **${batchLabel} — ${ticket.title}** [${statusLabel}${engineLabel}]${summary ? `：${summary}` : ""}${fileNames ? `（文件：${fileNames}）` : ""}`);
    }
  }

  return lines.join("\n");
}
