// Prints per-column coverage averages (% Stmts / % Branch / % Funcs / % Lines)
// from the istanbul JSON that `npm test` emits (coverage/coverage-final.json).
//
// `make test` runs this after the suite, so every run ends with a compact
// headline for each reporter column no matter how long the per-file table is.
// Averages are simple means across instrumented files, reported both overall
// and per threshold glob (shared / main worker) to mirror vitest.config.js.
//
// Dev-side Node tooling only — never imported by the Workers bundles.

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const COVERAGE_FILE = resolve('coverage', 'coverage-final.json');

function pct(covered, total) {
  return total === 0 ? null : (100 * covered) / total;
}

/** Per-column percentages for one istanbul file entry (null = nothing to measure). */
function fileMetrics(entry) {
  const statements = Object.values(entry.s ?? {});
  const statementCovered = statements.filter((count) => count > 0).length;

  let branchTotal = 0;
  let branchCovered = 0;
  for (const counts of Object.values(entry.b ?? {})) {
    branchTotal += counts.length;
    branchCovered += counts.filter((count) => count > 0).length;
  }

  const functions = Object.values(entry.f ?? {});

  // Lines are derived the istanbul way: a line counts as covered when any
  // statement starting on it executed (the v8 JSON has no line section).
  const lineCounts = new Map();
  for (const [id, count] of Object.entries(entry.s ?? {})) {
    const line = entry.statementMap?.[id]?.start?.line;
    if (line === undefined) continue;
    lineCounts.set(line, Math.max(lineCounts.get(line) ?? 0, count));
  }
  const lineValues = [...lineCounts.values()];

  return {
    '% Stmts': pct(statementCovered, statements.length),
    '% Branch': pct(branchCovered, branchTotal),
    '% Funcs': pct(functions.filter((count) => count > 0).length, functions.length),
    '% Lines': pct(lineValues.filter((count) => count > 0).length, lineValues.length),
  };
}

/** Mean of a metric over the files where it is measurable. */
function average(metrics, key) {
  const values = metrics.map((m) => m[key]).filter((value) => value !== null);
  return {
    value: values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length,
    files: values.length,
  };
}

function format({ value, files }) {
  if (files === 0) return `${'n/a'.padStart(6)}      `.padEnd(12);
  return `${value.toFixed(2).padStart(6)} (${files})`.padEnd(12);
}

let coverage;
try {
  coverage = JSON.parse(readFileSync(COVERAGE_FILE, 'utf8'));
} catch (error) {
  console.error(`coverage-averages: cannot read ${COVERAGE_FILE}: ${error.message}`);
  console.error('Run the test suite with coverage first (npm test).');
  process.exit(1);
}

const entries = Object.entries(coverage).map(([file, data]) => ({
  relPath: relative(process.cwd(), file),
  metrics: fileMetrics(data),
}));

const scopes = [
  { label: 'all files', files: entries },
  { label: 'shared', files: entries.filter((e) => e.relPath.startsWith('src/shared/')) },
  {
    label: 'main-worker',
    files: entries.filter((e) => e.relPath.startsWith('src/zai-main-worker/src/')),
  },
];

console.log('\nCoverage averages per column (mean across files, covered/total in parens):');
console.log(
  `  ${'scope'.padEnd(13)}${['% Stmts', '% Branch', '% Funcs', '% Lines']
    .map((header) => header.padStart(6).padEnd(12))
    .join('')}`,
);
for (const { label, files } of scopes) {
  if (files.length === 0) {
    console.log(`  ${label.padEnd(13)}  no instrumented files`);
    continue;
  }
  const metrics = files.map((e) => e.metrics);
  const cells = ['% Stmts', '% Branch', '% Funcs', '% Lines'].map((key) =>
    format(average(metrics, key)),
  );
  console.log(`  ${label.padEnd(13)}${cells.join('')}`);
}
