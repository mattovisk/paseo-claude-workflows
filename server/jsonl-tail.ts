import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

interface Tail<State> {
  offset: number;
  rest: string;
  decoder: StringDecoder;
  state: State;
  usedAt: number;
}

const IDLE_TTL_MS = 10 * 60 * 1000;

/**
 * Folds append-only JSONL files into a state object, reading only the bytes added since the
 * last call. Live workflow transcripts grow to megabytes and the panel polls every 2 s.
 */
export class JsonlTailer<State> {
  private readonly tails = new Map<string, Tail<State>>();

  constructor(
    private readonly init: () => State,
    private readonly apply: (state: State, entry: Record<string, unknown>) => void,
  ) {}

  async read(path: string): Promise<State | null> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      this.tails.delete(path);
      return null;
    }
    let tail = this.tails.get(path);
    // A shorter file was rewritten; start over.
    if (!tail || size < tail.offset) {
      tail = { offset: 0, rest: "", decoder: new StringDecoder("utf8"), state: this.init(), usedAt: 0 };
      this.tails.set(path, tail);
    }
    tail.usedAt = Date.now();
    if (size > tail.offset) {
      const length = size - tail.offset;
      const buffer = Buffer.alloc(length);
      const handle = await open(path, "r");
      try {
        await handle.read(buffer, 0, length, tail.offset);
      } finally {
        await handle.close();
      }
      tail.offset = size;
      const lines = (tail.rest + tail.decoder.write(buffer)).split("\n");
      tail.rest = lines.pop() ?? "";
      for (const line of lines) this.applyLine(tail.state, line);
    }
    return tail.state;
  }

  /** Drops files nobody has read for a while, such as transcripts of finished runs. */
  sweep(): void {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [path, tail] of this.tails) if (tail.usedAt < cutoff) this.tails.delete(path);
  }

  private applyLine(state: State, line: string): void {
    if (!line.trim()) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry && typeof entry === "object") this.apply(state, entry as Record<string, unknown>);
  }
}
