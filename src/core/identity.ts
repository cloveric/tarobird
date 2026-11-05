export function coreOperatorRawId(operator: { openId?: string; userId?: string } | undefined): string {
  return operator?.openId ?? operator?.userId ?? "unknown";
}
