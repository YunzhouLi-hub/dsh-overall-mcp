// test/events.test.mjs — the plugin's own activity log (lib/events.js).
//
// The log exists because a reason can outlive the process that knew it: on
// 2026-10-16 the panel called a catalogue source unavailable, and the explanation
// (a spent anonymous search window, shared with every other process on the same
// IP) was only observable while the plugin was still running. What these cases
// pin down is the contract the rest of the plugin relies on: the file always
// parses, it stays bounded, concurrent writers do not corrupt each other, and
// nothing here ever throws into the action it is describing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvents, emit, eventFileFacts, readEvents, setEventSink } from '../lib/events.js';

/** A throwaway data directory; the sink is cleared even when a case fails. */
async function withFile(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overall-mcp-events-'));
  try {
    await run(path.join(dir, 'events.ndjson'));
  } finally {
    setEventSink(null);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('an event round-trips with its fields bounded', async () => {
  await withFile(async (file) => {
    const long = 'x'.repeat(2000);
    const written = await appendEvents(file, [{
      kind: 'source', source: 'github-mcp', note: long,
      nested: { deep: { deeper: { deepest: 1 } } }, list: [1, 2, 3],
    }]);
    assert.equal(written.written, 1);

    const { events, damaged, total } = await readEvents(file, { limit: 10 });
    assert.equal(damaged, 0);
    assert.equal(total, 1);
    const [event] = events;
    assert.equal(event.kind, 'source');
    assert.equal(event.source, 'github-mcp');
    assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(event.note.length < long.length, 'a 2000-character field must not own the file');
    assert.ok(event.note.endsWith('…'));
    assert.deepEqual(event.list, [1, 2, 3]);
    // Depth is capped at two object levels: `nested.deep` survives as a name,
    // its own children do not. The replacement is a string, so a rendered line
    // can never be mistaken for real nested data.
    assert.equal(event.nested.deep, '{…}');
  });
});

test('the line count keeps the newest events and admits what it dropped', async () => {
  await withFile(async (file) => {
    for (let i = 0; i < 12; i += 1) await appendEvents(file, [{ kind: 'test', n: i }], { maxLines: 5 });
    const { events, total } = await readEvents(file, { limit: 50 });
    const numbered = events.filter((e) => typeof e.n === 'number');
    assert.equal(numbered.at(-1).n, 11, 'the newest event is kept');
    assert.ok(numbered.every((e) => e.n > 6), 'only the tail survives');
    assert.ok(events.some((e) => e.action === 'trim'), 'the retained window says what it lost');
    assert.ok(total <= 6, `a 5-line window holds 5 lines plus the trim note, saw ${total}`);
  });
});

test('the byte cap trims too, not just the line count', async () => {
  await withFile(async (file) => {
    for (let i = 0; i < 6; i += 1) {
      await appendEvents(file, [{ kind: 'test', n: i, blob: 'y'.repeat(400) }], { maxLines: 100, maxBytes: 1200 });
    }
    const { events } = await readEvents(file, { limit: 50 });
    const numbered = events.filter((e) => typeof e.n === 'number');
    assert.ok(numbered.length <= 3, `the byte cap kept ${numbered.length} rows`);
    assert.equal(numbered.at(-1).n, 5);
  });
});

test('a damaged line is counted, and every other line still reads', async () => {
  await withFile(async (file) => {
    await appendEvents(file, [{ kind: 'a' }, { kind: 'b' }]);
    await fs.appendFile(file, 'not json\n{"kind":"c"}\n[]\n', 'utf8');
    const { events, damaged, total } = await readEvents(file, { limit: 10 });
    assert.equal(total, 5);
    assert.equal(damaged, 2, 'the unterminated text and the bare array are both unusable');
    assert.deepEqual(events.map((e) => e.kind), ['a', 'b', 'c']);
  });
});

test('concurrent appends each keep their own line', async () => {
  await withFile(async (file) => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendEvents(file, [{ kind: 'burst', n: i }])));
    const { events, damaged, total } = await readEvents(file, { limit: 50 });
    assert.equal(damaged, 0, 'a racing writer must not interleave two events into one line');
    assert.equal(total, 20);
    assert.equal(new Set(events.map((e) => e.n)).size, 20, 'no event was overwritten by another');
  });
});

test('the sink is how the library reports without an argument, and it cannot break a caller', async () => {
  await withFile(async (file) => {
    const seen = [];
    setEventSink((event) => { seen.push(event); void appendEvents(file, [event]); });
    emit({ kind: 'quota', action: 'empty', waitMs: 1000 });
    emit(null);
    assert.equal(seen.length, 1, 'a null event is ignored rather than written');

    // A sink that throws must not propagate: `emit` runs in the middle of a
    // browse, and a log that can abort a request is worse than a missing line.
    setEventSink(() => { throw new Error('sink exploded'); });
    assert.doesNotThrow(() => emit({ kind: 'test' }));

    setEventSink(null);
    assert.doesNotThrow(() => emit({ kind: 'test' }), 'no sink is a no-op');
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    const { events } = await readEvents(file, { limit: 10 });
    assert.equal(events.length, 1, 'only the event the working sink saw was written');
  });
});

test('a field JSON cannot carry is dropped, and the line survives', async () => {
  await withFile(async (file) => {
    const written = await appendEvents(file, [{ kind: 'bad', n: 1n, ok: true }]);
    assert.equal(written.written, 1);
    const { events, damaged } = await readEvents(file, { limit: 5 });
    assert.equal(damaged, 0, 'the line is valid JSON even though one of its fields was not');
    assert.deepEqual(events[0], { at: events[0].at, kind: 'bad', ok: true });
  });
});

test('a log that cannot be written reports null instead of throwing', async () => {
  await withFile(async (file) => {
    // A directory in place of the file: every write fails, and the caller must
    // not notice beyond the null.
    const result = await appendEvents(path.dirname(file), [{ kind: 'test' }]);
    assert.equal(result, null);
    assert.equal(await appendEvents(file, []), null, 'nothing to write is not a write');
    const facts = await eventFileFacts(path.join(path.dirname(file), 'never-written.ndjson'));
    assert.deepEqual(facts, { bytes: 0, at: null, lines: 0, damaged: 0, lastAt: null });
  });
});
