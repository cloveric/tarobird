import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "./secret-redaction.js";

/** Redact complete stderr lines, never a prefix whose credential may arrive in
 * another chunk. Oversize raw lines are discarded whole, not sliced mid-secret. */
export class RedactedLogTail {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private skipping = false;
  private ended = false;
  constructor(private completed = "", private readonly maxLine = 4096, private readonly maxTail = 8192) {
    this.completed = completed.slice(-maxTail);
  }
  text(): string { return this.completed; }
  write(chunk: Buffer | string): void {
    if (this.ended) return;
    const parts = (typeof chunk === "string" ? chunk : this.decoder.write(chunk)).split("\n"), last = parts.pop()!;
    for (const part of parts) {
      if (!this.skipping) this.commit(this.pending + part);
      this.pending = ""; this.skipping = false;
    }
    if (this.skipping) return;
    this.pending += last;
    if (this.pending.length > this.maxLine) { this.commit(this.pending); this.pending = ""; this.skipping = true; }
  }
  /** Call only when stderr closes. Process exit can precede the final bytes. */
  end(): void {
    if (this.ended) return;
    this.write(this.decoder.end());
    if (this.pending && !this.skipping) this.commit(this.pending);
    this.pending = ""; this.skipping = false; this.ended = true;
  }
  private commit(line: string): void {
    const shown = line.length > this.maxLine ? "[stderr line omitted: too long]" : redactSecrets(line);
    this.completed = `${this.completed}${shown}\n`.slice(-this.maxTail);
  }
}
