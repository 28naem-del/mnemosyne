#!/usr/bin/env node
/** Regenerate a descriptive index of supplied reports; never runs or invents models. */
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
const { values, positionals } = parseArgs({ options: { out: { type: 'string' }, check: { type: 'boolean', default: false } }, allowPositionals: true, strict: true });
if (!values.out || !positionals.length) throw new Error('Usage: node scripts/benchmark-index.mjs [--check] --out BENCHMARKS.md REPORT.json [...]');
const out = resolve(values.out);
const escape = text => String(text).replace(/[|\r\n]/g, ' ').replace(/[<>]/g, '').slice(0, 512);
const percent = value => typeof value === 'number' && Number.isFinite(value) ? `${(100 * value).toFixed(2)}%` : 'not measured';
const fraction = (value, total) => typeof value === 'number' && Number.isFinite(value) && total > 0 ? `${Math.round(value * total)}/${total} (${percent(value)})` : 'not measured';
const lines = ['# Reproducible retrieval measurements', '', 'Generated from the linked reports. These are evidence-retrieval measurements, not generated-answer accuracy, judge scores, or proof of superiority to another memory system.', '', '| Report / condition | Questions (positive labels) | All evidence before packing | All evidence after packing | Mean evidence recall after packing | Overflows / errors |', '|---|---:|---:|---:|---:|---:|'];
const methods = [];
for (const path of positionals) {
  const absolute = resolve(path), stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 67_108_864) throw new Error('Reports must be bounded regular JSON files.');
  const report = JSON.parse(readFileSync(absolute, 'utf8'));
  if (report.kind !== 'offline corpus retrieval evaluation' || report.protocol !== 'mnemosyne-corpus-retrieval-v1' || report.answerQuality !== 'not-evaluated' || report.calls?.generation !== 0 || report.calls?.judge !== 0 || !report.summaries || !report.dataset?.normalizedSha256) throw new Error('Expected a corpus retrieval report, with no generated-answer claim.');
  const link = relative(resolve(out, '..'), absolute).split('/').map(encodeURIComponent).join('/');
  for (const [condition, summary] of Object.entries(report.summaries)) lines.push(`| [${escape(basename(path))}](${link}) / ${escape(condition)} | ${summary.questions} (${summary.annotatedQuestions}) | ${fraction(summary.allHitRate, summary.annotatedQuestions)} | ${fraction(summary.packedAllHitRate, summary.annotatedQuestions)} | ${percent(summary.packedMeanRecall)} | ${summary.overflows} / ${summary.errors} |`);
  const timestampNotice = report.notices?.find(notice => typeof notice === 'string' && notice.startsWith('Timestamp policy:'));
  methods.push(`- **${escape(basename(path))}:** dataset ${escape(report.dataset.dataset)}, revision ${escape(report.dataset.revision)}, license ${escape(report.dataset.license)}. Source SHA256 \`${escape(report.dataset.sourceSha256 ?? 'caller did not supply original-file digest')}\`; normalized input SHA256 \`${report.dataset.normalizedSha256}\`; runtime implementation SHA256 \`${report.runtime.implementationSha256}\`. K=${report.settings.topK} UTF-8 chunks, chunk bytes=${report.settings.chunkBytes}, context budget=${report.settings.maxContextUnits} ${escape(report.settings.accountingId)}. Complete=${report.complete}.${timestampNotice ? ` ${escape(timestampNotice)}` : ''}`);
}
lines.push('', '## Interpretation', '', '- Positive evidence metrics exclude unanswerable and unannotated questions, while attempts and failures remain visible. Read each raw report for category and schema coverage.', '- Full-context overflow means the complete history did not fit. It contributes zero packed evidence; the runner does not silently truncate it.', '- A group hit may be any chunk of an original turn/session. It is not proof that the answer-bearing passage was delivered or that a model answered correctly.', '- Latency is descriptive local timing. Provider, tokenizer, packing and candidate settings must match for a meaningful comparison.', '', '## Provenance', '', ...methods, '', '## Reproduce', '', 'Build the repository, then run `node dist/evaluation/corpus-cli.js --help`. Supply your locally acquired pinned dataset and its license; no raw third-party dataset is bundled. Omit `--embedding-config` for zero model calls. Use the same options and runtime implementation to reproduce a report.', '', 'See the repository corpus protocol guide for exact commands, label boundaries, optional embeddings, dataset licenses and denominator definitions.', '', 'Regenerate this index with `node scripts/benchmark-index.mjs --out docs/evaluation/BENCHMARKS.md REPORT.json [...]`.', '');
const rendered = lines.join('\n');
if (values.check) {
  const existing = lstatSync(out);
  if (!existing.isFile() || existing.isSymbolicLink() || existing.size > 67_108_864) throw new Error('Expected a bounded regular benchmark index.');
  if (readFileSync(out, 'utf8') !== rendered) throw new Error('Benchmark index is stale. Regenerate it with the same arguments, omitting --check.');
} else writeFileSync(out, rendered);
