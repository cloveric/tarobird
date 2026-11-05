import { createRunRecord, recordRunEvent } from "../../src/core/run-record.js";
import type { EngineStreamEvent } from "../../src/codex/adapter.js";

/** Feed actual adapter emissions into the same collector used by App turns. */
export function nativeRunProbe() {
  const record = createRunRecord();
  const events: EngineStreamEvent[] = [];
  return { record, events, onEngineEvent: (event: EngineStreamEvent) => { events.push(event); recordRunEvent(record, event); } };
}
