// 从脚本的真实输出生成 README 用的 SVG，保证图与实现永不脱节
const { execFileSync } = require('child_process');
const fs = require('fs');
const NODE = process.execPath;

const MJS = process.argv[2];
const TRANSCRIPT = process.argv[3];
const OUT = process.argv[4];

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
const legendSegs = parseSegs(colored[2] || '');

const FONT = 13;
const CHAR_W = FONT * 0.602;
const PAD = 16;
const ROW_H = 20;
const width = Math.round(BAR_W * CHAR_W + PAD * 2);
const height = Math.round(PAD * 2 + ROW_H + FONT * 2.6);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 一律用 #rrggbb：GitHub 的 SVG 清洗对 rgb() 也支持，但 hex 最保险
const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

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
let cursor = 0;
for (const s of barSegs) {
  // 注意：按「显示列数」推进坐标，不能按 JS 字符数（色带里都是半角空格，两者一致，
  // 但保留 cols() 以便将来色带含非 ASCII 时仍然正确）
  const w = cols(s.text) * CHAR_W;
  if (s.bg) {
    barRects += `  <rect x="${x.toFixed(1)}" y="${PAD}" width="${w.toFixed(1)}" height="${ROW_H}" fill="${hex(s.bg)}"/>\n`;
    if (s.bg.join(',') === '46,52,64') readoutX = { start: x, width: w };
  }
  x += w;
  cursor += cols(s.text);
}

const readout = (/([\d.]+k\/[\d.]+M\s+[\d.]+%)/.exec(plain[0]) || [])[1] || '';
const readoutEl = readoutX
  ? `  <text x="${(readoutX.start + readoutX.width - readout.length * CHAR_W - 2).toFixed(1)}" y="${PAD + ROW_H * 0.72}" fill="#8d95a6" xml:space="preserve">${esc(readout)}</text>\n`
  : '';

// 第三行：chip 画成真正的色块，标签照排
let legendEls = '';
let lx = PAD;
const CHIP_W = CHAR_W;
const legendY = PAD + ROW_H + FONT * 2.85;
for (const s of legendSegs) {
  if (s.bg) {
    legendEls += `  <rect x="${lx.toFixed(1)}" y="${(legendY - FONT * 0.85).toFixed(1)}" width="${CHIP_W.toFixed(1)}" height="${FONT}" fill="${hex(s.bg)}"/>\n`;
    lx += CHIP_W * 2;
  } else {
    const t = s.text.replace(/^\s+/, '');
    if (t) {
      legendEls += `  <text x="${lx.toFixed(1)}" y="${legendY.toFixed(1)}" fill="#6e7781" xml:space="preserve">${esc(t)}</text>\n`;
    }
    lx += cols(s.text) * CHAR_W;
  }
}

const line2 = plain[1];

// GitHub 会剥掉 README 里 SVG 的 <style> 块，class 与媒体查询都不生效
// （曾因此让整条色带渲染成黑色）。所以全部用内联属性，且不画整块背景——
// 透明底在浅色和深色主题下都成立。文字取中灰 #6e7781，两种主题上都够清晰。
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT}">
${barRects}${readoutEl}  <text x="${PAD}" y="${PAD + ROW_H + FONT * 1.5}" fill="#6e7781" xml:space="preserve">${esc(line2)}</text>
${legendEls}</svg>
`;

fs.writeFileSync(OUT, svg);
console.log('已生成 ' + OUT);
console.log('  画布 ' + width + 'x' + height);
console.log('  色带 ' + BAR_W + ' 列');
console.log('  色段: ' + barSegs.filter((s) => s.bg).map((s) => hex(s.bg) + '×' + cols(s.text)).join('  '));
console.log('  读数: ' + (readout || '(未提取到)'));
console.log('  图例 chip 数: ' + legendSegs.filter((s) => s.bg).length);
console.log('  含 <style>: ' + /<style/.test(svg) + ' (须为 false)');
console.log('  含 class=: ' + /class=/.test(svg) + ' (须为 false)');
console.log('  第二行: ' + line2.trim());
