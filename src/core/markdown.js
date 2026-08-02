// Minimal, XSS-safe Markdown renderer that returns an HTML string.
// Block-level: headings, fenced code, blockquote, hr, ul/ol, paragraphs.
// Inline: code, bold, italic, strike, links. Everything is HTML-escaped.
import { escapeHtml, sanitizeUrl } from './util.js';

export function renderMarkdown(src) {
  if (src == null) return '';
  const text = String(src).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  // Fenced code blocks first (protect from inline parsing).
  const codeBlocks = [];

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const idx = codeBlocks.length;
      codeBlocks.push(
        `<pre class="code-block" data-lang="${escapeHtml(lang)}"><button class="copy-btn" data-copy="${idx}" type="button">复制</button><code>${escapeHtml(
          buf.join('\n')
        )}</code></pre>`
      );
      out.push(`\u0000CODE${idx}\u0000`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // hr
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push(`<ul>${buf.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${buf.map((b) => `<li>${inline(b)}</li>`).join('')}</ol>`);
      continue;
    }

    // blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // paragraph (gather until blank line)
    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|>|```|\s*[-*+]\s|\s*\d+\.\s|---|\*\*\*|___)\s*$/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join('\n'))}</p>`);
  }

  let html = out.join('\n');
  // restore code blocks
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, n) => codeBlocks[Number(n)]);
  return html;
}

function inline(text) {
  // protect inline code first
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    const idx = codes.length;
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0001${idx}\u0001`;
  });

  // escape everything else (XSS safe) before we re-introduce our own tags
  s = escapeHtml(s);

  // links [text](url)  (label is already escaped; url is sanitized)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const safe = sanitizeUrl(url);
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // bold, italic, strike  (these chars survive escaping)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // newline -> <br>
  s = s.replace(/\n/g, '<br>');

  // restore inline code
  s = s.replace(/\u0001(\d+)\u0001/g, (_, n) => codes[Number(n)]);
  return s;
}
