/** Decode finalized NEAR return data without mistaking an empty return for false. */
export function decodeSuccessValue(encoded: string): unknown {
  if (!encoded) return undefined;
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  const value = new TextDecoder().decode(bytes);
  try { return JSON.parse(value); } catch { return value; }
}
export function receiptLogs(outcome: unknown): string[] {
  const value = outcome as { receipts_outcome?: {outcome?: {logs?: unknown[]}}[] };
  return (value.receipts_outcome ?? []).flatMap(receipt => receipt.outcome?.logs ?? []).filter((log): log is string => typeof log === 'string');
}
export function launchIdFromLogs(logs: string[]): string | null {
  for (const log of logs) {
    if (!log.startsWith('EVENT_JSON:')) continue;
    try {
      const event = JSON.parse(log.slice('EVENT_JSON:'.length));
      const id = event.standard === 'pit-factory' && event.event === 'launch_started' ? event.data?.[0]?.launch_id : null;
      if (typeof id === 'string' && /^\d{1,20}$/.test(id) && BigInt(id) <= 18446744073709551615n) return id;
    } catch { /* Other contracts can emit arbitrary logs. */ }
  }
  return null;
}
