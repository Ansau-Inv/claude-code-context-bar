#!/usr/bin/env node
/**
 * context-bar 安装 / 卸载 / 查看
 *
 *   node install.mjs              安装
 *   node install.mjs --uninstall  卸载
 *   node install.mjs --status     查看当前状态
 *
 * 改动只有 ~/.claude/settings.json 里的一个 statusLine 键。
 * 该文件按原文做字符串增删，不做 JSON 重新序列化，卸载后能逐字节还原，
 * 因此不会打乱你的键顺序和缩进，也不会碰 Claude Code 之外的任何设置。
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'context-bar.mjs');
const TARGET_DIR = join(homedir(), '.claude', 'statusline-context-bar');
const TARGET = join(TARGET_DIR, 'context-bar.mjs');
const SETTINGS = join(homedir(), '.claude', 'settings.json');
const MARKER = 'statusline-context-bar';
// Claude Code 在 Windows 上经由 Git Bash 执行命令，反斜杠会被当转义符吃掉，
// 所以路径一律用正斜杠；~ 由 Claude Code 展开为 home。默认留白见下方 --margin。
const DEFAULT_MARGIN = 4;

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? null : v;
};

// --margin N 可覆盖写入 settings.json 的默认留白。
// 注意用 Number.isFinite 而不是 ||，否则 --margin 0 会被当成假值退回 4。
const marginArg = argOf('--margin');
const marginNum = marginArg === null ? null : Number(marginArg);
const margin = marginNum !== null && Number.isFinite(marginNum) ? Math.max(0, Math.trunc(marginNum)) : DEFAULT_MARGIN;
const command = `node ~/.claude/statusline-context-bar/context-bar.mjs --margin ${margin}`;

const log = (s) => process.stdout.write(s + '\n');

function fail(msg) {
  process.stderr.write('错误: ' + msg + '\n');
  process.exit(1);
}

// 从 '{' 起做括号配对（跳过字符串字面量），返回配对 '}' 的下标
function matchingBrace(text, open) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readSettings() {
  if (!existsSync(SETTINGS)) fail(`找不到 ${SETTINGS}（先运行一次 Claude Code 让它生成）`);
  const raw = readFileSync(SETTINGS, 'utf8');
  try {
    JSON.parse(raw);
  } catch (e) {
    fail(`${SETTINGS} 不是合法 JSON，已中止：${e.message}`);
  }
  return raw;
}

function findStatusLine(raw) {
  const m = /"statusLine"\s*:\s*\{/.exec(raw);
  if (!m) return null;
  const open = raw.indexOf('{', m.index);
  const close = matchingBrace(raw, open);
  if (close < 0) fail('statusLine 块括号不匹配，已中止');
  return { start: m.index, close, text: raw.slice(m.index, close + 1) };
}

function save(raw, label) {
  try {
    JSON.parse(raw);
  } catch (e) {
    fail(`${label} 后 JSON 校验失败，未写入：${e.message}`);
  }
  writeFileSync(SETTINGS, raw, 'utf8');
}

// ---------------- status ----------------
if (args.includes('--status')) {
  log(`settings : ${SETTINGS}`);
  log(`script   : ${TARGET} ${existsSync(TARGET) ? '(已安装)' : '(未安装)'}`);
  const node = findStatusLine(readSettings());
  log(node ? `statusLine:\n${node.text}` : 'statusLine: 未配置');
  process.exit(0);
}

// ---------------- uninstall ----------------
if (args.includes('--uninstall')) {
  const raw = readSettings();
  const node = findStatusLine(raw);

  if (!node) {
    log('settings.json 里没有 statusLine，无需移除。');
  } else if (!node.text.includes(MARKER)) {
    fail(`statusLine 指向的不是本工具，拒绝删除：\n${node.text}`);
  } else {
    let { start, close } = node;
    // 优先吃掉前面的逗号；statusLine 若是第一个键，则连前面的空白和后面的逗号一起处理
    let k = start - 1;
    while (k >= 0 && /\s/.test(raw[k])) k--;
    if (k >= 0 && raw[k] === ',') {
      start = k;
    } else {
      start = k + 1;
      let j = close + 1;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      if (j < raw.length && raw[j] === ',') close = j;
    }
    save(raw.slice(0, start) + raw.slice(close + 1), '移除 statusLine');
    log('已从 settings.json 移除 statusLine。');
  }
  // 若仓库本身就在安装目录里（用户直接 clone 到那儿），不能删——那会把仓库一起删掉
  if (existsSync(TARGET_DIR) && !HERE.startsWith(TARGET_DIR)) {
    rmSync(TARGET_DIR, { recursive: true, force: true });
    log(`已删除 ${TARGET_DIR}`);
  } else if (existsSync(TARGET_DIR)) {
    rmSync(TARGET, { force: true });
    log(`已删除 ${TARGET}`);
  }
  log('卸载完成，重启 Claude Code 生效。');
  process.exit(0);
}

// ---------------- install ----------------
if (!existsSync(SRC)) fail(`找不到源文件 ${SRC}`);
if (!existsSync(join(homedir(), '.claude'))) fail('找不到 ~/.claude 目录，先运行一次 Claude Code');

mkdirSync(TARGET_DIR, { recursive: true });
copyFileSync(SRC, TARGET);

const raw = readSettings();
const node = findStatusLine(raw);

if (node) {
  if (node.text.includes(MARKER)) {
    // 已装过：只更新 command（可能改了 margin），不动其余
    const updated = raw.slice(0, node.start) + `"statusLine": {\n    "type": "command",\n    "command": "${command}"\n  }` + raw.slice(node.close + 1);
    if (updated !== raw) {
      save(updated, '更新 statusLine');
      log('已更新 statusLine 命令。');
    } else {
      log('statusLine 已是本工具，无需改动。');
    }
  } else {
    fail(`settings.json 里已有别的 statusLine，拒绝覆盖。请先手动处理：\n${node.text}`);
  }
} else {
  const close = raw.lastIndexOf('}');
  if (close < 0) fail('settings.json 结构异常，已中止');
  let j = close - 1;
  while (j >= 0 && /\s/.test(raw[j])) j--;
  const comma = j >= 0 && raw[j] !== '{' ? ',' : '';
  // 尾部换行沿用原文自带的，不额外添加，卸载时才能逐字节还原
  const block = `${comma}\n  "statusLine": {\n    "type": "command",\n    "command": "${command}"\n  }`;
  save(raw.slice(0, j + 1) + block + raw.slice(j + 1), '写入 statusLine');
  log('已写入 settings.json。');
}

log(`脚本已安装到 ${TARGET}`);
log('重启 Claude Code 后生效。预览: node ' + JSON.stringify(TARGET));
