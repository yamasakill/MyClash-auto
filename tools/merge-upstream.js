'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const UPSTREAM_URL = 'https://github.com/AIsouler/MyClash.git';
const UPSTREAM_BRANCH = 'main';
const GENERATED_FILE = 'Script/mihomoScript.js';
const WORKFLOW_PREFIX = '.github/workflows/';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function changedPaths(cwd) {
  const out = git(['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD'], cwd);
  return out ? out.split('\n').filter(Boolean) : [];
}

function pathInHead(cwd, file) {
  try {
    git(['cat-file', '-e', 'HEAD:' + file], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * 合并上游后把 .github/workflows 里的文件强制还原成 fork 自己的版本：
 * 推送时永远不改动 workflow 文件，避免 token / GitHub App 的 workflows 权限限制，
 * 也不会被上游的 CI 配置覆盖。
 */
function keepOwnWorkflows(cwd) {
  const files = changedPaths(cwd).filter((file) => file.startsWith(WORKFLOW_PREFIX));

  for (const file of files) {
    if (pathInHead(cwd, file)) {
      git(['checkout', 'HEAD', '--', file], cwd);
    } else {
      git(['rm', '-f', '--quiet', '--ignore-unmatch', '--cached', '--', file], cwd);
      fs.rmSync(cwd + '/' + file, { force: true });
    }
  }
}

/**
 * 把上游 main 合并进当前分支，让 fork 的历史始终包含上游提交。
 * 只允许生成文件冲突（调用方会用最新上游内容重写它），其它冲突一律 abort。
 */
function mergeUpstream(cwd) {
  if (git(['rev-parse', '--is-shallow-repository'], cwd) === 'true') {
    git(['fetch', '--unshallow', '--no-tags', 'origin'], cwd);
  }

  try {
    git(['remote', 'get-url', 'upstream'], cwd);
  } catch {
    git(['remote', 'add', 'upstream', UPSTREAM_URL], cwd);
  }

  git(['fetch', '--no-tags', 'upstream', UPSTREAM_BRANCH], cwd);

  try {
    git(['merge', '--no-commit', '--no-ff', 'upstream/' + UPSTREAM_BRANCH], cwd);
  } catch {
    const unmerged = git(['diff', '--name-only', '--diff-filter=U'], cwd);
    const conflicts = unmerged ? unmerged.split('\n').filter(Boolean) : [];
    const unexpected = conflicts.filter((file) => file !== GENERATED_FILE && !file.startsWith(WORKFLOW_PREFIX));

    if (conflicts.length === 0 || unexpected.length > 0) {
      git(['merge', '--abort'], cwd);
      throw new Error('unexpected merge conflicts: ' + (unexpected.join(', ') || 'unknown'));
    }
  }

  keepOwnWorkflows(cwd);

  return fs.existsSync(cwd + '/.git/MERGE_HEAD');
}

module.exports = { mergeUpstream };
