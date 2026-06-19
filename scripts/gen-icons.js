const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { SVGIcons2SVGFontStream } = require('svgicons2svgfont');
const svg2ttf = require('svg2ttf');
const ttf2woff = require('ttf2woff');

const SIZE = 1000;
const C = SIZE / 2;
const RAYS = 12;
const R_INNER = 0;
const R_OUTER = 430;
const W_BASE = 84;
const W_TIP = 14;
const CODEPOINT = 0xe000;

function ray(angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const px = -sa;
  const py = ca;
  const bx = C + ca * R_INNER;
  const by = C + sa * R_INNER;
  const tx = C + ca * R_OUTER;
  const ty = C + sa * R_OUTER;
  const hb = W_BASE / 2;
  const ht = W_TIP / 2;
  const pts = [
    [bx + px * hb, by + py * hb],
    [tx + px * ht, ty + py * ht],
    [tx - px * ht, ty - py * ht],
    [bx - px * hb, by - py * hb],
  ];
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L') + ' Z';
}

let d = '';
for (let i = 0; i < RAYS; i++) {
  d += ray((360 / RAYS) * i) + ' ';
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><path d="${d.trim()}"/></svg>`;

const iconsDir = path.join(__dirname, '..', 'media', 'icons');
const outDir = path.join(__dirname, '..', 'media');
fs.mkdirSync(iconsDir, { recursive: true });
fs.writeFileSync(path.join(iconsDir, 'claude.svg'), svg);

const fontStream = new SVGIcons2SVGFontStream({
  fontName: 'ccut',
  fontHeight: 1000,
  descent: 150,
  normalize: true,
  centerHorizontally: true,
  log: () => {},
});

let svgFont = '';
fontStream.on('data', (chunk) => {
  svgFont += chunk;
});
fontStream.on('end', () => {
  const ttf = svg2ttf(svgFont, {});
  const woff = ttf2woff(Buffer.from(ttf.buffer));
  fs.writeFileSync(path.join(outDir, 'ccut.woff'), Buffer.from(woff.buffer));
  console.log('wrote media/ccut.woff  (glyph U+' + CODEPOINT.toString(16).toUpperCase() + ')');
});

const glyph = new Readable();
glyph.push(svg);
glyph.push(null);
glyph.metadata = { unicode: [String.fromCodePoint(CODEPOINT)], name: 'claude' };
fontStream.write(glyph);
fontStream.end();
