// tools/next-batch.mjs — what number does this commit batch get?
//
// Commits here are titled 「第 N 批：…」, and this repository is edited from more
// than one session at a time. Two sessions that both remember "the last one was
// 42" will both write 42 — which is exactly what happened between 40 and 43.
// The number therefore cannot come from memory; it has to come from the history
// that is actually on disk, at the moment of committing.
//
//   node tools/next-batch.mjs           # 第 44 批
//   node tools/next-batch.mjs --bare    # 44   (for scripts)
//
// It reads commit subjects only — no network, no lock, no state of its own.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Matches 「第 12 批」 and 「第 12 批（修）」 alike: the suffix is part of the
// title, not of the number.
const BATCH = /第\s*(\d+)\s*批/u;

/**
 * Highest batch number among commit subjects.
 * 0 means "no numbered batch yet", so the next one is 第 1 批.
 * @param {Iterable<string>} subjects
 * @returns {number}
 */
export function highestBatch(subjects) {
  let max = 0;
  for (const subject of subjects) {
    const match = BATCH.exec(String(subject ?? ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** Read every commit subject in this repository, oldest to newest. */
function readSubjects() {
  try {
    return execFileSync('git', ['log', '--format=%s'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n');
  } catch (err) {
    throw new Error(`读不到 git 历史：${String(err?.message ?? err)}（在仓库外运行？）`);
  }
}

function main() {
  const bare = process.argv.includes('--bare');
  const next = highestBatch(readSubjects()) + 1;
  process.stdout.write(bare ? String(next) : `第 ${next} 批`);
  if (!bare) process.stdout.write('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
