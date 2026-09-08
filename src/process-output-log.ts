// Executor-local replay, not a durable log or an execution authority. Readers
// own their cursors. Only the producer appends/evicts; reads never drain state.
export class ProcessOutputError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProcessOutputError";
  }
}

interface OutputChunk {
  sequence: number;
  text: string;
  characters: number;
}

export class ProcessOutputLog {
  private chunks: Array<OutputChunk | undefined> = [];
  private head = 0;
  private characters = 0;
  private sequence = 0;
  private readonly chunkCharacters: number;

  constructor(
    private readonly maxCharacters: number,
    private readonly maxChunks = 8192,
  ) {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1
      || !Number.isSafeInteger(maxChunks) || maxChunks < 1) {
      throw new Error("Output replay bounds must be positive safe integers.");
    }
    // Small immutable chunks allow lossless bounded pages without a second
    // intra-event cursor. These sequences are NOT legacy OS data-event numbers.
    this.chunkCharacters = Math.min(256, maxCharacters);
  }

  get latestSequence(): number { return this.sequence; }
  get oldestSequence(): number {
    return this.chunks[this.head]?.sequence ?? this.sequence + 1;
  }
  get retainedCharacters(): number { return this.characters; }
  get retainedChunks(): number { return this.chunks.length - this.head; }

  append(output: string): void {
    let text = "";
    let characters = 0;
    for (const character of output) {
      text += character;
      if (++characters === this.chunkCharacters) {
        this.appendChunk(text, characters);
        text = "";
        characters = 0;
      }
    }
    if (characters) this.appendChunk(text, characters);
  }

  private appendChunk(text: string, characters: number): void {
    this.chunks.push({ sequence: ++this.sequence, text, characters });
    this.characters += characters;
    while (this.characters > this.maxCharacters || this.retainedChunks > this.maxChunks) {
      this.characters -= this.chunks[this.head]!.characters;
      this.chunks[this.head++] = undefined;
    }
    // Amortized compaction, not an O(n) shift for every producer event.
    if (this.head > 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  read(afterSequence: number, maxCharacters: number) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new ProcessOutputError("PROCESS_OUTPUT_CURSOR_INVALID", "afterSequence must be a non-negative safe integer.");
    }
    if (afterSequence > this.sequence) {
      throw new ProcessOutputError("PROCESS_OUTPUT_CURSOR_AHEAD", "Cursor is ahead of this process's observed output.");
    }
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < this.chunkCharacters) {
      throw new ProcessOutputError("PROCESS_OUTPUT_LIMIT_INVALID", "Output page must fit at least one retained chunk.");
    }
    const oldestSequence = this.oldestSequence;
    const gap = afterSequence < oldestSequence - 1;
    const parts: string[] = [];
    let characters = 0;
    let nextSequence = Math.max(afterSequence, oldestSequence - 1);
    let sequenceStart: number | undefined;
    const start = this.head + Math.max(0, afterSequence - oldestSequence + 1);
    for (let index = start; index < this.chunks.length; index++) {
      const chunk = this.chunks[index]!;
      if (characters + chunk.characters > maxCharacters) break;
      sequenceStart ??= chunk.sequence;
      parts.push(chunk.text);
      characters += chunk.characters;
      nextSequence = chunk.sequence;
    }
    return {
      output: parts.join(""),
      afterSequence,
      nextSequence,
      oldestSequence,
      latestSequence: this.sequence,
      sequenceStart,
      gap,
      droppedThroughSequence: oldestSequence - 1,
      hasMore: nextSequence < this.sequence,
      retainedCharacters: this.characters,
      retainedChunks: this.retainedChunks,
    };
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.characters = 0;
  }
}
