// 从脚本的真实输出生成 README 用的 SVG，保证图与实现永不脱节
const { execFileSync } = require('child_process');
const fs = require('fs');
const NODE = process.execPath;

const MJS = process.argv[2];
const TRANSCRIPT = process.argv[3];
const OUT = process.argv[4];

// 演示用数据：固定开销（约 182k）加上一段对话。
// 总量取 ~262k/1M —— 留出明显的自由段，同时各段都分得到列，
// 这样色带的"分段"结构和右侧留白都能一眼看清。
const CW = { used: 262000, size: 1000000 };
const COLS = 100;
const MARGIN = 4;
const BAR_W = COLS - MARGIN;

const json = JSON.stringify({
  session_id: 'demo',
  transcript_path: TRANSCRIPT,
  model: { display_name: 'Sonnet 5' },
  workspace: { current_dir: '/home/me/project' },
  context_window: {
    used_percentage: (CW.used / CW.size) * 100,
    context_window_size: CW.size,
    total_input_tokens: CW.used,
  },
});

const run = (extraEnv) =>
  execFileSync(NODE, [MJS, '--margin', String(MARGIN)], {
    input: json,
    encoding: 'utf8',
    env: { ...process.env, COLUMNS: String(COLS), ...extraEnv },
  }).replace(/\n$/, '');

const plain = run({ NO_COLOR: '' }).split('\n');
const colored = run({}).split('\n');

// --- 解析一行带色文本，切成 [{bg, text}] ---
function parseSegs(line) {
  const ESC = /\x1b\[([0-9;]*)m/g;
  const segs = [];
  let bg = null;
  let last = 0;
  let m;
  while ((m = ESC.exec(line))) {
    const text = line.slice(last, m.index);
    if (text) segs.push({ bg, text });
    const p = m[1];
    if (p.startsWith('48;2;')) bg = p.slice(5).split(';').map(Number);
    else if (p === '49') bg = null;
    last = ESC.lastIndex;
  }
  const tail = line.slice(last);
  if (tail) segs.push({ bg, text: tail });
  return segs;
}

const barSegs = parseSegs(colored[0]);
// 第三行：chip（有色块的空格）+ 标签
const legendSegs = parseSegs(colored[2] || '');

// --- 画 SVG ---
const FONT = 13;
const CHAR_W = FONT * 0.602;
const PAD = 16;
const ROW_H = 20;
const width = Math.round(BAR_W * CHAR_W + PAD * 2);
const height = Math.round(PAD * 2 + ROW_H + FONT * 2.6);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rgbCss = (rgb) => `rgb(${rgb.join(',')})`;

// 终端列数：CJK 与全角标点占 2 列，其余 1 列。
// SVG 定位要按列算，不能按 JS 字符数——否则中文标签会算窄、chip 叠到文字上。
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;
const cols = (s) => {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
};

// 色带
let x = PAD;
let barRects = '';
let readoutX = null;
for (const s of barSegs) {
  const w = s.text.length * CHAR_W;
  if (s.bg) {
    barRects += `  <rect x="${x.toFixed(1)}" y="${PAD}" width="${w.toFixed(1)}" height="${ROW_H}" fill="${rgbCss(s.bg)}"/>\n`;
    // 自由段（底色 46,52,64）上要压读数
    if (s.bg.join(',') === '46,52,64') readoutX = { start: x, width: w };
  }
  x += w;
}

// 自由段右侧的读数，从纯文本第一行提取
const readout = (/([\d.]+k\/[\d.]+M\s+[\d.]+%)/.exec(plain[0]) || [])[1] || '';
const readoutEl = readoutX
  ? `  <text x="${(readoutX.start + readoutX.width - readout.length * CHAR_W - 2).toFixed(1)}" y="${PAD + ROW_H * 0.72}" fill="#8d95a6" xml:space="preserve">${esc(readout)}</text>\n`
  : '';

// 第三行：chip 画成真正的色块，标签照排。
// 每个 chip 单独画一个 rect（不依赖文本里的空格），避免空格被折叠导致贴合。
let legendEls = '';
let lx = PAD;
const CHIP_W = CHAR_W;
const legendY = PAD + ROW_H + FONT * 2.85;
for (const s of legendSegs) {
  if (s.bg) {
    // chip：色块 + 1 列间隙
    legendEls += `  <rect x="${lx.toFixed(1)}" y="${(legendY - FONT * 0.85).toFixed(1)}" width="${CHIP_W.toFixed(1)}" height="${FONT}" fill="${rgbCss(s.bg)}"/>\n`;
    lx += CHIP_W * 2; // 色块 1 列 + 间隙 1 列
  } else {
    const t = s.text.replace(/^\s+/, '');
    if (t) {
      legendEls += `  <text x="${lx.toFixed(1)}" y="${legendY.toFixed(1)}" class="fg2" xml:space="preserve">${esc(t)}</text>\n`;
    }
    lx += cols(s.text) * CHAR_W;
  }
}

const line2 = plain[1];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace" font-size="${FONT}">
  <style>
    /* GitHub 按主题切换：浅色用近白底，深色用近黑底 */
    .bg { fill: #ffffff; }
    .fg { fill: #1f2328; }
    .fg2 { fill: #59636e; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #2e3440; }
      .fg { fill: #d8dee9; }
      .fg2 { fill: #a8b2c4; }
    }
  </style>
  <rect width="100%" height="100%" class="bg"/>
${barRects}${readoutEl}  <text x="${PAD}" y="${PAD + ROW_H + FONT * 1.5}" class="fg" xml:space="preserve">${esc(line2)}</text>
${legendEls}</svg>
`;

fs.writeFileSync(OUT, svg);
console.log('已生成 ' + OUT);
console.log('  画布 ' + width + 'x' + height);
console.log('  色带 ' + barSegs.reduce((n, s) => n + s.text.length, 0) + ' 列');
console.log('  色段: ' + barSegs.filter((s) => s.bg).map((s) => s.bg.join(',') + '×' + s.text.length).join('  '));
console.log('  读数: ' + (readout || '(未提取到)'));
console.log('  图例 chip 数: ' + legendSegs.filter((s) => s.bg).length);
console.log('  第二行: ' + line2.trim());
console.log('  第三行: ' + (plain[2] || '').trim());
