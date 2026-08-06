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
      const raw = buf.join('\n');
      if (/^html?$/i.test(lang)) {
        // Live, sandboxed preview — the signature "artifact" experience.
        codeBlocks.push(buildArtifact(raw, idx));
      } else {
        codeBlocks.push(
          `<pre class="code-block" data-lang="${escapeHtml(lang)}"><button class="copy-btn" data-copy="${idx}" type="button">复制</button><code>${escapeHtml(
            raw
          )}</code></pre>`
        );
      }
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

// A live, sandboxed HTML preview. Rendered as a faux browser frame with a
// preview/code toggle. The iframe is sandboxed (scripts allowed, but a unique
// opaque origin so it can never touch the parent page) — safe even when the
// agent hands back untrusted markup.
function buildArtifact(raw, idx) {
  const code = escapeHtml(raw);
  // srcdoc is an HTML attribute: escape quotes and ampersands. `</iframe>`
  // inside it is parsed within the iframe's own document, not the parent, so
  // it cannot break out of the attribute.
  const srcdoc = raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return (
    `<div class="artifact" data-lang="html">` +
      `<div class="artifact-head">` +
        `<span class="artifact-title"><span class="artifact-ico" aria-hidden="true">🌐</span>HTML 实时预览</span>` +
        `<div class="artifact-tabs">` +
          `<button type="button" class="atab on" data-view="preview">预览</button>` +
          `<button type="button" class="atab" data-view="code">代码</button>` +
        `</div>` +
        `<button type="button" class="copy-btn" data-copy="${idx}">复制</button>` +
      `</div>` +
      `<div class="artifact-views">` +
        `<div class="artifact-view preview"><iframe class="artifact-iframe" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${srcdoc}"></iframe></div>` +
        `<div class="artifact-view code hidden"><pre class="code-block" data-lang="html"><code>${code}</code></pre></div>` +
      `</div>` +
    `</div>`
  );
}

