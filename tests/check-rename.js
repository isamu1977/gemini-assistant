#!/usr/bin/env node
/*
 * check-rename.js
 * 
 * One-shot validation of an entire Project JSON:
 *   1. Parses with project.js
 *   2. Walks all tasks, computing the desiredFilename each one will produce
 *      via output.js (sanitization + ext + folder).
 *   3. Prints a table. Exits non-zero if any filename is unsafe or empty.
 *
 * Usage:
 *   node tests/check-rename.js <path-to-project.json>
 *   node tests/check-rename.js examples/project-yuki-test.json
 *
 * This is useful to confirm BEFORE opening Chrome that the project will
 * produce correctly-named downloads.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Match the load order documented in tests/run.js (output.js first).
const outputLib = require(path.join(ROOT, 'src/lib/output.js'));
globalThis.GeminiAssistantOutput = outputLib;
const projectLib = require(path.join(ROOT, 'src/lib/project.js'));

function showHelp(code) {
  console.log('Usage: node tests/check-rename.js <path-to-project.json>');
  console.log('       node tests/check-rename.js examples/project-yuki-test.json');
  process.exit(code);
}

const arg = process.argv[2];
if (!arg) showHelp(1);

let raw;
try { raw = fs.readFileSync(path.resolve(arg), 'utf8'); }
catch (e) { console.error('Cannot read file:', arg, '-', e.message); process.exit(2); }

const r = projectLib.parseProjectJson(raw);
if (!r.ok) {
  console.error('Project JSON is invalid:');
  for (const err of r.errors || []) console.error('  -', err.error || JSON.stringify(err));
  process.exit(3);
}

const proj = r.project;
const folder = outputLib.buildDownloadFolder(proj.project.id);
if (!folder) {
  console.error('Project id is unsafe, would create bad download folder:', JSON.stringify(proj.project.id));
  process.exit(4);
}

console.log('OK - project parses (Schema v' + proj.schemaVersion + ')');
console.log('  project id :', proj.project.id);
console.log('  tasks      :', proj.tasks.length);
console.log('  assets     :', Object.keys(proj.assets || {}).length);
console.log('  folder     :', folder);
console.log('');

let exitCode = 0;
const rows = [];
for (const t of proj.tasks) {
  const basename = projectLib.resolveTaskOutputBasename(proj, t.id);
  const safe = typeof basename === 'string' && basename.length > 0 &&
    !basename.includes('/') && !basename.includes('\\') && basename !== '..';
  if (!safe) exitCode = 5;
  const finalName = safe ? outputLib.buildDownloadFilename(basename, 'image/png') : null;
  if (!finalName) exitCode = 5;
  const fullPath = folder + '/' + finalName;
  rows.push({
    taskId: t.id,
    title: t.title || '-',
    basename: basename,
    filename: finalName || '(INVALID)',
    path: fullPath,
    status: safe && finalName ? 'OK' : 'INVALID',
  });
}

for (const r of rows) {
  console.log('  [' + r.status + '] ' + r.taskId.padEnd(12) + ' -> ' + r.path);
  if (r.status !== 'OK') {
    console.error('     basename:', JSON.stringify(r.basename), ' task id:', JSON.stringify(r.taskId));
  }
}

console.log('');
console.log('Final download directory template:');
console.log('  ~/Downloads/' + folder + '/');
console.log('');
console.log('These are the filenames the SW will rename to via onDeterminingFilename.');
console.log('If any task above is INVALID, fix the JSON (add output.fileName or fix task.id).');

process.exit(exitCode);
