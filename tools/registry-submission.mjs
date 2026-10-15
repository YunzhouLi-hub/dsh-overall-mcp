#!/usr/bin/env node
/**
 * Turn one GitHub issue into one row of `registry.json`.
 *
 * This is the program the repository's `registry-submission` workflow runs; it
 * is also the repo-side half of the loop the panel starts, so it is deliberately
 * a plain script with no dependencies: the action checks out the repository and
 * runs it with the issue body on disk.
 *
 *   node tools/registry-submission.mjs --body-file /tmp/issue.md   # validate, report, no write
 *   node tools/registry-submission.mjs --body-file /tmp/issue.md --write
 *   node tools/registry-submission.mjs --body-file /tmp/issue.md --write --comment /tmp/comment.md
 *   node tools/registry-submission.mjs --check                     # vet the committed document
 *
 * Exit codes are the workflow's control flow:
 *   0  accepted (added / updated / unchanged) — or nothing recognisable in the
 *      body at all, which is how an unrelated issue is left alone
 *   1  refused: the body *is* a submission and it failed validation, or the
 *      committed document does not vet
 *   2  usage or I/O problem
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  REGISTRY_FILE,
  SUBMISSION_FIELDS,
  appendSubmission,
  normalizeRegistryRow,
  parseSubmissionBody,
  registryTextOf,
  rowFromFields,
} from '../lib/submission.js';

const USAGE = `usage: registry-submission.mjs [--body-file <p> | --body <text>] [--registry <p>] [--write] [--comment <p>]
       registry-submission.mjs --check [--registry <p>]`;

export function parseArgs(argv = []) {
  const opts = { registry: REGISTRY_FILE, write: false, check: false, body: null, bodyFile: null, comment: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`缺少 ${arg} 的值`);
      i += 1;
      return value;
    };
    if (arg === '--body-file') opts.bodyFile = next();
    else if (arg === '--body') opts.body = next();
    else if (arg === '--registry') opts.registry = next();
    else if (arg === '--comment') opts.comment = next();
    else if (arg === '--write') opts.write = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

/** Does this body look like it was meant as a submission at all? */
function looksLikeSubmission(fields) {
  const known = SUBMISSION_FIELDS.map((f) => f.key);
  return known.some((key) => typeof fields[key] === 'string' && fields[key].trim());
}

/** The comment the workflow posts back on the issue. */
export function commentFor({ action, row, errors, name }) {
  const label = row?.name ?? (typeof name === 'string' && name.trim() ? name.trim() : '');
  const name2 = label ? `「${label}」` : '这条投稿';
  if (action === 'added') {
    return [
      `✅ 已收录 ${name2}。`,
      '',
      '合入后它会出现在所有把本仓库的 `registry.json` 加为「自定义目录源」的面板里（每源 60 秒 TTL，稍等即可看到）。',
    ].join('\n');
  }
  if (action === 'updated') {
    return [`♻️ 已更新 ${name2}：同一份清单只保留一行，按仓库地址（或服务地址/名称）识别。`].join('\n');
  }
  if (action === 'unchanged') {
    return `👌 ${name2}与清单里现有的那一行完全一致，没有改动需要合入。`;
  }
  if (action === 'ignored') {
    return '这条 issue 里没有可识别的收录字段，已忽略。要投稿请用「MCP 收录」模板，或从面板里的「投稿到这份清单」链接打开。';
  }
  return [
    `❌ ${name2}没有通过校验，清单里没有改动：`,
    '',
    ...(errors ?? []).map((e) => `- ${e}`),
    '',
    '改好之后编辑这条 issue 即可（工作流会在编辑时重新校验）。',
  ].join('\n');
}

/**
 * The whole program, with its I/O injected so the logic can be tested without a
 * repository on disk.
 */
export async function runRegistrySubmission(argv = [], io = {}) {
  const read = io.readFile ?? readFile;
  const write = io.writeFile ?? writeFile;
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const now = io.now ?? Date.now;
  const opts = parseArgs(argv);
  if (opts.help) return { code: 0, report: { action: 'help', usage: USAGE } };

  let text;
  try {
    text = opts.bodyFile ? await read(opts.bodyFile, 'utf8') : (opts.body ?? '');
  } catch (err) {
    out(`读取 issue 正文失败：${err?.message ?? err}\n`);
    return { code: 2, report: { action: 'error', error: String(err?.message ?? err) } };
  }

  let current;
  try {
    current = JSON.parse(await read(opts.registry, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      out(`读取 ${opts.registry} 失败：${err?.message ?? err}\n`);
      return { code: 2, report: { action: 'error', error: String(err?.message ?? err) } };
    }
    current = undefined; // No document yet: this submission starts one.
  }

  const fields = parseSubmissionBody(text);
  const checked = looksLikeSubmission(fields) ? rowFromFields(fields) : null;

  if (opts.check) {
    // The committed document is vetted by the same gate as an issue: a row typed
    // straight into the file is not more trustworthy than one submitted.
    const rows = Array.isArray(current) ? current : Array.isArray(current?.servers) ? current.servers : [];
    const problems = [];
    rows.forEach((row, index) => {
      const vetted = normalizeRegistryRow(row);
      if (vetted.errors) problems.push(`第 ${index + 1} 行（${row?.name ?? '无名'}）：${vetted.errors.join('；')}`);
    });
    const report = { action: problems.length ? 'invalid' : 'valid', rows: rows.length, problems };
    out(`${JSON.stringify(report, null, 2)}\n`);
    return { code: problems.length ? 1 : 0, report };
  }

  if (checked === null) {
    const report = { action: 'ignored', reason: '正文里没有可识别的收录字段' };
    out(`${JSON.stringify(report, null, 2)}\n`);
    if (opts.comment) await write(opts.comment, `${commentFor({ action: 'ignored' })}\n`, 'utf8');
    return { code: 0, report };
  }

  if (checked.errors) {
    const report = { action: 'refused', errors: checked.errors };
    out(`${JSON.stringify(report, null, 2)}\n`);
    if (opts.comment) await write(opts.comment, `${commentFor({ action: 'refused', errors: checked.errors, name: fields.name })}\n`, 'utf8');
    return { code: 1, report };
  }

  const { doc, action } = appendSubmission(current, checked.row, { now: now() });
  const report = {
    action,
    row: checked.row,
    servers: doc.servers.length,
    updatedAt: doc.updatedAt,
    wrote: false,
  };
  if (opts.write && action !== 'unchanged') {
    await write(opts.registry, registryTextOf(doc), 'utf8');
    report.wrote = true;
  }
  out(`${JSON.stringify(report, null, 2)}\n`);
  if (opts.comment) await write(opts.comment, `${commentFor({ action, row: checked.row })}\n`, 'utf8');
  return { code: 0, report };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const { code } = await runRegistrySubmission(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n${USAGE}\n`);
    return { code: 2 };
  });
  process.exitCode = code;
}
