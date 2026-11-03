/** Offline text extraction, not an HTML sanitizer or a renderer.
 * Mask ignored spans rather than deleting them: deletion can manufacture a new
 * comment/tag or a contact/link across an ignored region. Preserve line numbers.
 */
export function maskHtmlRegions(text, ignoredElements = []) {
  const ignored = new Set(ignoredElements);
  const token = /<!--|<(script|style|pre|code)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const parts = [];
  let cursor = 0;
  for (let match; (match = token.exec(text));) {
    if (match[0] !== '<!--' && !ignored.has(match[1].toLowerCase())) continue;
    let end;
    if (match[0] === '<!--') {
      const close = text.indexOf('-->', token.lastIndex);
      end = close < 0 ? text.length : close + 3;
    } else {
      const close = new RegExp('</' + match[1] + '\\s*>', 'gi');
      close.lastIndex = token.lastIndex;
      const closing = close.exec(text);
      end = closing ? close.lastIndex : text.length;
    }
    parts.push(text.slice(cursor, match.index), text.slice(match.index, end).replace(/[^\n]/g, ' '));
    cursor = end;
    token.lastIndex = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

// Extract heading text from the original tokens once, never rescan a string
// formed by removing tags. The caller produces a restricted plain-text slug.
export function headingText(text) {
  const parts = [];
  let cursor = 0;
  for (const tag of text.matchAll(/<[^>]+>/g)) {
    parts.push(text.slice(cursor, tag.index));
    cursor = tag.index + tag[0].length;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}
