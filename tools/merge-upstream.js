'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const UPSTREAM_URL = 'https://github.com/AIsouler/MyClash.git';
const UPSTREAM_BRANCH = 'main';
const GENERATED_FILE = 'Script/mihomoScript.js';
const WORKFLOW_PREFIX = '.github/workflows/';

// git merge / git commit 需要 committer 身份，而 actions/checkout 只做检出、不配置身份。
// 以前 merge 在这里直接报 Committer identity unknown，随后被上层 catch 吞成一行
// "skipped upstream merge"，于是工作流一直绿灯、fork 却一直落后上游。
// 这里每次调用都显式带上身份，不依赖工作流里的 git config 顺序。
const IDENTITY = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
];

function git(args, cwd) {
  return execFileSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitTry(args, cwd) {
  try {
    return { ok: true, out: git(args, cwd), message: '' };
  } catch (error) {
    const stderr = (error.stderr || '').toString().trim();
    const stdout = (error.stdout || '').toString().trim();
    return { ok: false, out: stdout, message: (stderr || stdout || error.message).trim() };
  }
}

function mergingInProgress(cwd) {
  return fs.existsSync(cwd + '/.git/MERGE_HEAD');
}

function changedPaths(cwd) {
  const out = git(['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD'], cwd);
  return out ? out.split('\n').filter(Boolean) : [];
}

function pathInHead(cwd, file) {
  return gitTry(['cat-file', '-e', 'HEAD:' + file], cwd).ok;
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
      gitTry(['rm', '-f', '--quiet', '--ignore-unmatch', '--cached', '--', file], cwd);
      fs.rmSync(cwd + '/' + file, { force: true });
    }
  }
}

function abortMerge(cwd) {
  if (!mergingInProgress(cwd)) {
    return;
  }

  const result = gitTry(['merge', '--abort'], cwd);

  if (!result.ok) {
    // merge --abort 本身失败时兜底回到干净状态，避免把半个冲突留在工作区。
    gitTry(['reset', '--hard', 'HEAD'], cwd);
  }
}

/**
 * 把上游 main 合并进当前分支，让 fork 的历史始终包含上游提交。
 * 只允许生成文件冲突（调用方会用最新上游内容重写它），其它冲突一律 abort。
 *
 * 返回 true 表示产生了待提交的合并（MERGE_HEAD 存在）。
 */
function mergeUpstream(cwd) {
  if (git(['rev-parse', '--is-shallow-repository'], cwd) === 'true') {
    git(['fetch', '--unshallow', '--no-tags', 'origin'], cwd);
  }

  if (!gitTry(['remote', 'get-url', 'upstream'], cwd).ok) {
    git(['remote', 'add', 'upstream', UPSTREAM_URL], cwd);
  }

  git(['fetch', '--no-tags', 'upstream', UPSTREAM_BRANCH], cwd);

  const target = 'upstream/' + UPSTREAM_BRANCH;

  if (gitTry(['merge-base', '--is-ancestor', target, 'HEAD'], cwd).ok) {
    console.log('[sync] upstream main is already merged, nothing to do.');
    return false;
  }

  const merged = gitTry(['merge', '--no-commit', '--no-ff', target], cwd);

  if (!merged.ok) {
    const unmerged = gitTry(['diff', '--name-only', '--diff-filter=U'], cwd);
    const conflicts = unmerged.ok && unmerged.out ? unmerged.out.split('\n').filter(Boolean) : [];
    const unexpected = conflicts.filter((file) => file !== GENERATED_FILE && !file.startsWith(WORKFLOW_PREFIX));

    if (conflicts.length === 0 || unexpected.length > 0) {
      const detail = unexpected.length > 0 ? 'unexpected conflicts in ' + unexpected.join(', ') : merged.message;
      abortMerge(cwd);
      throw new Error('upstream merge failed: ' + detail);
    }

    console.log('[sync] conflicts limited to ' + GENERATED_FILE + ', it will be regenerated.');
  }

  keepOwnWorkflows(cwd);

  return mergingInProgress(cwd);
}

module.exports = { mergeUpstream };
