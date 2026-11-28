/**
 * Stub for `@deepseek-ai/dsh-llm`, used only by `test/index.test.mjs`.
 *
 * The plugin imports one thing from this package — `BlockAssembler`, the
 * documented way to read a model stream — and the harness supplies the real
 * module at runtime. This stub implements exactly the part the plugin uses
 * (`push(chunk)` then `blocks()`), with the real module's two behaviours that
 * matter here: deltas accumulate per block index, and empty blocks are dropped.
 *
 * It is intentionally tolerant about where a block's type and index arrive
 * (block-start payloads have moved fields between releases) but strict about
 * the two outcomes the plugin depends on: text blocks carry their text, and
 * reasoning blocks are a distinct type.
 */
export class BlockAssembler {
  constructor() {
    this.entries = new Map(); // index -> { type, text, seq }
    this.seq = 0;
  }

  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return this;
    const { type } = chunk;
    if (type === 'block-start') {
      const index = chunk.index ?? chunk.blockIndex ?? chunk.block?.index ?? this.seq;
      this.entries.set(index, {
        type: chunk.block?.type ?? chunk.blockType ?? 'text',
        text: '',
        seq: this.seq,
      });
      this.seq += 1;
      return this;
    }
    if (type === 'text-delta' || type === 'reasoning-delta') {
      const kind = type === 'text-delta' ? 'text' : 'reasoning';
      const index = chunk.index ?? chunk.blockIndex ?? chunk.block?.index ?? this.seq;
      const entry = this.entries.get(index) ?? { type: kind, text: '', seq: this.seq };
      if (!this.entries.has(index)) this.seq += 1;
      entry.type = entry.type ?? kind;
      entry.text += typeof chunk.text === 'string' ? chunk.text : '';
      this.entries.set(index, entry);
      return this;
    }
    return this;
  }

  blocks() {
    return [...this.entries.values()]
      .sort((a, b) => a.seq - b.seq)
      .filter((entry) => entry.text !== '');
  }
}
