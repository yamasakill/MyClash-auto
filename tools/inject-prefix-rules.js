'use strict';

const fs = require('node:fs');

const { mergeUpstream } = require('./merge-upstream');

const [, , upstreamPath, outputPath, rulesPath] = process.argv;

if (!upstreamPath || !outputPath || !rulesPath) {
  console.error('Usage: node tools/inject-prefix-rules.js upstream output rules');
  process.exit(1);
}

// 在 GitHub Actions 里同步时，先把上游 main 合并进来，让 fork 始终包含上游提交，
// compare / PR 才不会因为落后上游而冲突。失败时只打印日志，不影响规则注入。
if (process.env.GITHUB_ACTIONS === 'true') {
  try {
    mergeUpstream(process.cwd());
  } catch (error) {
    console.error('[sync] skipped upstream merge: ' + error.message);
  }
}

const upstream = fs.readFileSync(upstreamPath, 'utf8');
const lineBreak = upstream.includes('\r\n') ? '\r\n' : '\n';

const rules = fs
  .readFileSync(rulesPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

if (rules.length === 0) {
  throw new Error('custom-prefix-rules.txt is empty');
}

const declaration = 'const prefixRules = [';
const declarationIndex = upstream.indexOf(declaration);

if (declarationIndex === -1) {
  throw new Error('Cannot find const prefixRules = [ in upstream script');
}

const lineEndIndex = upstream.indexOf('\n', declarationIndex);

if (lineEndIndex === -1) {
  throw new Error('Cannot find the end of prefixRules declaration');
}

const markerStart = '  // >>> CUSTOM PREFIX RULES >>>';
const markerEnd = '  // <<< CUSTOM PREFIX RULES <<<';

const block = [markerStart, ...rules.map((rule) => `  '${rule.replace(/'/g, "\\'")}',`), markerEnd, ''].join(lineBreak);

const output = upstream.slice(0, lineEndIndex + 1) + block + upstream.slice(lineEndIndex + 1);

fs.writeFileSync(outputPath, output, 'utf8');

console.log(`Inserted ${rules.length} custom rules.`);
