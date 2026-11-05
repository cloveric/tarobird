import { GROUP_STANCE_FENCE } from "../client-protocol/group-discussion.js";
import type { EngineStreamEvent } from "../codex/adapter.js";

type Fence = { marker: string; length: number };
type ControlBlock = { start: number; end?: number; body: string; canonical: boolean };
function opening(line: string): (Fence & { control: boolean; canonical: boolean }) | undefined {
  const match = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?$/u.exec(line);
  if (!match || (match[1]![0] === "`" && match[2]!.includes("`"))) return;
  const info = match[2]!.trim();
  return { marker: match[1]![0]!, length: match[1]!.length, control: /^(?:json[ \t]+)?group[_-]stance(?:[ \t]|$)/iu.test(info), canonical: info === GROUP_STANCE_FENCE };
}
function closes(line: string, fence: Fence): boolean {
  const match = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/u.exec(line);
  return !!match && match[1]![0] === fence.marker && match[1]!.length >= fence.length;
}

/** Presentation is independent of validation: malformed internal data is not
 * an answer either. Ordinary fenced examples (including nested fences) survive.
 * Call only for authenticated Hub discussion turns, never arbitrary chat text. */
export function splitGroupDiscussionOutput(output: string): { text: string; controls: ControlBlock[] } {
  const controls: ControlBlock[] = [], visible: string[] = [];
  let fence: Fence | undefined, control: ControlBlock | undefined, offset = 0;
  for (const chunk of output.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const line = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
    if (fence) {
      if (closes(line, fence)) {
        if (control) control.end = offset + chunk.length;
        else visible.push(chunk);
        fence = undefined; control = undefined;
      } else if (control) control.body += chunk;
      else visible.push(chunk);
    } else {
      const next = opening(line);
      if (next) {
        fence = next;
        if (next.control) { control = { start: offset, body: "", canonical: next.canonical }; controls.push(control); }
        else visible.push(chunk);
      } else visible.push(chunk);
    }
    offset += chunk.length;
  }
  return { text: controls.length ? visible.join("").trimEnd() : output, controls };
}

/** Incremental line classifier. Normal prose streams immediately; only a
 * possible fence header/closer is held until its line is identified. JSON inside
 * the internal fence is discarded as it arrives, without retaining the answer
 * or repeatedly scanning its growing prefix. */
class DiscussionTextStream {
  private fence?: Fence & { control: boolean };
  private pending = "";
  private plainLine = false;
  push(text: string): string {
    let visible = "", from = 0;
    while (from < text.length) {
      const newline = text.indexOf("\n", from), end = newline < 0 ? text.length : newline + 1;
      const part = text.slice(from, end); from = end;
      if (this.plainLine) { if (!this.fence?.control) visible += part; }
      else {
        this.pending += part;
        if (newline >= 0) {
          visible += this.line(this.pending);
          this.pending = "";
        } else if (!/^[ \t]*(?:`{1,2}|~{1,2}|`{3}[^\n]*|~{3}[^\n]*)?$/u.test(this.pending)) {
          if (!this.fence?.control) visible += this.pending;
          this.pending = ""; this.plainLine = true;
        }
      }
      if (newline >= 0) this.plainLine = false;
    }
    return visible;
  }
  finish(): string {
    const visible = this.pending ? this.line(this.pending) : "";
    this.pending = ""; this.plainLine = false; this.fence = undefined;
    return visible;
  }
  private line(chunk: string): string {
    const line = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
    if (this.fence) {
      const hidden = this.fence.control;
      if (closes(line, this.fence)) this.fence = undefined;
      return hidden ? "" : chunk;
    }
    this.fence = opening(line);
    return this.fence?.control ? "" : chunk;
  }
}

/** Each engine call owns its filter. Tool/scoped events keep their original
 * semantics; control JSON never enters Core's streamed-answer fallback. */
export function createGroupDiscussionEventFilter(): (event: EngineStreamEvent) => EngineStreamEvent[] {
  let stream = new DiscussionTextStream();
  return event => {
    if (event.type === "assistant_text") {
      const prefix = event.delta === true ? "" : stream.finish();
      if (event.delta !== true) stream = new DiscussionTextStream();
      const text = stream.push(event.text);
      return [...(prefix ? [{ type: "assistant_text" as const, text: prefix, delta: true }] : []), ...(text ? [{ ...event, text }] : [])];
    }
    if (event.type === "result") {
      const prefix = stream.finish();
      stream = new DiscussionTextStream();
      return [...(prefix ? [{ type: "assistant_text" as const, text: prefix, delta: true }] : []), { ...event, text: splitGroupDiscussionOutput(event.text).text }];
    }
    if (event.type === "engine_retry" || event.type === "tool_use" || event.type === "permission_request") {
      const prefix = stream.finish(); stream = new DiscussionTextStream();
      return [...(prefix ? [{ type: "assistant_text" as const, text: prefix, delta: true }] : []), event];
    }
    return [event];
  };
}

export function createGroupDiscussionEventHandler(onEvent: (event: EngineStreamEvent) => void | Promise<void>): (event: EngineStreamEvent) => void | Promise<void> {
  const filter = createGroupDiscussionEventFilter();
  return event => {
    // Some adapters do not await callbacks. Invoke a split event's children in
    // the same stack before yielding, so the next tool/text cannot overtake it.
    const pending = filter(event).map(visible => onEvent(visible));
    return pending.length === 1 ? pending[0] : Promise.all(pending).then(() => undefined);
  };
}
