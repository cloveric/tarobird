/** Moving an owned prompt past a Bus goal does not move/edit that goal itself.
 * Old Hosts omit the explicit barrier flag, so retain conservative ordering. */
export function promptQueueMove(items: readonly { message: { id: string }; canMove: boolean; reorderBarrier?: boolean }[], sourceId: string, targetId: string, after: boolean) {
  const source = items.findIndex(item => item.message.id === sourceId), target = items.findIndex(item => item.message.id === targetId);
  if (source < 0 || target < 0 || source === target || !items[source]?.canMove) return;
  const destination = target + Number(after);
  if (destination === source || destination === source + 1) return;
  if (items.slice(Math.min(source, destination), Math.max(source, destination)).some(item => item.reorderBarrier ?? !item.canMove)) return;
  return { beforeId: items[destination]?.message.id ?? null, after };
}
