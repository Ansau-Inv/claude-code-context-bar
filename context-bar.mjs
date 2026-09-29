#!/usr/bin/env node
/**
 * Claude Code statusline — context usage bar
 *
 * 三行输出：满宽色带 / 模型与 ctx / 分段明细（可选）。
 * 数据源是 Claude Code 从 stdin 传入的 JSON，固定开销部分从 transcript 读取。
 *
 * 用法见 README。开关：
 *   --margin N        右侧留白列数（默认 4）
 *   --no-breakdown    不输出第三行分段明细
 *   --lang zh|en      明细标签语言（默认 zh）
 *   --no-color        等价于 NO_COLOR=1
 */
import { readFileSync, writeFileSync, statSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
};

const MARGIN_DEFAULT = 4;
// 留白不能为负，否则条会比可用宽度还长
const WIDTH_MARGIN = Math.max(0, Number(flagValue('--margin', process.env.CTXBAR_MARGIN ?? MARGIN_DEFAULT)) || MARGIN_DEFAULT);
const BREAKDOWN_OFF = argv.includes('--no-breakdown');
const LANG = flagValue('--lang', 'zh') === 'en' ? 'en' : 'zh';
// 终端最小按 20 列算；再窄也至少给条体 10 列，否则没有可读性
const MIN_COLS = 20;
const MIN_BAR = 10;

// 固定开销段：对应官方 /context 的分类。颜色由深到浅 = 由固定到流动。
const SEGMENTS = {
  system: '#1B2A5E',
  tools: '#2B4C8C',
  mcp: '#4D6BFE',
  skills: '#7A9BFF',
  memory: '#A8C0FF',
  convo: '#C9D6F0',
};
const ORDER = ['system', 'tools', 'mcp', 'skills', 'memory', 'convo'];
const LABELS = {
  zh: { system: '系统', tools: '工具', mcp: 'MCP', skills: '技能', memory: '记忆', convo: '对话', free: '自由', cache: '缓存' },
  en: { system: 'sys', tools: 'tools', mcp: 'mcp', skills: 'skills', memory: 'mem', convo: 'chat', free: 'free', cache: 'cache' },
}[LANG];
// 自由段的 chip 色：条上的暗灰在深色终端里当 chip 太不显眼
const FREE_CHIP = '#4A5568';

const FREE_FILL = '#2E3440';
const FREE_TEXT = '#8D95A6';
const WARN_TEXT = '#D08C2A';
const DANGER_TEXT = '#E5484D';
const WARN_AT = 80;
const DANGER_AT = 95;

// ASCII 字符 → token 的换算。对着 /context 面板校准过：系统提示词 27550 字符
// ≈ 9.1k、工具定义 515550 字符 ≈ 167.8k，都落在 3.0~3.1。提示词和 JSON schema
// 标点密集，比英文散文（约 4 字符/token）更费 token。CJK 按 1 字符/token。
const ASCII_PER_TOKEN = 3.05;

const ANSI = /\x1b\[[0-9;]*m/g;
const useColor = !process.env.NO_COLOR && !argv.includes('--no-color');

const hexToRgb = (hex) => {
  const v = Number.parseInt(hex.replace(/^#/, ''), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
};
const fg = (hex, s) => (useColor ? `\x1b[38;2;${hexToRgb(hex).join(';')}m${s}\x1b[39m` : s);
const bg = (hex, s) => (useColor ? `\x1b[48;2;${hexToRgb(hex).join(';')}m${s}\x1b[49m` : s);
const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[22m` : s);

// East-Asian ambiguous 字符（·、█、…）按 1 列计，与 dsh-tui 的
// eastAsianWidth({ambiguousAsWide:false}) 一致。只有真全角算 2。
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;

function width(s) {
  let n = 0;
  for (const ch of s.replace(ANSI, '')) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

// 按 token 切，避免把 ANSI 序列截断露出 "[48;2;…" 这类残片
function truncate(s, max) {
  if (max <= 0) return '';
  if (width(s) <= max) return s;
  let out = '';
  let used = 0;
  for (const tok of s.match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? []) {
    if (tok.startsWith('\x1b[')) {
      out += tok;
      continue;
    }
    const w = WIDE.test(tok) ? 2 : 1;
    if (used + w > max - 1) break;
    out += tok;
    used += w;
  }
  return out + (useColor ? '\x1b[0m' : '') + '…';
}

// 紧凑 token 数：988 / 3.4k / 12k / 1.0M
function fmtTokens(count) {
  const v = Math.max(0, Math.round(count));
  if (v < 1000) return String(v);
  if (v < 10000) return (v / 1000).toFixed(1) + 'k';
  if (v < 1000000) return Math.round(v / 1000) + 'k';
  if (v < 10000000) return (v / 1000000).toFixed(1) + 'M';
  return Math.round(v / 1000000) + 'M';
}

// 已知字符数直接换算，避免为了数长度去构造超长字符串
const tokensForChars = (chars) => chars / ASCII_PER_TOKEN;

// 字符 → token。入参可能是字符串或字符串数组（systemPrompt 就是数组）。
function estTokens(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return ascii / ASCII_PER_TOKEN + other;
}

// 最大余数法：取整后总列数不丢
function allocate(values, total) {
  const sum = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v / sum) * total);
  const alloc = raw.map(Math.floor);
  let left = total - alloc.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, r: v - Math.floor(v) }))
    .sort((a, b) => b.r - a.r);
  for (const { i } of order) {
    if (left <= 0) break;
    alloc[i]++;
    left--;
  }
  return alloc;
}

// 在固定总列数内按比例分配，但每个非零段保底 1 列。
// 保底列从「按比例该拿的列」里扣，总额严格等于 total，
// 因此不会溢出到自由段去——色块边界仍与读数一致。
function allocateWithFloor(values, total) {
  const n = values.length;
  if (total <= 0) return values.map(() => 0);
  const positive = values.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  if (positive.length === 0) return values.map(() => 0);
  // 列数比段数还少时，优先给占比大的
  if (positive.length > total) {
    const order = [...positive].sort((a, b) => values[b] - values[a]);
    const out = values.map(() => 0);
    for (let k = 0; k < total; k++) out[order[k]] = 1;
    return out;
  }
  const rest = allocate(values, total - positive.length);
  return values.map((v, i) => (v > 0 ? 1 + (rest[i] ?? 0) : 0));
}

// 右对齐，取第一个放得下的选项（窄处自动退成只有百分比）
function rightAlign(options, total) {
  for (const opt of options) {
    const pad = total - width(opt);
    if (pad >= 0) return ' '.repeat(pad) + opt;
  }
  return ' '.repeat(Math.max(0, total));
}

// 分段明细：chip（该段颜色的一个空格）+ 标签 + token 数。
// 参照 dsh-tui 的 contextBarBreakdown：先试最宽的形式，放不下再逐级丢弃。
function renderBreakdown(entries, budget) {
  if (budget < 8) return '';
  const one = (e) => bg(e.color, ' ') + ' ' + e.label + ' ' + fmtTokens(e.tokens);

  // 先丢最不重要的：自由段权重记 0，永远第一个走，然后是占比最小的。
  // 保留项的排列顺序始终跟条上一致（深→浅），方便和色带一一对照。
  const weight = (e) => (e.key === 'free' ? 0 : e.tokens);
  const dropOrder = [...entries].sort((a, b) => weight(a) - weight(b)).map((e) => e.key);

  for (let drop = 0; drop <= entries.length - 1; drop++) {
    const list = entries.filter((e) => !dropOrder.slice(0, drop).includes(e.key));
    if (list.length === 0) break;
    // 前两级只换分隔符，之后才开始丢内容
    const sep = drop === 0 ? ' · ' : ' ';
    const text = list.map(one).join(dim(sep));
    if (width(text) <= budget) return text;
  }
  const biggest = [...entries].sort((a, b) => weight(b) - weight(a))[0];
  return truncate(one(biggest), budget);
}

// ---- transcript 解析：读取固定开销，按 mtime+size 缓存 ----
// 缓存放临时目录，避免污染仓库；文件名带 transcript 路径哈希，
// 这样多个会话并行时不会互相冲刷缓存。
const CACHE_DIR = tmpdir();
const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};
const cachePath = (transcript) => join(CACHE_DIR, 'cc-context-bar-' + hash(transcript) + '.json');

// 诊断开关：脚本目录下存在 diag.on 即开启（临时文件，排查完删掉）
const HERE = dirname(fileURLToPath(import.meta.url));
const DIAG_ON = join(HERE, 'diag.on');
const DIAG_LOG = join(HERE, 'diag.log');

// 超大 transcript 不解析，避免首帧卡顿（仍会退回单色条）
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function cached(transcript) {
  try {
    const st = statSync(transcript);
    const c = JSON.parse(readFileSync(cachePath(transcript), 'utf8'));
    if (c.file === transcript && c.size === st.size && c.mtime === st.mtimeMs) return c.fixed;
  } catch {
    // 无缓存或不一致，重新解析
  }
  return null;
}

function parseFixed(transcript) {
  let st;
  try {
    st = statSync(transcript);
  } catch {
    return null;
  }
  if (st.size > MAX_TRANSCRIPT_BYTES) return null;
  let raw;
  try {
    raw = readFileSync(transcript, 'utf8');
  } catch {
    return null;
  }

  let snap = null;
  let skillChars = 0;
  let memChars = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.indexOf('"attachment"') < 0) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const a = o.attachment;
    if (!a) continue;
    if (a.type === 'prompt_snapshot') {
      // 会话里可能出现多个快照：取最后一个带工具清单的（最新、最能反映当前上下文）
      if (!snap || (Array.isArray(a.tools) && a.tools.length > 0)) snap = a;
    } else if (a.type === 'skill_listing') {
      skillChars += (a.content ?? '').length;
    } else if (a.type === 'instructions') {
      memChars += JSON.stringify(a.files ?? '').length;
    }
  }
  if (!snap) return null;

  const tools = Array.isArray(snap.tools) ? snap.tools : [];
  const builtin = [];
  const mcp = [];
  for (const t of tools) (String(t?.name ?? '').startsWith('mcp__') ? mcp : builtin).push(t);

  return {
    system: estTokens(snap.systemPrompt) + estTokens(snap.cliPrefix),
    tools: estTokens(builtin),
    mcp: estTokens(mcp),
    skills: tokensForChars(skillChars),
    memory: tokensForChars(memChars),
  };
}

function fixedFor(transcript) {
  if (!transcript) return null;
  const hit = cached(transcript);
  if (hit) return hit;
  const fixed = parseFixed(transcript);
  if (!fixed) return null;
  try {
    const st = statSync(transcript);
    writeFileSync(cachePath(transcript), JSON.stringify({ file: transcript, size: st.size, mtime: st.mtimeMs, fixed }));
  } catch {
    // 缓存写失败不影响渲染
  }
  return fixed;
}

// 上一次的有效 used。Claude Code 在新 assistant 消息到达时会立刻重跑，
// 那一刻上下文数据可能整体缺失（tokens 与百分比都是 0）。这种情况沿用上一次的
// 值，观感上就是"数字不动"，比画空或画一个偏小的假数都好。
// 单独的缓存文件：used 变化频繁，不能和固定开销共用（后者按 transcript mtime 失效）。
const lastUsedPath = (transcript) => join(CACHE_DIR, 'cc-context-bar-last-' + hash(transcript) + '.json');

function readLastUsed(transcript) {
  try {
    const v = JSON.parse(readFileSync(lastUsedPath(transcript), 'utf8')).used;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeLastUsed(transcript, used) {
  try {
    writeFileSync(lastUsedPath(transcript), JSON.stringify({ used: Math.round(used), at: Date.now() }));
  } catch {
    // 写失败不影响渲染
  }
}

function render(d) {
  const cols = Math.max(MIN_COLS, parseInt(process.env.COLUMNS, 10) || 80);
  const barWidth = Math.max(MIN_BAR, cols - WIDTH_MARGIN);

  const model = d?.model?.display_name ?? 'Claude';
  const cw = d?.context_window ?? {};
  const size = cw.context_window_size || 200000;

  const fixedRaw = fixedFor(d?.transcript_path);
  const fixedFloor = fixedRaw
    ? ORDER.filter((k) => k !== 'convo').reduce((s, k) => s + (fixedRaw[k] ?? 0), 0)
    : 0;

  // 已用 token 的来源，依次回退：
  //   1. total_input_tokens —— 权威值
  //   2. used_percentage 反推 —— 新 assistant 消息刚到时会立刻重跑一次
  //      statusline，那一刻 tokens 还是 0 但百分比已更新；直接用 0 会把条画空、
  //      下一秒又填回来（观感是"闪一下"）
  // 注意这里**不能**再回退到固定开销：固定开销（系统提示词+工具定义，约 180k）
  // 只是上下文的一部分，拿它冒充总量会让读数凭空缩水一半——实测出现过
  // 373k 突然掉到 180k 又跳回来的现象。数据不可信时宁可显示上一次的量级，
  // 也不要给一个看起来像真数的错误值。
  let used = Number.isFinite(cw.total_input_tokens) ? Math.max(0, cw.total_input_tokens) : 0;
  if (used <= 0 && Number.isFinite(cw.used_percentage) && cw.used_percentage > 0) {
    used = (cw.used_percentage / 100) * size;
  }
  // 两个来源都给不出可信值时（新消息触发的重跑），沿用上一次的值，
  // 避免读数骤降。只在真的拿到数据后才回写，防止把兜底值固化成"上次的值"。
  const transcript = d?.transcript_path;
  const hadRealData = used > 0;
  if (!hadRealData && transcript) {
    const last = readLastUsed(transcript);
    if (last !== null) used = Math.min(last, size);
  } else if (hadRealData && transcript) {
    writeLastUsed(transcript, used);
  }
  used = Math.min(used, size);

  // 百分比一律由 used 推出，保证读数、色块边界、压力配色三者永远一致
  const pct = Math.max(0, Math.min(100, (used / size) * 100));
  const free = Math.max(0, size - used);

  // 临时诊断：仅当脚本目录下存在 diag.on 这个哨兵文件时才记录。
  // 用文件而不是环境变量，避免为了调试去改 settings.json。
  if (existsSync(DIAG_ON)) {
    try {
      appendFileSync(
        DIAG_LOG,
        JSON.stringify({
          t: new Date().toISOString(),
          sid: String(d?.session_id ?? '').slice(0, 8),
          cwd: d?.cwd ?? '',
          rawT: cw.total_input_tokens,
          rawPct: cw.used_percentage,
          size: cw.context_window_size,
          cu: cw.current_usage
            ? {
                i: cw.current_usage.input_tokens || 0,
                r: cw.current_usage.cache_read_input_tokens || 0,
                w: cw.current_usage.cache_creation_input_tokens || 0,
              }
            : null,
          fixedFloor: Math.round(fixedFloor),
          hadRealData,
          outUsed: Math.round(used),
          pct: +pct.toFixed(2),
        }) + '\n'
      );
    } catch {
      // 诊断失败不能影响状态栏
    }
  }

  // 固定开销按段读取；对话内容用「总量 − 固定」反推，这样总量恒准，
  // /compact 之后也会自动收缩。固定开销超过总量时按比例压缩（刚 /compact 完
  // 新的总量还没报上来时会出现）。
  let values;
  let colors;
  let entries = null;
  if (fixedRaw) {
    const fixed = { ...fixedRaw };
    const fixedSum = ORDER.filter((k) => k !== 'convo').reduce((s, k) => s + (fixed[k] ?? 0), 0);
    if (fixedSum > 0 && fixedSum > used) {
      const k = used > 0 ? used / fixedSum : 1;
      for (const key of ORDER) {
        if (key !== 'convo') fixed[key] = (fixed[key] ?? 0) * k;
      }
    }
    const scaledSum = ORDER.filter((k) => k !== 'convo').reduce((s, k) => s + (fixed[k] ?? 0), 0);
    const all = { ...fixed, convo: Math.max(0, used - scaledSum), free };
    values = ORDER.map((k) => all[k] ?? 0);
    colors = ORDER.map((k) => SEGMENTS[k]);
    entries = [...ORDER, 'free'].map((k) => ({
      key: k,
      label: LABELS[k],
      color: SEGMENTS[k] ?? FREE_CHIP,
      tokens: all[k] ?? 0,
    }));
  } else {
    // 读不到 transcript（首轮、超大文件、路径不可用）：整块单色
    values = [used];
    colors = [SEGMENTS.convo];
  }

  // 「已用 / 自由」边界由 used 精确决定，保证色块与读数严格一致。
  // 已用区内部再分列：每段保底 1 列，剩余按比例——否则占比 <1% 的段
  // （技能、记忆常见如此）会被取整吃成 0 列，在条上整段消失。
  const usedCols = Math.max(0, Math.min(barWidth, Math.round((used / size) * barWidth)));
  const allocUsed = allocateWithFloor(values, usedCols);
  const freeWidth = barWidth - usedCols;
  const usedCells = useColor
    ? values.map((_, i) => (allocUsed[i] > 0 ? bg(colors[i], ' '.repeat(allocUsed[i])) : '')).join('')
    : '█'.repeat(usedCols);

  const pctText = pct.toFixed(1) + '%';
  const readoutColor = pct >= DANGER_AT ? DANGER_TEXT : pct >= WARN_AT ? WARN_TEXT : FREE_TEXT;
  const freeCell =
    freeWidth > 0
      ? bg(
          FREE_FILL,
          fg(readoutColor, rightAlign([`${fmtTokens(used)}/${fmtTokens(size)} ${pctText}`, pctText], freeWidth))
        )
      : '';

  const lines = [usedCells + freeCell];

  // 第二行：左 模型·缓存·目录，右 ctx。
  // 缓存只在网关真的上报时才显示——caching_observed=false 表示「不上报」，
  // 此时 hit_ratio 恒为 0，显示出来会把「没数据」误报成「命中率 0」。
  const cu = cw.current_usage;
  const pc = d?.prompt_cache;
  const cacheReported = pc
    ? pc.caching_observed === true
    : cu && typeof cu === 'object' && (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0) > 0;
  let cacheText = null;
  if (cacheReported) {
    if (typeof pc?.hit_ratio === 'number') cacheText = (pc.hit_ratio * 100).toFixed(1) + '%';
    else if (cu) {
      const total =
        (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.input_tokens || 0);
      if (total > 0) cacheText = (((cu.cache_read_input_tokens || 0) / total) * 100).toFixed(1) + '%';
    }
  }

  const dir = (d?.workspace?.current_dir || d?.cwd || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop();
  const segs = [model];
  if (cacheText !== null) segs.push(`${LABELS.cache} ${cacheText}`);
  if (dir) segs.push(dir);

  const right2 = `ctx ${pct.toFixed(0)}% (${fmtTokens(used)}/${fmtTokens(size)})`;
  const room = barWidth - width(right2) - 1;
  let left2 = segs.join(' · ');
  // 放不下就先丢目录，再不行才截断模型名
  if (width(left2) > room && segs.length > 2) left2 = [segs[0], segs[segs.length - 1]].join(' · ');
  left2 = truncate(left2, room);

  const gap = barWidth - width(left2) - width(right2);
  if (gap >= 1) lines.push(left2 + ' '.repeat(gap) + right2);
  else if (left2) lines.push(left2);

  // 第三行：分段明细。放不下时 renderBreakdown 返回空串，此时不要 push 空行。
  if (!BREAKDOWN_OFF && entries) {
    const breakdown = renderBreakdown(entries, barWidth);
    if (breakdown) lines.push(breakdown);
  }

  return lines.join('\n');
}

// 手动在终端直接运行时（stdin 是 TTY）用示例数据预览，避免阻塞等输入
const PREVIEW =
  '{"model":{"display_name":"deepseek-v4.1-flash"},"cwd":"/home/me/project",' +
  '"workspace":{"current_dir":"/home/me/project"},' +
  '"context_window":{"used_percentage":31.3,"context_window_size":262000,' +
  '"total_input_tokens":82000,"current_usage":{"input_tokens":300,' +
  '"cache_creation_input_tokens":1200,"cache_read_input_tokens":76500}}}';

let raw = '';
try {
  raw = process.stdin.isTTY ? PREVIEW : readFileSync(0, 'utf8');
} catch {
  raw = PREVIEW;
}
if (!raw.trim()) raw = PREVIEW;

try {
  process.stdout.write(render(JSON.parse(raw)) + '\n');
} catch {
  // 任何异常都不能让状态栏变成一堆报错，退化成一行提示
  process.stdout.write(dim('context: —') + '\n');
}
