// parse.js — a dependency-free Markdown renderer whose parse(markdown)
// returns exactly the HTML that marked 18.1.3 renders with default options
// (gfm: true, breaks: false, pedantic: false).
//
// Written from the CommonMark 0.31.2 and GFM 0.29 specifications, with
// marked's observable departures from the specs reproduced faithfully.
// Structure: a block-level tokenizer, an inline tokenizer with a
// CommonMark-style delimiter pass for emphasis, and a renderer.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Escape a string for use inside a double-quoted HTML attribute.
function escapeAttr(s) {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Escape plain text content the way marked does: &, < and > are escaped,
// except that an & which already introduces an entity reference (named or
// numeric) is left alone. Numeric character references are decoded by the
// inline layer before this is called, so in practice only named references
// survive to be preserved here.
function escapeText(s) {
  return s.replace(/&(?!(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)|[< >]/g,
    (c) => ESCAPES[c]);
}

// The HTML5 numeric-character-reference replacement table for C1 controls.
const C1_REMAP = {
  0x80: 0x20AC, 0x81: 0x0081, 0x82: 0x201A, 0x83: 0x0192,
  0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039,
  0x8C: 0x0152, 0x8D: 0x008D, 0x8E: 0x017D, 0x8F: 0x008F,
  0x90: 0x0090, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C,
  0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A,
  0x9C: 0x0153, 0x9D: 0x009D, 0x9E: 0x017E, 0x9F: 0x0178,
};

// Decode one numeric character reference body (the part between &# and ;).
function decodeNumericRef(body) {
  let cp;
  if (body[0] === 'x' || body[0] === 'X') cp = parseInt(body.slice(1), 16);
  else cp = parseInt(body, 10);
  // A value above the Unicode range is not a reference at all in
  // marked's output: the source text stays literal.
  if (!isFinite(cp) || cp > 0x10FFFF) return null;
  if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF)) {
    return '�';
  }
  if (cp >= 0x80 && cp <= 0x9F && C1_REMAP[cp] !== undefined) cp = C1_REMAP[cp];
  return String.fromCodePoint(cp);
}

const NUMERIC_REF_RE = /&#(\d+);|&#[xX]([0-9a-fA-F]+);/g;

// Decode numeric character references in a text run (marked decodes these
// in text but leaves named references untouched).
function decodeNumericRefs(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(NUMERIC_REF_RE, (m, dec, hex) => {
    const decoded = decodeNumericRef(hex !== undefined ? 'x' + hex : dec);
    return decoded === null ? m : decoded;
  });
}

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function isAsciiPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.indexOf(ch) !== -1;
}

// Unescape backslash escapes of ASCII punctuation (used in link labels,
// destinations and titles).
function unescapeBackslashes(s) {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

// Normalise a link label for definition lookup: collapse internal
// whitespace to single spaces, trim, and fold case.
function normaliseLabel(s) {
  // Whitespace is collapsed, and matching uses Unicode case folding
  // (not backslash unescaping: labels compare raw).
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st')
    .replace(/ς/g, 'σ');
}

// ---------------------------------------------------------------------------
// Block-level tokenization
// ---------------------------------------------------------------------------

// Token shapes:
//   { type: 'heading', depth, text }
//   { type: 'paragraph', text }
//   { type: 'code', lang, text }        text = raw code, no trailing \n added
//   { type: 'html', text }
//   { type: 'blockquote', tokens }
//   { type: 'list', ordered, start, loose, items: [{ tokens, task, checked }] }
//   { type: 'table', header, align, rows }
//   { type: 'hr' }
// Link reference definitions are collected into `defs` (a Map) and produce
// no token.

// Return the index just past the end of the line starting at i (the index
// of the '\n', or src.length).
function lineEnd(src, i) {
  const j = src.indexOf('\n', i);
  return j === -1 ? src.length : j;
}

// Count the column width of the leading indentation of a line, expanding
// tabs to the next multiple of 4. Returns [columns, charsConsumedToReach4]
// where the second value is the number of characters needed to reach at
// least `cols` columns (used when stripping indentation).
function indentInfo(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col += 1; i += 1; }
    else if (ch === '\t') { col += 4 - (col % 4); i += 1; }
    else break;
  }
  return { cols: col, chars: i };
}

// Expand the leading whitespace of a string to spaces, measuring tab
// widths at absolute columns starting from `startCol`. Interior tabs
// are left untouched.
function expandLeadingWs(str, startCol) {
  let col = startCol;
  let out = '';
  let i = 0;
  while (i < str.length && (str[i] === ' ' || str[i] === '\t')) {
    if (str[i] === ' ') { out += ' '; col += 1; i += 1; }
    else {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i += 1;
    }
  }
  return out + str.slice(i);
}

// Strip up to `cols` columns of indentation from the start of a line,
// where the line's first character sits at absolute column `startCol`.
// A partially consumed tab leaves its remaining columns as spaces. When
// `expand` is set, tabs in the remaining leading whitespace are also
// expanded to spaces at their original widths (container content is
// rebased; fenced code content is not).
function stripIndent(line, cols, startCol = 0, expand = false) {
  let col = startCol;
  const target = startCol + cols;
  let i = 0;
  let out = '';
  while (i < line.length && col < target) {
    const ch = line[i];
    if (ch === ' ') { col += 1; i += 1; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w > target) {
        out += ' '.repeat(col + w - target);
        col += w;
        i += 1;
      } else { col += w; i += 1; }
    } else break;
  }
  if (expand) return out + expandLeadingWs(line.slice(i), col);
  return out + line.slice(i);
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// --- individual block starts ----------------------------------------------

// Fenced code start: up to 3 spaces, then 3+ backticks or tildes.
// Returns { ch, length, indent, info } or null. For backtick fences the
// info string may not contain a backtick.
function fenceStart(line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const fence = m[2];
  const info = m[3];
  if (fence[0] === '`' && info.indexOf('`') !== -1) return null;
  return { ch: fence[0], length: fence.length, indent: m[1].length, info };
}

// ATX heading: up to 3 spaces, 1-6 '#', then a space/tab or end of line.
// Returns { depth, text } with the optional closing sequence removed.
function atxHeading(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!m) return null;
  let text = m[2] === undefined ? '' : m[2];
  text = text.replace(/[ \t]+$/, '');
  // Closing sequence of '#'s: preceded by a space, or the whole content.
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '');
  return { depth: m[1].length, text };
}

function isHrLine(line) {
  return /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(line);
}

const BLOCK_TAGS = new Set((
  'address article aside base basefont blockquote body caption center col ' +
  'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
  'footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html ' +
  'iframe legend li link main menu menuitem nav noframes ol optgroup ' +
  'option p param search section summary table tbody td tfoot th thead ' +
  'title tr track ul'
).split(' '));

// Determine whether an HTML block starts at the beginning of `src`
// (after up to three spaces of indentation). Returns { endTag } where
// endTag is the string that terminates the block (a blank line ends it
// when endTag is null), or null when no HTML block starts here.
// `paragraphOpen` suppresses type-7 blocks.
function htmlBlockStart(src0, paragraphOpen) {
  let off = 0;
  while (off < 3 && src0[off] === ' ') off += 1;
  const src = src0.slice(off);
  if (src[0] !== '<') return null;
  const rest = src.slice(0, 200);
  let m;
  // Type 1: pre / script / style / textarea, ends at the closing tag.
  if ((m = /^<(pre|script|style|textarea)(?:\s|>|$)/i.exec(rest))) {
    return { endTag: '</' + m[1].toLowerCase() };
  }
  // Type 2: comment.
  if (rest.startsWith('<!--')) return { endTag: '-->' };
  // Type 3: processing instruction.
  if (rest.startsWith('<?')) return { endTag: '?>' };
  // Type 4: declaration <!X.
  if (/^<![A-Z]/.test(rest)) return { endTag: '>' };
  // Type 5: CDATA.
  if (rest.startsWith('<![CDATA[')) return { endTag: ']]>' };
  // Type 6: a block-level tag name, or a closing tag of one.
  if ((m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:[ \t]|\/?>|$)/.exec(rest)) &&
      BLOCK_TAGS.has(m[1].toLowerCase())) {
    return { endTag: null };
  }
  // Type 7: a line holding exactly one complete tag (any name) and
  // nothing else. It cannot interrupt a paragraph.
  if (!paragraphOpen) {
    const firstLine = src.slice(0, lineEnd(src, 0));
    const tag = matchHtmlTag(firstLine, 0);
    if (tag !== null && /^[ \t]*$/.test(firstLine.slice(tag.length))) {
      return { endTag: null };
    }
  }
  return null;
}

// Consume an HTML block starting at src[0]; returns [token, rest].
// The block's text runs through its last content line; the newline
// before a following blank line is not part of the text, but a final
// newline at the very end of the input is kept (marked's behaviour).
function takeHtmlBlock(src, start) {
  let end;
  if (start.endTag) {
    const idx = src.toLowerCase().indexOf(start.endTag, 2);
    end = idx === -1 ? src.length : lineEnd(src, idx + start.endTag.length);
    // Tag-terminated blocks keep the terminator line's newline, unless
    // a completely empty line follows the block (a whitespace-only
    // line does not suppress it).
    if (end < src.length && src[end] === '\n') {
      const nle = lineEnd(src, end + 1);
      if (end + 1 === src.length || src.slice(end + 1, nle) !== '') {
        end += 1;
      }
    }
  } else {
    // Through the line before the first blank line.
    end = src.length;
    let i = 0;
    while (i < src.length) {
      const le = lineEnd(src, i);
      if (isBlankLine(src.slice(i, le))) { end = i === 0 ? 0 : i - 1; break; }
      end = le;
      i = le + 1;
    }
  }
  let text = src.slice(0, end);
  if (end < src.length && src[end] === '\n' && end + 1 === src.length) {
    text += '\n';
    end += 1;
  }
  return [{ type: 'html', text }, src.slice(end)];
}

// Strip a fence's indentation from a content line: up to `cols`
// whitespace characters, where a tab consumes the whole remaining
// allowance (marked does not leave a partial-tab remainder here).
function stripFenceIndent(line, cols) {
  let i = 0;
  let allow = cols;
  while (i < line.length && allow > 0) {
    const ch = line[i];
    if (ch === ' ') { allow -= 1; i += 1; }
    else if (ch === '\t') { allow = 0; i += 1; }
    else break;
  }
  return line.slice(i);
}

// Consume a fenced code block starting at src[0]; returns [token, rest].
function takeFence(src, start, firstLineEnd, inQuote) {
  let i = firstLineEnd + 1;
  const contentLines = [];
  let rest = '';
  while (i < src.length) {
    const le = lineEnd(src, i);
    const line = src.slice(i, le);
    const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (close && close[2][0] === start.ch && close[2].length >= start.length) {
      rest = src.slice(le);
      break;
    }
    // marked dedents ``` fence content by the opener's indent, but
    // leaves ~~~ fence content exactly as written.
    contentLines.push(stripFenceIndent(line, start.ch === '~' ? 0 : start.indent));
    if (le >= src.length) { rest = ''; break; }
    i = le + 1;
  }
  const info = start.info.trim();
  const langRaw = info === '' ? '' : info.split(/\s+/)[0];
  const lang = unescapeBackslashes(langRaw);
  // Code text carries its trailing newline when it has any content;
  // when the last content line is blank, one trailing newline is lost
  // (marked's fence capture behaviour) — a fence holding only a blank
  // line renders empty.
  let text = contentLines.length === 0 ? '' : contentLines.join('\n') + '\n';
  if (contentLines[contentLines.length - 1] === '' &&
      text.endsWith('\n')) {
    text = text.slice(0, -1);
  }
  return [{ type: 'code', lang, text }, rest];
}

// Consume an indented code block starting at src[0]; returns [token, rest]
// or null when the indented chunk turns out to be empty.
function takeIndentedCode(src) {
  const lines = [];
  let i = 0;
  let lastContent = -1;
  while (i < src.length) {
    const le = lineEnd(src, i);
    const line = src.slice(i, le);
    if (isBlankLine(line)) {
      // Interior blank lines keep whatever indentation passes the
      // four-column strip (trailing ones are cut by lastContent).
      lines.push(stripIndent(line, 4));
      i = le + 1;
      continue;
    }
    const info = indentInfo(line);
    if (info.cols >= 4) {
      lines.push(stripIndent(line, 4));
      lastContent = lines.length - 1;
      i = le + 1;
      continue;
    }
    break;
  }
  if (lastContent === -1) return null;
  const kept = lines.slice(0, lastContent + 1);
  return [{ type: 'code', lang: '', text: kept.join('\n') + '\n' }, src.slice(i)];
}

// Does a token list end with an open paragraph (looking through nested
// blockquotes and list items)?
function endsWithParagraph(tokens) {
  if (tokens.length === 0) return false;
  const last = tokens[tokens.length - 1];
  if (last.type === 'paragraph') return true;
  if (last.type === 'blockquote') return endsWithParagraph(last.tokens);
  if (last.type === 'list' && last.items.length > 0) {
    return endsWithParagraph(last.items[last.items.length - 1].tokens);
  }
  return false;
}

// Consume a blockquote starting at src[0]; returns [token, rest] or null.
// A blank line without a marker ends the quote; a line without a marker
// joins lazily only when it continues an open paragraph inside.
function takeBlockquote(src, defs) {
  const inner = [];
  let i = 0;
  let sawMarker = false;
  while (i < src.length) {
    const le = lineEnd(src, i);
    const line = src.slice(i, le);
    const m = /^ {0,3}>/.exec(line);
    if (m) {
      // The marker is '>' plus at most one following space; a following
      // tab is consumed by one column and its remainder becomes spaces.
      // The rest of the line's leading tabs are expanded at their
      // original widths, since the content is rebased.
      let raw = line.slice(m[0].length);
      let col = m[0].length;
      let prefix = '';
      if (raw[0] === ' ') { raw = raw.slice(1); col += 1; }
      else if (raw[0] === '\t') {
        const w = 4 - (col % 4);
        prefix = ' '.repeat(Math.max(0, w - 1));
        col += w;
        raw = raw.slice(1);
      }
      inner.push(prefix + expandLeadingWs(raw, col));
      sawMarker = true;
      i = le + 1;
      if (le >= src.length) break;
      continue;
    }
    if (!sawMarker) return null;
    if (isBlankLine(line)) break;
    // Lazy continuation: only into an open paragraph whose last line is
    // not blank, and only a line that would continue that paragraph. An
    // '=' setext underline joins too, but indented four spaces, which
    // keeps it paragraph text (marked's observable behaviour there).
    const lastInner = inner.length > 0 ? inner[inner.length - 1] : '';
    const probe = tokenizeBlocks(inner.join('\n'), defs, undefined, true);
    if (lastInner !== '' && !isBlankLine(lastInner) &&
        endsWithParagraph(probe) && /^ {0,3}=+[ \t]*$/.test(line)) {
      inner.push('    ' + line.replace(/^ {0,3}/, ''));
      i = le + 1;
      if (le >= src.length) break;
      continue;
    }
    if (lastInner !== '' && !isBlankLine(lastInner) &&
        endsWithParagraph(probe) && !interruptsParagraph(line) &&
        takeDef(line + '\n', new Map()) === 0) {
      // The sentinel marks the line as a forced paragraph continuation
      // when the quote's content is tokenised. A line arriving with the
      // sentinel already (nested quotes) keeps just the one.
      inner.push(line[0] === '\u0001'
        ? line
        : '\u0001' + (line.startsWith('    ')
          ? line.replace(/^[ \t]+/, '')
          : line));
      i = le + 1;
      if (le >= src.length) break;
      continue;
    }
    break;
  }
  if (!sawMarker) return null;
  const tokens = tokenizeBlocks(inner.join('\n'), defs, undefined, true);
  return [{ type: 'blockquote', tokens }, src.slice(i)];
}

// --- link reference definitions ---------------------------------------------

const LABEL_RE = /^\[((?:\\.|[^\[\]\\])*)\]/;

// Try to parse one link reference definition at the start of src.
// On success registers it in defs and returns the consumed length;
// on failure returns 0. The definition may span up to three lines.
function takeDef(src0, defs) {
  let base = 0;
  while (base < 3 && src0[base] === ' ') base += 1;
  const src = src0.slice(base);
  if (src[0] !== '[') return 0;
  const labelMatch = LABEL_RE.exec(src);
  if (!labelMatch) return 0;
  const rawLabel = labelMatch[1];
  if (rawLabel.length === 0 || rawLabel.length > 999) return 0;
  let i = labelMatch[0].length;
  if (src[i] !== ':') return 0;
  i += 1;

  // Whitespace, possibly including one line ending.
  const skipWs = (pos, allowNewline) => {
    let sawNewline = false;
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === ' ' || ch === '\t') { pos += 1; continue; }
      if (ch === '\n' && allowNewline && !sawNewline) {
        sawNewline = true; pos += 1; continue;
      }
      break;
    }
    return pos;
  };

  i = skipWs(i, true);
  // Destination.
  let href;
  if (src[i] === '<') {
    const close = src.indexOf('>', i + 1);
    if (close === -1) return 0;
    const inner = src.slice(i + 1, close);
    if (/[<]/.test(inner) || inner.indexOf('\n') !== -1) return 0;
    href = inner;
    i = close + 1;
  } else {
    // Bare destination: non-space characters with balanced parentheses.
    let depth = 0;
    const start = i;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth < 0) break;
      }
      i += 1;
    }
    if (i === start || depth !== 0) return 0;
    href = src.slice(start, i);
  }

  // Optional title: whitespace (one line ending allowed), then a title in
  // double quotes, single quotes or parentheses, then only trailing
  // spaces up to the line ending. A title must be preceded by whitespace.
  let title = null;
  const wsStart = i;
  let j = skipWs(i, true);
  const titleOnLaterLine = src.slice(wsStart, j).indexOf('\n') !== -1;
  const q = src[j];
  if (j !== i && (q === '"' || q === "'" || q === '(')) {
    const closer = q === '(' ? ')' : q;
    let k = j + 1;
    let ok = false;
    while (k < src.length) {
      const ch = src[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === closer) { ok = true; break; }
      if (q === '(' && ch === '(') break;
      if (src[k] === '\n' && src[k + 1] === '\n') break;
      k += 1;
    }
    if (ok) {
      const after = skipWs(k + 1, false);
      if (after >= src.length || src[after] === '\n') {
        title = src.slice(j + 1, k);
        j = after;
      } else if (titleOnLaterLine) {
        // A would-be title line with extra content is not a title at
        // all: the definition ends at the destination.
        j = i;
      } else {
        return 0;
      }
    } else if (j !== i) {
      // There was whitespace and something that is not a title: the whole
      // definition fails only when the rest of the line is not blank.
      const after = skipWs(i, false);
      if (!(after >= src.length || src[after] === '\n')) return 0;
      j = i;
    }
  } else {
    // No title: the rest of the line must be blank.
    const after = skipWs(i, false);
    if (!(after >= src.length || src[after] === '\n')) return 0;
    j = i;
  }

  const label = normaliseLabel(rawLabel);
  if (label === '') return 0;
  if (!defs.has(label)) {
    defs.set(label, {
      href: unescapeBackslashes(href),
      title: title === null ? null : unescapeBackslashes(title),
    });
  }
  let end = j;
  if (src[end] === '\n') end += 1;
  return end + base;
}

// --- tables -----------------------------------------------------------------

// Split a table row into cell strings. Pipes escaped as \| or inside code
// spans do not split. Leading and trailing pipes are dropped.
function splitTableRow(line) {
  // Precompute code-span ranges the way marked's row splitter sees
  // them: a backtick run opens a span closed by a later run of
  // exactly the same length; when no such run exists, the run's
  // last backtick retries as a shorter opener ("``add`" protects
  // "`add`"). A fully unmatched run is literal; pipes after it split.
  const codeRanges = [];
  {
    let i = 0;
    while (i < line.length) {
      if (line[i] === '\\') { i += 2; continue; }
      if (line[i] !== '`') { i += 1; continue; }
      let n = 0;
      while (line[i + n] === '`') n += 1;
      let range = null;
      for (let off = 0; off < n && !range; off += 1) {
        const len = n - off;
        let j = i + n;
        while (j < line.length) {
          if (line[j] === '`') {
            let m = 0;
            while (line[j + m] === '`') m += 1;
            if (m === len) { range = [i + off, j + m]; break; }
            j += m;
          } else j += 1;
        }
      }
      if (!range) { i += n; continue; }
      codeRanges.push(range);
      i = range[1];
    }
  }
  const inCode = (pos) => codeRanges.some(([a, b]) => pos >= a && pos < b);
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      // In a table row, \| is an escaped pipe: it becomes a literal
      // pipe in the cell text and never splits.
      if (line[i + 1] === '|') { cur += '|'; i += 2; continue; }
      cur += ch + line[i + 1];
      i += 2;
      continue;
    }
    if (ch === '|' && !inCode(i)) {
      cells.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  cells.push(cur);
  // Drop the artefacts of a leading / trailing pipe.
  if (cells.length > 1 && cells[0].trim() === '' && /^\s*\|/.test(line)) {
    cells.shift();
  }
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' &&
      /\|\s*$/.test(line) && !/\\\|\s*$/.test(line)) {
    cells.pop();
  }
  return cells.map((c) => c.trim());
}

// If `line` is a table delimiter row, return the alignments array,
// else null.
function tableDelimiter(line) {
  if (line.indexOf('|') === -1) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}

// Consume a table whose header line is src's first line and whose second
// line is the delimiter row. Returns [token, rest] or null.
function takeTable(src) {
  const le1 = lineEnd(src, 0);
  const headerLine = src.slice(0, le1);
  if (headerLine.indexOf('|') === -1) return null;
  const le2 = lineEnd(src, le1 + 1);
  const delimLine = src.slice(le1 + 1, le2);
  const align = tableDelimiter(delimLine);
  if (!align) return null;
  const header = splitTableRow(headerLine);
  if (header.length !== align.length) return null;
  const rows = [];
  let i = le2 + 1;
  if (le2 >= src.length) i = src.length;
  while (i < src.length) {
    const le = lineEnd(src, i);
    const line = src.slice(i, le);
    // marked keeps consuming rows until an empty or spaces-only line
    // or a line that starts another block: a tab-only line becomes an
    // empty row and plain lines become single-cell rows.
    if (line === '' || /^ +$/.test(line)) break;
    if (interruptsBlock(line)) break;
    rows.push(splitTableRow(line));
    i = le + 1;
    if (le >= src.length) break;
  }
  return [{ type: 'table', header, align, rows }, src.slice(i)];
}

// Does this line start a block that would interrupt a paragraph (or end a
// table's rows)? Used as a shared predicate.
function interruptsBlock(line) {
  if (fenceStart(line)) return true;
  if (atxHeading(line)) return true;
  if (isHrLine(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (htmlBlockStart(line, true)) return true;
  return false;
}

// --- lists --------------------------------------------------------------------

// Parse a list marker at the start of a line. Returns null or:
// { bullet, ordered, start, delim, indent, markerCols, contentIndent, empty }
function listMarkerAt(line) {
  const m = /^( {0,3})(?:([-+*])|(\d{1,9})([.)]))/.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  const ordered = m[3] !== undefined;
  const markerCols = ordered ? m[3].length + 1 : 1;
  const after = line.slice(m[0].length);
  if (after !== '' && after[0] !== ' ' && after[0] !== '\t') return null;
  // Columns of whitespace following the marker.
  let col = indent + markerCols;
  let wsCols = 0;
  let k = 0;
  while (k < after.length && (after[k] === ' ' || after[k] === '\t')) {
    if (after[k] === ' ') { wsCols += 1; col += 1; }
    else { const w = 4 - (col % 4); wsCols += w; col += w; }
    k += 1;
  }
  const restEmpty = after.slice(k) === '';
  let contentIndent;
  if (restEmpty || wsCols > 4) contentIndent = indent + markerCols + 1;
  else contentIndent = indent + markerCols + wsCols;
  return {
    bullet: ordered ? null : m[2],
    ordered,
    start: ordered ? parseInt(m[3], 10) : 1,
    delim: ordered ? m[4] : null,
    indent,
    markerCols,
    markerEnd: m[0].length,
    contentIndent,
    empty: restEmpty,
  };
}

function sameListKind(a, b) {
  if (a.ordered !== b.ordered) return false;
  if (a.ordered) return a.delim === b.delim;
  return a.bullet === b.bullet;
}

// Track an open fence inside list item content: while a fence is open,
// lines belong to the item verbatim (no sibling/lazy/blank logic).
function fenceTrack(state, line) {
  if (state === null) {
    const fs = fenceStart(line);
    return fs ? { ch: fs.ch, length: fs.length } : null;
  }
  const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (close && close[2][0] === state.ch && close[2].length >= state.length) {
    return null;
  }
  return state;
}

// Consume a list starting at src[0]; returns [token, rest] or null.
function takeList(src, defs, inQuote) {
  const firstLine = src.slice(0, lineEnd(src, 0));
  const first = listMarkerAt(firstLine);
  if (!first) return null;
  const items = [];
  let loose = false;
  let pos = 0;
  let cur = first;
  let nextItem = null;

  while (true) {
    const le = lineEnd(src, pos);
    const markerLine = src.slice(pos, le);
    const contentIndent = cur.contentIndent;
    const firstContent = stripIndent(
      markerLine.slice(cur.markerEnd),
      contentIndent - cur.indent - cur.markerCols,
      cur.indent + cur.markerCols, true);
    const itemLines = [firstContent];
    let fenceLineCount = 0;
    const trackFence = (line) => {
      const prev = inFence;
      const next = fenceTrack(prev, line);
      if (prev && next) fenceLineCount += 1;
      else fenceLineCount = 0;
      inFence = next;
    };
    let inFence = null;
    trackFence(firstContent);
    let j = le + 1;
    if (le >= src.length) j = src.length;
    let itemDone = false;
    nextItem = null;
    let endList = false;

    while (j < src.length && !itemDone) {
      const le2 = lineEnd(src, j);
      const line = src.slice(j, le2);
      if (inFence) {
        // While a fence inside the item still has no content lines,
        // a non-blank line indented less than the content indent ends
        // the item: the fence is left unclosed and empty. Once the
        // fence has content, dedented lines belong to it.
        if (!isBlankLine(line) && indentInfo(line).cols < contentIndent &&
            fenceLineCount === 0) {
          itemDone = true;
          endList = true;
          break;
        }
        const stripped = stripIndent(line, contentIndent, 0, true);
        itemLines.push(stripped);
        trackFence(stripped);
        j = le2 + 1;
        continue;
      }
      if (isBlankLine(line)) {
        const blankStart = j;
        // Find the next non-blank line.
        let k = le2 + 1;
        let nline = null;
        let nle = le2;
        while (k < src.length) {
          nle = lineEnd(src, k);
          nline = src.slice(k, nle);
          if (isBlankLine(nline)) { k = nle + 1; nline = null; continue; }
          break;
        }
        if (nline === null) { j = src.length; itemDone = true; endList = true; break; }
        if (isHrLine(nline)) { j = blankStart; itemDone = true; endList = true; break; }
        const nm = listMarkerAt(nline);
        if (nm && nm.indent < contentIndent && sameListKind(nm, first)) {
          loose = true;
          nextItem = { offset: k, marker: nm };
          itemDone = true;
          break;
        }
        // An item with no content yet ends at a blank line: what
        // follows (other than a sibling item) is outside the list.
        if (itemLines.every((l) => l === '')) {
          j = blankStart;
          itemDone = true;
          endList = true;
          break;
        }
        if (indentInfo(nline).cols >= contentIndent) {
          // A blank line inside the item, with more item content after.
          itemLines.push('');
          j = le2 + 1;
          continue;
        }
        // Blank line(s) then unrelated content: the list is over. The
        // restarts at the blank run so callers see the separator.
        j = blankStart;
        itemDone = true;
        endList = true;
        break;
      }
      const ind = indentInfo(line);
      if (ind.cols >= contentIndent) {
        const stripped = stripIndent(line, contentIndent, 0, true);
        itemLines.push(stripped);
        trackFence(stripped);
        j = le2 + 1;
        continue;
      }
      // A thematic break ends the list rather than starting an item.
      if (isHrLine(line)) { itemDone = true; endList = true; break; }
      const nm = listMarkerAt(line);
      if (nm && sameListKind(nm, first)) {
        nextItem = { offset: j, marker: nm };
        itemDone = true;
        break;
      }
      // Lazy paragraph continuation inside the item: its leading
      // whitespace is stripped, as in blockquotes, and the sentinel
      // keeps it paragraph text when the content is tokenised.
      if (itemLines[itemLines.length - 1] !== '' && !interruptsBlock(line) && !nm) {
        itemLines.push(line[0] === '\u0001'
          ? line
          : '\u0001' + (line.startsWith('    ')
            ? line.replace(/^[ \t]+/, '')
            : line));
        j = le2 + 1;
        continue;
      }
      itemDone = true;
      endList = true;
      break;
    }

    const content = itemLines.join('\n');
    const itemFlags = { blankBetween: false };
    const tokens = tokenizeBlocks(content, defs, itemFlags, inQuote);
    if (itemFlags.blankBetween) loose = true;
    let task = false;
    let checked = false;
    if (tokens.length > 0 && tokens[0].type === 'paragraph') {
      const tm = /^\[([ xX])\](?: |$)/.exec(tokens[0].text) ||
        /^\[([ xX])\]$/.exec(tokens[0].text);
      if (tm) {
        task = true;
        checked = tm[1] !== ' ';
        tokens[0] = {
          ...tokens[0],
          text: tokens[0].text.slice(tm[0].length),
        };
      }
    }
    items.push({ tokens, task, checked });

    if (nextItem) {
      pos = nextItem.offset;
      cur = nextItem.marker;
      continue;
    }
    pos = j;
    break;
  }

  return [{
    type: 'list',
    ordered: first.ordered,
    start: first.start,
    loose,
    items,
  }, src.slice(pos)];
}

// --- paragraphs and setext headings -------------------------------------------

function isSetextUnderline(line) {
  return /^ {0,3}(=+|-+)[ \t]*$/.test(line);
}

// Would `line` interrupt a paragraph? (Setext underlines are handled by
// the caller before this is consulted.) Inside list items, an ordered
// list with any start number interrupts, as marked does there.
function interruptsParagraph(line, inItem = false) {
  if (fenceStart(line)) return true;
  if (atxHeading(line)) return true;
  if (isHrLine(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (htmlBlockStart(line, true)) return true;
  const lm = listMarkerAt(line);
  if (lm && !lm.empty) {
    if (!lm.ordered) return true;
    if (lm.ordered && (inItem || lm.start === 1)) return true;
  }
  return false;
}

// Consume a paragraph (or setext heading) starting at src[0].
// Returns [token, rest].
function takeParagraph(src, defs, inItem = false) {
  const lines = [];
  let i = 0;
  while (i < src.length) {
    const le = lineEnd(src, i);
    const line = src.slice(i, le);
    if (lines.length > 0) {
      // A blockquote lazy line (sentinel-prefixed) always continues.
      if (line[0] === '\u0001') {
        lines.push(line.slice(1));
        i = le + 1;
        if (le >= src.length) break;
        continue;
      }
      // A blank line ends the paragraph, except that a final
      // whitespace-only line with no trailing newline is absorbed
      // (it is the paragraph's last line in marked's capture).
      if (line === '') break;
      if (isBlankLine(line) && le < src.length) break;
      if (isSetextUnderline(line)) {
        const depth = line.trimStart()[0] === '=' ? 1 : 2;
        const text = lines.join('\n').trim();
        let rest = src.slice(le);
        if (rest[0] === '\n') rest = rest.slice(1);
        return [{ type: 'heading', depth, text }, rest];
      }
      // A table starting on this line ends the paragraph before it.
      const le2 = lineEnd(src, le + 1);
      const nextLine = src.slice(le + 1, le2);
      const align = tableDelimiter(nextLine);
      if (align && line.indexOf('|') !== -1 &&
          splitTableRow(line).length === align.length) {
        break;
      }
      // A link reference definition interrupts a paragraph; leave the
      // line for the main loop (which will consume the definition, or
      // start a fresh paragraph with it if it is not one).
      if (interruptsParagraph(line, inItem)) break;
    }
    lines.push(line);
    i = le + 1;
    if (le >= src.length) break;
  }
  return [{ type: 'paragraph', text: lines.join('\n') }, src.slice(i)];
}

// --- the block loop -----------------------------------------------------------

function tokenizeBlocks(src, defs, flags, inQuote) {
  const tokens = [];
  let rest = src;
  let pendingBlank = false;
  const push = (token) => {
    if (pendingBlank && tokens.length > 0 && flags) flags.blankBetween = true;
    pendingBlank = false;
    tokens.push(token);
  };
  while (rest.length > 0) {
    const le = lineEnd(rest, 0);
    const line = rest.slice(0, le);
    if (isBlankLine(line)) {
      pendingBlank = true;
      rest = rest.slice(le + 1);
      continue;
    }

    let out = null;

    // Indented code block.
    if (indentInfo(line).cols >= 4) {
      out = takeIndentedCode(rest);
      if (out) { push(out[0]); rest = out[1]; continue; }
    }
    // Fenced code block.
    const fs = fenceStart(line);
    if (fs) {
      out = takeFence(rest, fs, le, inQuote);
      push(out[0]); rest = out[1]; continue;
    }
    // ATX heading.
    const atx = atxHeading(line);
    if (atx) {
      push({ type: 'heading', depth: atx.depth, text: atx.text });
      rest = rest.slice(le + 1);
      continue;
    }
    // Thematic break.
    if (isHrLine(line)) {
      push({ type: 'hr' });
      rest = rest.slice(le + 1);
      continue;
    }
    // Blockquote.
    if (/^ {0,3}>/.test(line)) {
      out = takeBlockquote(rest, defs);
      if (out) { push(out[0]); rest = out[1]; continue; }
    }
    // List.
    if (listMarkerAt(line)) {
      out = takeList(rest, defs, inQuote);
      if (out) { push(out[0]); rest = out[1]; continue; }
    }
    // HTML block.
    const hs = htmlBlockStart(rest, false);
    if (hs) {
      out = takeHtmlBlock(rest, hs);
      push(out[0]); rest = out[1]; continue;
    }
    // Link reference definitions (possibly several in a row).
    if (line.replace(/^ {0,3}/, '')[0] === '[') {
      let consumed = 0;
      let n = 0;
      while ((n = takeDef(rest.slice(consumed), defs)) > 0) consumed += n;
      if (consumed > 0) {
        // A definition separated from earlier content by a blank line
        // still counts as blank-separated content (list looseness).
        if (pendingBlank && tokens.length > 0 && flags) {
          flags.blankBetween = true;
        }
        pendingBlank = false;
        rest = rest.slice(consumed);
        continue;
      }
    }
    // Table.
    out = takeTable(rest);
    if (out) { push(out[0]); rest = out[1]; continue; }
    // Paragraph / setext heading.
    out = takeParagraph(rest, defs, flags != null);
    push(out[0]);
    rest = out[1];
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Render a raw source text run to HTML: numeric character references are
// decoded, named references pass through, and &, <, > are escaped.
function renderTextRun(raw) {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '&') {
      const m = /^&#(\d+);|^&#[xX]([0-9a-fA-F]+);|^&[A-Za-z][A-Za-z0-9]*;/.exec(raw.slice(i));
      if (m) {
        const decoded = m[1] !== undefined
          ? decodeNumericRef(m[1])
          : (m[2] !== undefined ? decodeNumericRef('x' + m[2]) : undefined);
        if (decoded !== undefined && decoded !== null) {
          out += escapeTextChar(decoded);
          i += m[0].length;
          continue;
        }
        if (decoded === undefined) {
          // A named reference passes through untouched.
          out += m[0];
          i += m[0].length;
          continue;
        }
        // Out-of-range numeric reference: the & is literal.
        out += '&amp;';
        i += 1;
        continue;
      }
      out += '&amp;';
      i += 1;
      continue;
    }
    if (ch === '<') { out += '&lt;'; i += 1; continue; }
    if (ch === '>') { out += '&gt;'; i += 1; continue; }
    if (ch === '"') { out += '&quot;'; i += 1; continue; }
    if (ch === "'") { out += '&#39;'; i += 1; continue; }
    // Consume a plain stretch.
    let j = i + 1;
    while (j < raw.length && raw[j] !== '&' && raw[j] !== '<' && raw[j] !== '>' &&
           raw[j] !== '"' && raw[j] !== "'") j += 1;
    out += raw.slice(i, j);
    i = j;
  }
  return out;
}

function escapeTextChar(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  if (ch === "'") return '&#39;';
  return ch;
}

// Escape a string for an attribute value, preserving entity references
// the way marked does, and escaping &, <, >, ", '.
function escapeAttrPreservingEntities(s) {
  return s.replace(/&(?!(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)|[<>"']/g,
    (c) => ESCAPES[c]);
}

// marked's href treatment: percent-encode what encodeURI encodes, then
// undo the encoding of '%' itself so existing escapes survive.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

function hrefAttr(href) {
  return escapeAttrPreservingEntities(cleanUrl(href));
}

const TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTR = "(?:[ \\t\\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t\\n]*=[ \\t\\n]*(?:[^ \\t\\n\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)";
const OPEN_TAG_RE = new RegExp('^<' + TAG_NAME + '(?:' + ATTR + ')*[ \\t\\n]*/?>');
const CLOSE_TAG_RE = new RegExp('^</' + TAG_NAME + '[ \\t\\n]*>');
const HTML_COMMENT_RE = /^<!--(?!>|->)[\s\S]*?(?<!-)-->/;
const PI_RE = /^<\?[\s\S]*?\?>/;
const DECL_RE = /^<![A-Za-z][\s\S]*?>/;
const CDATA_RE = /^<!\[CDATA\[[\s\S]*?\]\]>/;
const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^ \t\n<>]*)>/;
const EMAIL_AUTOLINK_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

// Try to match raw inline HTML at src[i]; returns the matched string or
// null. Autolinks are handled by the caller before this.
function matchHtmlTag(src, i) {
  const rest = src.slice(i);
  let m;
  // Abruptly closed comments are complete comments in marked's output.
  if (rest.startsWith('<!-->')) return '<!-->';
  if (rest.startsWith('<!--->')) return '<!--->';
  if ((m = HTML_COMMENT_RE.exec(rest))) return m[0];
  if ((m = PI_RE.exec(rest))) return m[0];
  if ((m = CDATA_RE.exec(rest))) return m[0];
  if ((m = DECL_RE.exec(rest))) return m[0];
  if ((m = OPEN_TAG_RE.exec(rest))) return m[0];
  if ((m = CLOSE_TAG_RE.exec(rest))) return m[0];
  return null;
}

// Skip whitespace (spaces, tabs, line endings) inside a link's parens.
// Returns the new index, or -1 if a blank line is crossed.
function skipLinkWs(src, i) {
  let newlines = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t') { i += 1; continue; }
    if (ch === '\n') { newlines += 1; if (newlines > 1) return -1; i += 1; continue; }
    break;
  }
  return i;
}

// Parse a link destination starting at src[i] (inside parens, or a
// definition). Returns { href, end } or null.
function parseLinkDestination(src, i) {
  if (src[i] === '<') {
    let j = i + 1;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '>') {
        return { href: unescapeBackslashes(src.slice(i + 1, j)), end: j + 1 };
      }
      if (ch === '<' || ch === '\n') return null;
      j += 1;
    }
    return null;
  }
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    j += 1;
  }
  if (j === i || depth !== 0) return null;
  return { href: unescapeBackslashes(src.slice(i, j)), end: j };
}

// Parse a link title starting at src[i]. Returns { title, end } or null.
function parseLinkTitle(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const closer = q === '(' ? ')' : q;
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === closer) {
      return { title: unescapeBackslashes(src.slice(i + 1, j)), end: j + 1 };
    }
    if (q === '(' && ch === '(') return null;
    if (ch === '\n' && src[j + 1] === '\n') return null;
    j += 1;
  }
  return null;
}

// Parse the tail of an inline link starting just after the closing ']'
// of its text: '(dest "title")'. Returns { href, title, end } or null.
function parseInlineLinkTail(src, i) {
  // src[i] === '('
  let j = skipLinkWs(src, i + 1);
  if (j === -1) return null;
  let href = '';
  let title = null;
  if (src[j] !== ')') {
    const dest = parseLinkDestination(src, j);
    if (!dest) return null;
    href = dest.href;
    j = skipLinkWs(src, dest.end);
    if (j === -1) return null;
    if (src[j] !== ')') {
      const t = parseLinkTitle(src, j);
      if (!t) return null;
      title = t.title;
      j = skipLinkWs(src, t.end);
      if (j === -1) return null;
    }
  }
  if (src[j] !== ')') return null;
  return { href, title, end: j + 1 };
}

// Parse a reference label starting at src[i] === '['. Returns
// { raw, end } or null.
function parseRefLabel(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') {
      return { raw: src.slice(i + 1, j), end: j + 1 };
    }
    j += 1;
  }
  return null;
}

// --- GFM extended autolinks ---------------------------------------------------

function isWs(ch) {
  return ch === undefined || /\s/.test(ch);
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  return ch !== undefined && PUNCT_RE.test(ch);
}

// Trim an extended-autolink candidate per the GFM rules: trailing
// punctuation is dropped, unbalanced ')' is dropped, and a trailing
// entity reference's semicolon is dropped.
function trimAutolink(url, forHref) {
  // An autolink never spans into a second scheme introduced by '(':
  // it keeps everything before that '(' (a failed link tail followed
  // by another URL renders as two separate autolinks).
  const second = /\(https?:\/\//i.exec(url.slice(6));
  if (second) url = url.slice(0, second.index + 6);
  let changed = true;
  while (changed && url.length > 0) {
    changed = false;
    const last = url[url.length - 1];
    if ('?!.,:*_~'.indexOf(last) !== -1) {
      url = url.slice(0, -1); changed = true; continue;
    }
    if (last === ';') {
      // An entity-like ending is excluded whole, per the GFM rules;
      // a bare trailing semicolon is dropped on its own.
      if (/&[A-Za-z0-9]+;$/.test(url)) {
        url = url.replace(/&[A-Za-z0-9]+;$/, '');
      } else {
        url = url.slice(0, -1);
      }
      changed = true;
      continue;
    }
    if (last === ')') {
      let open = 0, close = 0;
      for (const c of url) { if (c === '(') open += 1; else if (c === ')') close += 1; }
      if (close > open) { url = url.slice(0, -1); changed = true; }
      continue;
    }
  }
  return url;
}

// Trimming for a chained autolink ("URL)](URL)"): like trimAutolink
// but the chain is never cut at a second scheme, and the ')' of each
// ")](" joint is structural, so it does not count as an unbalanced
// closing paren.
function trimAutolinkChain(url) {
  let changed = true;
  while (changed && url.length > 0) {
    changed = false;
    const last = url[url.length - 1];
    if ('?!.,:*_~'.indexOf(last) !== -1) {
      url = url.slice(0, -1); changed = true; continue;
    }
    if (last === ';') {
      if (/&[A-Za-z0-9]+;$/.test(url)) {
        url = url.replace(/&[A-Za-z0-9]+;$/, '');
      } else {
        url = url.slice(0, -1);
      }
      changed = true;
      continue;
    }
    if (last === ')') {
      let open = 0, close = 0;
      for (let k = 0; k < url.length; k += 1) {
        if (url[k] === '(') open += 1;
        else if (url[k] === ')') {
          if (url[k + 1] === ']' && url[k + 2] === '(') continue;
          close += 1;
        }
      }
      if (close > open) { url = url.slice(0, -1); changed = true; }
      continue;
    }
  }
  return url;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/;

// An email autolink is rejected when immediately followed by a lone
// '-' or '_' that stays literal text. A run of 2+ is an emphasis
// delimiter, and a single '_' with an earlier unmatched '_' opener is
// an emphasis closer — in both cases the email still links (marked
// consumes the delimiters before scanning the inner text).
function emailFollowRejected(text, end, nodes) {
  const c = text[end];
  if (c !== '-' && c !== '_') return false;
  let run = 0;
  while (text[end + run] === c) run += 1;
  if (run >= 2) return false;
  if (c === '_' && nodes &&
      nodes.some((n) => n.t === 'delim' && n.ch === '_' && n.canOpen)) {
    return false;
  }
  return true;
}

// Try an extended autolink at text[i]. `prev` is the preceding character
// (undefined at the start). When `stopBracket` is set (a link/image
// opener is pending), the candidate may not cross a ']' — marked
// decides the bracket construct first. Returns { href, text, end }.
function matchExtendedAutolink(text, i, prev, stopBracket, nodes) {
  const rest = text.slice(i);
  // www. links
  if (rest.startsWith('www.') &&
      (prev === undefined || isWs(prev) || '([{\'"*_~<'.indexOf(prev) !== -1)) {
    const m = /^[A-Za-z0-9][A-Za-z0-9.-]*/.exec(rest.slice(4));
    if (m) {
      const domain = m[0].replace(/[.-]+$/, '');
      const lastDot = domain.lastIndexOf('.');
      if (lastDot > 0 && domain.length - lastDot - 1 >= 2) {
        let j = i + 4 + domain.length;
        while (j < text.length && !isWs(text[j]) && text[j] !== '<' &&
               !(stopBracket && text[j] === ']')) j += 1;
        const raw = text.slice(i, j);
        const url = trimAutolink(raw, false);
        if (url.length > 4 + lastDot) {
          return { href: 'http://' + trimAutolink(raw, true), text: url, end: i + url.length };
        }
      }
    }
    return null;
  }
  // scheme links (the scheme matches case-insensitively)
  if (/^https?:\/\//i.test(rest)) {
    const schemeLen = /^https:/i.test(rest) ? 8 : 7;
    // A URL in the destination slot of a failed bracket construct
    // (immediately after "](") is matched the way marked's matcher
    // sees it: ')' is a path character and a "(...)" group with no
    // spaces or nested parens is consumed whole; a group that fails
    // ends the match just before its '('.
    if (i >= 2 && text[i - 1] === '(' && text[i - 2] === ']') {
      let j = i;
      while (j < text.length && !isWs(text[j]) && text[j] !== '<') {
        if (text[j] === '(') {
          const close = text.indexOf(')', j);
          if (close === -1) break;
          if (/[\s()]/.test(text.slice(j + 1, close))) break;
          j = close + 1;
          continue;
        }
        j += 1;
      }
      const cand = text.slice(i, j);
      const url = cand.includes(')](')
        ? trimAutolinkChain(cand)
        : trimAutolink(cand, false);
      if (url.length > schemeLen) {
        return { href: url, text: url, end: i + url.length };
      }
      return null;
    }
    let j = i;
    while (j < text.length && !isWs(text[j]) && text[j] !== '<' &&
           !(stopBracket && text[j] === ']')) j += 1;
    const raw = text.slice(i, j);
    const url = trimAutolink(raw, false);
    if (url.length > schemeLen) {
      return { href: trimAutolink(raw, true), text: url, end: i + url.length };
    }
    return null;
  }
  // mailto: / xmpp: autolinks: the scheme is part of the link.
  const scheme = /^(mailto|xmpp):/.exec(rest);
  if (scheme &&
      (prev === undefined || isWs(prev) || '([{\'"*_~<'.indexOf(prev) !== -1)) {
    const em = EMAIL_RE.exec(rest.slice(scheme[0].length));
    if (em) {
      let cand = scheme[0] + em[0];
      let end = i + cand.length;
      if (emailFollowRejected(text, end, nodes)) return null;
      if (scheme[1] === 'xmpp' && text[end] === '/') {
        const rm = /^\/[A-Za-z0-9@._~-]+/.exec(text.slice(end));
        if (rm) {
          const resource = trimAutolink(rm[0], true);
          cand += resource;
          end += resource.length;
        }
      }
      return { href: cand, text: cand, end };
    }
    return null;
  }
  // email links
  if (prev === undefined || (!/[A-Za-z0-9._%+\-]/.test(prev) && prev !== '@')) {
    // An address directly after a mailto:/xmpp: scheme was already
    // decided by the scheme branch above.
    if (/(?:mailto|xmpp):$/.test(text.slice(0, i))) return null;
    const m = EMAIL_RE.exec(rest);
    if (m) {
      if (emailFollowRejected(text, i + m[0].length, nodes)) return null;
      return { href: 'mailto:' + m[0], text: m[0], end: i + m[0].length };
    }
  }
  return null;
}

// Whether a link label's backticks are usable by marked's link
// matcher. Pair the label's backtick runs into code spans (a run
// closes at the next run of equal length). The label is rejected
// when a completed span ends before the label does — the matcher
// then leaves the bracket literal — and when the label's only
// backtick content is one lone single backtick. Dangling runs like
// "``url`" are fine: they stay literal inside the link text.
function labelBackticksBalanced(label) {
  const runs = [];
  for (let k = 0; k < label.length; k += 1) {
    if (label[k] === '\\') { k += 1; continue; }
    if (label[k] === '`') {
      let len = 0;
      while (label[k] === '`') { len += 1; k += 1; }
      runs.push({ start: k - len, len, end: k });
      k -= 1;
    }
  }
  if (runs.length === 0) return true;
  if (runs.length === 1) return runs[0].len !== 1;
  let idx = 0;
  while (idx < runs.length) {
    const open = runs[idx];
    let close = -1;
    for (let q = idx + 1; q < runs.length; q += 1) {
      if (runs[q].len === open.len) { close = q; break; }
    }
    if (close === -1) { idx += 1; continue; }
    if (open.len === 2 && runs[close].end !== label.length) return false;
    idx = close + 1;
  }
  return true;
}

// --- emphasis -------------------------------------------------------------------

function flanking(text, i, j, ch) {
  const before = i === 0 ? undefined : text[i - 1];
  const after = j >= text.length ? undefined : text[j];
  const beforeWs = isWs(before);
  const afterWs = isWs(after);
  const beforePunct = isPunct(before);
  const afterPunct = isPunct(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  if (ch === '*') return { canOpen: left, canClose: right };
  if (ch === '~') {
    // marked pairs a both-flanking ~~ as a closer (e.g. after a code
    // span, before a colon), so tildes use the plain flanking flags.
    return { canOpen: left, canClose: right };
  }
  return {
    canOpen: left && (!right || beforePunct),
    canClose: right && (!left || afterPunct),
  };
}

// The CommonMark delimiter-run pass over a node list.
function processEmphasis(nodes) {
  const delims = [];
  for (const n of nodes) if (n.t === 'delim') delims.push(n);
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.canClose || closer.n === 0) { ci += 1; continue; }
    let opener = null;
    let oi = -1;
    for (let j = ci - 1; j >= 0; j -= 1) {
      const o = delims[j];
      if (o.ch !== closer.ch || !o.canOpen || o.n === 0) continue;
      if (closer.ch === '~' && o.n !== closer.n) continue;
      if (closer.ch !== '~' &&
          (closer.canOpen || o.canClose) &&
          (o.n + closer.n) % 3 === 0 && !(o.n % 3 === 0 && closer.n % 3 === 0)) {
        continue;
      }
      // marked deviation: a pure single closer does not partially pair
      // with a pure double opener when that opener still has a double
      // closer ahead of it (**text *a*b* stray* more** keeps the stray
      // star literal inside the strong; **foo* alone still pairs).
      if (closer.ch !== '~' && closer.n === 1 && o.n === 2 &&
          !o.canClose && !closer.canOpen) {
        let hasDoubleCloser = false;
        for (let m = ci + 1; m < delims.length; m += 1) {
          const d = delims[m];
          if (d.ch === closer.ch && d.n >= 2 && d.canClose) {
            hasDoubleCloser = true;
            break;
          }
        }
        if (hasDoubleCloser) continue;
      }
      // marked deviation: an em pair does not form when its content
      // holds a same-char strong pair that is preceded by whitespace
      // and immediately followed by an alphanumeric (*a **b**c* keeps
      // the outer stars literal, but *a**b**c* and *a **b** c* pair).
      if (closer.ch !== '~' &&
          (o.n >= 2 && closer.n >= 2 ? 2 : 1) === 1) {
        const a = nodes.indexOf(o);
        const b = nodes.indexOf(closer);
        let blocked = false;
        const meaningful = (from, dir) => {
          for (let m = from; m >= 0 && m < b; m += dir) {
            const cand = nodes[m];
            if (cand.t === 'delim' && cand.n === 0) continue;
            if (cand.t === 'text' && cand.raw === '') continue;
            return cand;
          }
          return undefined;
        };
        for (let k = a + 1; k < b && !blocked; k += 1) {
          const inner = nodes[k];
          if (inner.t !== 'strong' || inner.ch !== closer.ch) continue;
          const prev = meaningful(k - 1, -1);
          const next = meaningful(k + 1, 1);
          const spaceBefore = prev !== undefined && prev.t === 'text' &&
            /\s/.test(prev.raw[prev.raw.length - 1]);
          const first = next === undefined ? undefined
            : next.t === 'text' ? next.raw[0]
            : next.t === 'lit' ? next.s : undefined;
          if (spaceBefore && first !== undefined &&
              /[A-Za-z0-9]/.test(first)) {
            blocked = true;
          }
        }
        if (blocked) continue;
      }
      // Inside a link label that marked's matcher rejected over its
      // backticks, an emphasis pair whose content holds a code span
      // does not form (the underscores of "_an `` a ` b ``_" inside
      // the rejected "[cache ...](...)" stay literal).
      if (closer.ch !== '~' && (o.labelRejected || closer.labelRejected)) {
        const a = nodes.indexOf(o);
        const b = nodes.indexOf(closer);
        let hasCode = false;
        for (let k = a + 1; k < b; k += 1) {
          if (nodes[k].t === 'code') { hasCode = true; break; }
        }
        if (hasCode) continue;
      }
      opener = o; oi = j; break;
    }
    if (!opener) { ci += 1; continue; }
    const use = closer.ch === '~'
      ? opener.n
      : (opener.n >= 2 && closer.n >= 2 ? 2 : 1);
    opener.n -= use;
    closer.n -= use;
    const a = nodes.indexOf(opener);
    const b = nodes.indexOf(closer);
    const inner = nodes.splice(a + 1, b - a - 1);
    nodes.splice(a + 1, 0, {
      t: closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em'),
      ch: closer.ch,
      children: inner,
    });
    // Delimiters between opener and closer can no longer match.
    delims.splice(oi + 1, ci - oi - 1);
    ci = delims.indexOf(closer);
    if (closer.n === 0) delims.splice(ci, 1);
  }
}

// Plain-text content of a node list (for image alt text and labels).
function plainTextOf(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += decodeNumericRefs(unescapeBackslashes(n.raw)); break;
      case 'lit': out += n.s; break;
      case 'code': out += n.s; break;
      case 'lbracket': out += '['; break;
      case 'limage': out += '!['; break;
      case 'html': break;
      case 'br': out += '\n'; break;
      case 'delim': out += n.ch.repeat(n.n); break;
      case 'link': case 'em': case 'strong': case 'del':
        out += plainTextOf(n.children); break;
      case 'image': out += n.alt; break;
      default: break;
    }
  }
  return out;
}

// --- the inline scanner ---------------------------------------------------------

// Marked tracks one piece of lexer state across a whole document:
// once a raw "<a " start tag is tokenised inline, extended autolinks
// (bare URLs, www. links and emails) stop forming until a "</a>"
// tag token appears. Reset per parse() call.
let inLink = false;

function inlineNodes(text, defs) {
  const nodes = [];
  const openers = []; // { marker, image, bracketStart, active }
  let buf = '';
  let i = 0;

  const flush = () => {
    if (buf !== '') {
      nodes.push({ t: 'text', raw: buf });
      buf = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Backslash escapes and hard breaks.
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        while (text[i] === ' ' || text[i] === '\t') i += 1;
        continue;
      }
      if (next !== undefined && isAsciiPunct(next)) {
        flush();
        nodes.push({ t: 'lit', s: next });
        i += 2;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    // Hard break: two or more spaces before a line ending.
    if (ch === '\n') {
      let spaces = 0;
      while (buf[buf.length - 1 - spaces] === ' ') spaces += 1;
      if (spaces >= 2) {
        buf = buf.slice(0, buf.length - spaces);
        flush();
        nodes.push({ t: 'br' });
        i += 1;
        while (text[i] === ' ' || text[i] === '\t') i += 1;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    // Code spans.
    if (ch === '`') {
      let n = 0;
      while (text[i + n] === '`') n += 1;
      let j = i + n;
      let closeStart = -1;
      while (j < text.length) {
        if (text[j] === '`') {
          let m = 0;
          while (text[j + m] === '`') m += 1;
          if (m === n) { closeStart = j; break; }
          j += m;
        } else j += 1;
      }
      // While a link label is pending, a code span whose closing run
      // lies past the label's ']' does not form when the label's own
      // backtick runs pair up: marked decides the link first, and the
      // backticks stay literal inside the link text.
      if (closeStart !== -1) {
        const op = [...openers].reverse().find((o) => o.active);
        if (op) {
          const rb = text.indexOf(']', i + n);
          if (rb !== -1 && closeStart > rb &&
              labelBackticksBalanced(text.slice(op.bracketStart, rb))) {
            buf += '`'.repeat(n);
            i += n;
            continue;
          }
        }
      }
      if (closeStart === -1) {
        buf += '`'.repeat(n);
        i += n;
        continue;
      }
      let content = text.slice(i + n, closeStart).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' &&
          content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: content });
      i = closeStart + n;
      continue;
    }

    // Images and links: openers.
    if (ch === '!' && text[i + 1] === '[') {
      flush();
      const marker = { t: 'limage' };
      nodes.push(marker);
      openers.push({ marker, image: true, bracketStart: i + 2, active: true });
      i += 2;
      continue;
    }
    if (ch === '[') {
      flush();
      const marker = { t: 'lbracket' };
      nodes.push(marker);
      openers.push({ marker, image: false, bracketStart: i + 1, active: true });
      i += 1;
      continue;
    }

    // Closing bracket: try to form a link or image. The most recent
    // opener governs: an inactive opener still pairs with this bracket
    // (and swallows it as literal text) rather than letting an older
    // opener claim it.
    if (ch === ']') {
      flush();
      if (openers.length === 0) { buf += ch; i += 1; continue; }
      const s = openers.length - 1;
      const op = openers[s];
      if (!op.active) {
        openers.pop();
        buf += ch;
        i += 1;
        continue;
      }
      const mIdx = nodes.indexOf(op.marker);
      const textRaw = text.slice(op.bracketStart, i);
      // A label with an unpaired backtick run cannot form a link.
      if (!labelBackticksBalanced(textRaw)) {
        for (let k = mIdx + 1; k < nodes.length; k += 1) {
          if (nodes[k].t === 'delim') nodes[k].labelRejected = true;
        }
        openers.pop();
        buf += ch;
        i += 1;
        continue;
      }
      let formed = null;
      let consumed = 0;
      // When a complete reference label follows, it alone decides:
      // there is no shortcut fallback in marked. An inline tail that
      // does not parse falls back to the shortcut reference.
      let decided = false;
      if (text[i + 1] === '(') {
        const tail = parseInlineLinkTail(text, i + 1);
        if (tail) { formed = tail; consumed = tail.end - (i + 1); }
      } else if (text[i + 1] === '[') {
        const ref = parseRefLabel(text, i + 1);
        if (ref) {
          decided = true;
          const labelRaw = ref.raw === '' ? textRaw : ref.raw;
          const def = defs.get(normaliseLabel(labelRaw));
          if (def) {
            formed = { href: def.href, title: def.title };
            consumed = ref.end - (i + 1);
          }
        }
      }
      if (!formed && !decided) {
        // Shortcut reference: the bracketed text is the label.
        const def = defs.get(normaliseLabel(textRaw));
        if (def) formed = { href: def.href, title: def.title };
      }
      if (!formed) {
        openers.pop();
        buf += ch;
        i += 1;
        continue;
      }
      // Form the link/image from the nodes after the marker.
      nodes.splice(mIdx, 1);
      const children = nodes.splice(mIdx);
      // marked does not autolink inside link text: extended autolinks
      // among the children revert to plain text.
      for (let k = 0; k < children.length; k += 1) {
        const c = children[k];
        if (c.t === 'link' && c.ext) {
          children[k] = { t: 'text', raw: c.children[0].raw };
        }
      }
      processEmphasis(children);
      if (op.image) {
        nodes.push({
          t: 'image', href: formed.href, title: formed.title,
          alt: plainTextOf(children),
        });
      } else {
        nodes.push({
          t: 'link', href: formed.href, title: formed.title, children,
        });
        // Links cannot contain links: deactivate earlier '[' openers.
        for (let k = 0; k < s; k += 1) {
          if (!openers[k].image) openers[k].active = false;
        }
      }
      openers.length = s;
      i += 1 + consumed;
      continue;
    }

    // Raw HTML and autolinks in angle brackets.
    if (ch === '<') {
      const rest = text.slice(i);
      let m;
      if ((m = AUTOLINK_RE.exec(rest))) {
        flush();
        nodes.push({
          t: 'link', href: m[1], title: null,
          children: [{ t: 'text', raw: m[1] }],
        });
        i += m[0].length;
        continue;
      }
      if ((m = EMAIL_AUTOLINK_RE.exec(rest))) {
        flush();
        nodes.push({
          t: 'link', href: 'mailto:' + m[1], title: null,
          children: [{ t: 'text', raw: m[1] }],
        });
        i += m[0].length;
        continue;
      }
      const tag = matchHtmlTag(text, i);
      if (tag) {
        flush();
        nodes.push({ t: 'html', s: tag });
        if (!inLink && /^<a /i.test(tag)) inLink = true;
        else if (inLink && /^<\/a>/i.test(tag)) inLink = false;
        i += tag.length;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    // Emphasis delimiters.
    if (ch === '*' || ch === '_') {
      let n = 0;
      while (text[i + n] === ch) n += 1;
      const f = flanking(text, i, i + n, ch);
      flush();
      nodes.push({
        t: 'delim', ch, n,
        canOpen: f.canOpen, canClose: f.canClose,
      });
      i += n;
      continue;
    }

    // Strikethrough: tilde runs of one or two become delimiter nodes
    // (paired by processEmphasis); longer runs are literal text.
    if (ch === '~') {
      let n = 0;
      while (text[i + n] === '~') n += 1;
      if (n <= 2) {
        flush();
        const f = flanking(text, i, i + n, '~');
        nodes.push({
          t: 'delim', ch: '~', n,
          canOpen: f.canOpen, canClose: f.canClose,
        });
      } else {
        buf += '~'.repeat(n);
      }
      i += n;
      continue;
    }

    // GFM extended autolinks inside text (suppressed while inLink).
    if (!inLink && (ch === 'w' || ch === 'h' || /[A-Za-z0-9._%+-]/.test(ch))) {
      const prev = i === 0 ? undefined : text[i - 1];
      const auto = matchExtendedAutolink(
        text, i, prev, openers.some((o) => o.active), nodes);
      if (auto) {
        flush();
        nodes.push({
          t: 'link', href: auto.href, title: null, ext: true,
          children: [{ t: 'text', raw: auto.text }],
        });
        i = auto.end;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  processEmphasis(nodes);
  return nodes;
}

// Render a node list to HTML.
function renderInlineNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += renderTextRun(n.raw); break;
      case 'lit': out += escapeTextChar(n.s); break;
      case 'code':
        out += '<code>' + n.s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;') + '</code>';
        break;
      case 'html': out += n.s; break;
      case 'br': out += '<br>'; break;
      case 'delim': out += n.ch.repeat(n.n); break;
      case 'lbracket': out += '['; break;
      case 'limage': out += '!['; break;
      case 'em': out += '<em>' + renderInlineNodes(n.children) + '</em>'; break;
      case 'strong':
        out += '<strong>' + renderInlineNodes(n.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlineNodes(n.children) + '</del>'; break;
      case 'link': {
        out += '<a href="' + hrefAttr(n.href) + '"';
        if (n.title !== null && n.title !== undefined) {
          out += ' title="' + escapeAttrPreservingEntities(n.title) + '"';
        }
        out += '>' + renderInlineNodes(n.children) + '</a>';
        break;
      }
      case 'image': {
        out += '<img src="' + hrefAttr(n.href) + '" alt="' +
          escapeAttrPreservingEntities(n.alt) + '"';
        if (n.title !== null && n.title !== undefined) {
          out += ' title="' + escapeAttrPreservingEntities(n.title) + '"';
        }
        out += '>';
        break;
      }
      default: break;
    }
  }
  return out;
}

function inlineHtml(text, defs) {
  return renderInlineNodes(inlineNodes(text, defs));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderToken(token, defs) {
  switch (token.type) {
    case 'heading':
      return '<h' + token.depth + '>' + inlineHtml(token.text, defs) +
        '</h' + token.depth + '>\n';
    case 'paragraph':
      return '<p>' + inlineHtml(token.text, defs) + '</p>\n';
    case 'code': {
      const cls = token.lang
        ? ' class="language-' + escapeAttrPreservingEntities(token.lang) + '"'
        : '';
      // marked escapes code text fully: & < > and both quote marks.
      const body = token.text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      return '<pre><code' + cls + '>' + body + '</code></pre>\n';
    }
    case 'html':
      return token.text;
    case 'hr':
      return '<hr>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderTokens(token.tokens, defs) +
        '</blockquote>\n';
    case 'list': {
      let out = token.ordered
        ? '<ol' + (token.start !== 1 ? ' start="' + token.start + '"' : '') + '>\n'
        : '<ul>\n';
      for (const item of token.items) {
        out += '<li>' + renderListItem(item, token.loose, defs) + '</li>\n';
      }
      out += token.ordered ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      token.header.forEach((cell, idx) => {
        const align = token.align[idx];
        out += '<th' + (align ? ' align="' + align + '"' : '') + '>' +
          inlineHtml(cell, defs) + '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (token.rows.length > 0) {
        out += '<tbody>';
        for (const row of token.rows) {
          out += '<tr>\n';
          for (let idx = 0; idx < token.header.length; idx += 1) {
            const align = token.align[idx];
            const cell = idx < row.length ? row[idx] : '';
            out += '<td' + (align ? ' align="' + align + '"' : '') + '>' +
              inlineHtml(cell, defs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default:
      return '';
  }
}

function renderListItem(item, loose, defs) {
  let body;
  if (loose) {
    body = renderTokens(item.tokens, defs);
  } else {
    body = '';
    for (const token of item.tokens) {
      if (token.type === 'paragraph') body += inlineHtml(token.text, defs);
      else body += renderToken(token, defs);
    }
  }
  if (item.task) {
    const box = '<input ' + (item.checked ? 'checked="" ' : '') +
      'disabled="" type="checkbox"> ';
    // In a loose item the checkbox goes inside the first paragraph.
    if (loose && body.startsWith('<p>')) {
      body = '<p>' + box + body.slice(3);
    } else {
      body = box + body;
    }
  }
  return body;
}

function renderTokens(tokens, defs) {
  let out = '';
  for (const token of tokens) out += renderToken(token, defs);
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  let src = String(markdown);
  src = src.replace(/\r\n?/g, '\n');
  inLink = false;
  const defs = new Map();
  const tokens = tokenizeBlocks(src, defs);
  return renderTokens(tokens, defs);
}

export default parse;








