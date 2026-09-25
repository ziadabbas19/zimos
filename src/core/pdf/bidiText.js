'use strict';

const path = require('path');
const bidi = require('bidi-js')();

/**
 * Mixed Arabic / Latin text for pdfkit documents.
 *
 * pdfkit's standard fonts (Helvetica, ...) are WinAnsi only: Arabic comes out
 * as mojibake. pdfkit does shape Arabic through fontkit once an embedded
 * font with Arabic glyphs is used, but it has no bidi: fontkit reverses a
 * whole string when its first strong character is Arabic, so the English and
 * digits inside an Arabic address print backwards (and the other way round).
 *
 * drawText() therefore does the Unicode bidi algorithm itself (bidi-js):
 * each line is cut into runs of one direction and one font, the runs are put
 * in visual order, and every run is handed to pdfkit so that fontkit's own
 * shaping (joining forms, ligatures) still applies inside it. Arabic runs use
 * Noto Sans Arabic, everything else stays in Helvetica — Noto Sans Arabic
 * carries no Latin letters.
 *
 * The fonts live in the repo and are resolved from this file, so they ship in
 * the Docker image whatever the working directory is.
 */

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_FILES = {
  'Arabic': path.join(FONT_DIR, 'NotoSansArabic-Regular.ttf'),
  'Arabic-Bold': path.join(FONT_DIR, 'NotoSansArabic-Bold.ttf'),
};
const FONTS = {
  regular: { latin: 'Helvetica', arabic: 'Arabic' },
  bold: { latin: 'Helvetica-Bold', arabic: 'Arabic-Bold' },
};

// Arabic, Arabic Supplement, Extended-B/A, Presentation Forms A/B, plus the
// zero-width (non-)joiners that sit between Arabic letters.
const ARABIC_RE = /[؀-ۿݐ-ݿࡰ-ࣿﭐ-﷿ﹰ-﻿‌‍]/;
const ARABIC_ANY_RE = /[؀-ۿݐ-ݿࡰ-ࣿﭐ-﷿ﹰ-﻿]/;
// Bidi controls steer the levels but have no glyph in either font.
const BIDI_CONTROL_RE = /[‎‏‪-‮⁦-⁩]/;

/** Registers the embedded fonts on a document; call once per document. */
function registerFonts(doc) {
  for (const [name, file] of Object.entries(FONT_FILES)) doc.registerFont(name, file);
}

const hasArabic = (text) => ARABIC_ANY_RE.test(String(text || ''));

const reverseChars = (s) => Array.from(s).reverse().join('');

// The direction fontkit will lay a string out in. Standard (AFM) fonts have no
// layout engine and always run left to right.
function naturalDirection(doc, text) {
  const engine = doc._font && doc._font.font;
  if (!engine || typeof engine.layout !== 'function') return 'ltr';
  return engine.layout(text).direction === 'rtl' ? 'rtl' : 'ltr';
}

// Splits text[start, end) into runs of one bidi level and one font, in
// logical order. Bidi control characters are dropped here.
function logicalRuns(text, levels, start, end) {
  const runs = [];
  let cur = null;
  for (let i = start; i < end; i++) {
    const ch = text[i];
    if (BIDI_CONTROL_RE.test(ch)) continue;
    const arabic = ARABIC_RE.test(ch);
    const level = levels[i];
    if (cur && cur.level === level && cur.arabic === arabic) {
      cur.text += ch;
    } else {
      cur = { text: ch, level, arabic, start: i };
      runs.push(cur);
    }
  }
  return runs;
}

// UAX #9 rule L2 at run granularity: from the highest level down to the
// lowest odd one, reverse every stretch of runs at that level or above.
function visualOrder(runs) {
  if (!runs.length) return runs;
  const out = runs.slice();
  const max = Math.max(...out.map((r) => r.level));
  const minOdd = Math.min(...out.map((r) => (r.level % 2 ? r.level : r.level + 1)));
  for (let lvl = max; lvl >= minOdd; lvl--) {
    let i = 0;
    while (i < out.length) {
      if (out[i].level < lvl) { i++; continue; }
      let j = i;
      while (j < out.length && out[j].level >= lvl) j++;
      const reversed = out.slice(i, j).reverse();
      out.splice(i, j - i, ...reversed);
      i = j;
    }
  }
  return out;
}

function fontFor(run, weight) {
  return run.arabic ? FONTS[weight].arabic : FONTS[weight].latin;
}

function runWidth(doc, run, weight, size) {
  return doc.font(fontFor(run, weight)).fontSize(size).widthOfString(run.text);
}

// The string to give pdfkit so the run comes out in its visual direction:
// right-to-left runs get their brackets mirrored, and any run fontkit would
// lay out the other way (Latin punctuation inside Arabic, Arabic-Indic digits)
// is pre-reversed.
function glyphString(doc, run, weight) {
  const want = run.level % 2 ? 'rtl' : 'ltr';
  let s = run.text;
  if (want === 'rtl') s = Array.from(s).map((c) => bidi.getMirroredCharacter(c) || c).join('');
  doc.font(fontFor(run, weight));
  return naturalDirection(doc, s) === want ? s : reverseChars(s);
}

// Greedy word wrap in logical order; returns [start, end) ranges per line.
// A word wider than the whole line is cut by characters.
function wrapLines(doc, text, levels, from, to, width, weight, size) {
  const widthOf = (a, b) => logicalRuns(text, levels, a, b).reduce((w, r) => w + runWidth(doc, r, weight, size), 0);
  const lines = [];
  const words = [];
  const re = /\S+\s*|\s+/g;
  const slice = text.slice(from, to);
  let m;
  while ((m = re.exec(slice))) words.push([from + m.index, from + m.index + m[0].length]);

  let lineStart = from;
  let lineEnd = from;
  for (const [ws, we] of words) {
    const trimmedEnd = ws + text.slice(ws, we).trimEnd().length;
    if (lineEnd > lineStart && widthOf(lineStart, trimmedEnd) <= width) {
      lineEnd = we;
      continue;
    }
    if (lineEnd > lineStart) lines.push([lineStart, lineEnd]);
    // The word opens a new line; cut it by characters while it overflows.
    lineStart = ws;
    for (let i = ws + 1; i <= trimmedEnd; i++) {
      if (i - 1 > lineStart && widthOf(lineStart, i) > width) {
        lines.push([lineStart, i - 1]);
        lineStart = i - 1;
      }
    }
    lineEnd = we;
  }
  if (lineEnd > lineStart) lines.push([lineStart, lineEnd]);
  return lines.map(([a, b]) => [a, a + text.slice(a, b).trimEnd().length]).filter(([a, b]) => b > a);
}

/**
 * Draws `text` in the box starting at (x, y), `width` wide, wrapping as
 * needed. Paragraphs split on \n; each takes its direction from its first
 * strong character (or `direction`, e.g. 'ltr' for phone numbers, whose
 * digit groups would otherwise swap places in an Arabic context) and is
 * aligned to its start (left for English, right for Arabic) unless `align`
 * says otherwise. Returns the y below the last line and leaves doc.y there.
 *
 * Options: x, y, width, size (pt), bold, color, align ('start'|'left'|'right'),
 * direction ('ltr'|'rtl'; default: per paragraph).
 */
function drawText(doc, text, opts = {}) {
  const x = opts.x != null ? opts.x : doc.page.margins.left;
  const width = opts.width != null ? opts.width : doc.page.width - doc.page.margins.right - x;
  const size = opts.size || 10;
  const weight = opts.bold ? 'bold' : 'regular';
  const align = opts.align || 'start';
  let y = opts.y != null ? opts.y : doc.y;

  if (opts.color) doc.fillColor(opts.color);
  const str = String(text == null ? '' : text).replace(/\r\n?/g, '\n');

  for (const para of str.split('\n')) {
    const lineHeight = size * (hasArabic(para) ? 1.6 : 1.25);
    if (!para.trim()) { y += lineHeight; continue; }
    const { levels, paragraphs } = bidi.getEmbeddingLevels(para, opts.direction);
    const rtl = paragraphs.length > 0 && paragraphs[0].level % 2 === 1;

    for (const [a, b] of wrapLines(doc, para, levels, 0, para.length, width, weight, size)) {
      const runs = visualOrder(logicalRuns(para, levels, a, b));
      const widths = runs.map((r) => runWidth(doc, r, weight, size));
      const lineWidth = widths.reduce((s, w) => s + w, 0);
      const right = align === 'right' || (align === 'start' && rtl);
      let cx = right ? x + width - lineWidth : x;
      // Baseline sits the Latin ascent below the line top so an English line
      // lands where pdfkit's own text() would have put it.
      const baseline = y + size * 0.718 + (lineHeight - size * 1.25) / 2;
      runs.forEach((run, i) => {
        const s = glyphString(doc, run, weight);
        doc.fontSize(size).text(s, cx, baseline, { lineBreak: false, baseline: 'alphabetic' });
        cx += widths[i];
      });
      y += lineHeight;
    }
  }

  doc.x = doc.page.margins.left;
  doc.y = y;
  return y;
}

module.exports = { registerFonts, drawText, hasArabic, FONT_FILES };
