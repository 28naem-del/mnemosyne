/** Offline text extraction, NOT HTML sanitization or a rendering API.
 * Link/contact checks mask ignored bytes to keep boundaries and line numbers.
 * Heading callers may omit genuine comments to preserve the existing plain-text
 * slug contract; those strings must never be used as rendered HTML.
 */
function mask(text) { return text.replace(/[^\n]/g, ' '); }

function fencedCode(text) {
  const ranges = new Map();
  let fence, start, offset = 0;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        ranges.set(start, offset + line.length);
        fence = undefined;
      }
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = marker[1]; start = offset;
    }
    offset += line.length + 1;
  }
  if (fence) ranges.set(start, text.length);
  return ranges;
}

// Index exact backtick runs once. An unmatched run cannot repeatedly rescan a
// long suffix. Inline spans may cross soft line breaks, not paragraph/fence boundaries.
function inlineClosers(text) {
  const next = new Map(), last = new Map();
  const runs = [...text.matchAll(/`+/g)];
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i], closing = last.get(run[0].length);
    if (closing !== undefined) next.set(run.index, closing);
    last.set(run[0].length, run.index);
  }
  return next;
}

function* tokens(text, markdown, ignored = new Set()) {
  const fences = markdown ? fencedCode(text) : new Map();
  const closers = markdown ? inlineClosers(text) : new Map();
  const opener = /<\/?([a-z][^\s/<>]*)(?=[\s/>])/iy;
  const boundaries = markdown ? [...text.matchAll(/\n[ \t]*\n/g)].map(match => match.index).concat([...fences.keys()]).sort((a, b) => a - b) : [];
  let boundary = 0;
  for (let i = 0; i < text.length;) {
    while (boundary < boundaries.length && boundaries[boundary] <= i) boundary++;
    if (fences.has(i)) {
      const end = fences.get(i);
      yield { kind: 'fence', start: i, end };
      i = end; continue;
    }
    if (markdown && text[i] === '\\') { i += 2; continue; }
    if (markdown && text[i] === '`') {
      let end = i + 1;
      while (text[end] === '`') end++;
      const close = closers.get(i);
      if (close !== undefined && close < (boundaries[boundary] ?? text.length)) {
        end = close + end - i;
        yield { kind: 'inline', start: i, end };
      }
      i = end; continue;
    }
    if (text[i] !== '<') { i++; continue; }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4), end = close < 0 ? text.length : close + 3;
      yield { kind: 'comment', start: i, end };
      i = end; continue;
    }
    opener.lastIndex = i;
    const opening = opener.exec(text);
    if (!opening) { i++; continue; }
    let j = opener.lastIndex, quote, complete = false;
    for (; j < text.length; j++) {
      const c = text[j];
      if (quote) { if (c === quote) quote = undefined; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') { j++; complete = true; break; }
      else if (c === '<') break;
    }
    // Consume the whole ordinary tag before inspecting any apparent comment,
    // backtick or raw-element opener within its quoted attribute values.
    const name = opening[1].toLowerCase(), closing = text[i + 1] === '/';
    let kind = 'tag';
    if (complete && !closing && ignored.has(name)) {
      const close = new RegExp('</' + name + '\\s*>', 'gi');
      close.lastIndex = j;
      j = close.exec(text) ? close.lastIndex : text.length;
      kind = 'ignored';
    }
    yield { kind, start: i, end: j, name, closing, complete };
    i = j;
  }
}

export function maskHtmlRegions(text, ignoredElements = [], { markdown = false, comments = 'mask', inlineCode = 'keep' } = {}) {
  const ignored = new Set(ignoredElements), parts = [];
  let cursor = 0;
  for (const token of tokens(text, markdown, ignored)) {
    let end = token.end, replacement;
    if (token.kind === 'comment') {
      replacement = comments === 'omit' ? text.slice(token.start, end).replace(/[^\n]/g, '') : mask(text.slice(token.start, end));
    } else if (token.kind === 'fence' || (token.kind === 'inline' && inlineCode === 'mask')) {
      replacement = mask(text.slice(token.start, end));
    } else if (token.kind === 'ignored') {
      replacement = mask(text.slice(token.start, end));
    } else continue;
    parts.push(text.slice(cursor, token.start), replacement);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function headingText(text) {
  const parts = [];
  let cursor = 0;
  for (const token of tokens(text, true)) {
    if (token.kind !== 'tag' && token.kind !== 'comment') continue;
    parts.push(text.slice(cursor, token.start));
    if (token.kind === 'comment') parts.push(text.slice(token.start, token.end).replace(/[^\n]/g, ''));
    cursor = token.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}
