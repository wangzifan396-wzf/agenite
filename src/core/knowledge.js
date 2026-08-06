// Local knowledge base (RAG) backed by SQLite FTS5 — zero dependencies, fully
// offline. Documents are chunked and indexed for full-text retrieval with
// BM25 ranking. Everything stays on the user's machine: no network, no
// external embedding service, no API key.
//
// Why FTS5 `trigram`? The default `unicode61` tokenizer treats a run of CJK
// characters as a single token, so substring queries like "知识库" never match.
// `trigram` indexes every 3-character window, giving reliable substring (and
// therefore CJK) retrieval — verified against the bundled SQLite build.
import { DatabaseSync } from 'node:sqlite';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

// Plain-text file types we can ingest directly (no parser dependency).
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.json', '.jsonl', '.csv', '.tsv',
  '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go',
  '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh',
  '.bash', '.ps1', '.sql', '.html', '.htm', '.xml', '.svg', '.tex',
  '.rst', '.adoc', '.txt'
]);

// Split text into retrieval-friendly chunks (~`size` chars, `overlap` carry).
// Paragraph-aware: we accumulate whole paragraphs and only break when the
// buffer would overflow, then carry the tail into the next chunk so context
// isn't sliced mid-thought. Oversized single paragraphs are hard-split.
export function chunkText(text, size = 900, overlap = 150) {
  const norm = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!norm) return [];
  const paras = norm.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (buf && buf.length + p.length + 1 > size) {
      chunks.push(buf.trim());
      buf = buf.slice(Math.max(0, buf.length - overlap)) + '\n' + p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  const out = [];
  for (const c of chunks) {
    if (c.length <= size) out.push(c);
    else for (let i = 0; i < c.length; i += size - overlap) {
      const slice = c.slice(i, i + size).trim();
      if (slice) out.push(slice);
    }
  }
  return out.filter((c) => c.length >= 12);
}

// Turn a user query into a safe FTS5 MATCH string for the trigram tokenizer.
// Strip FTS5 syntax characters, keep letters/digits/CJK/spaces, collapse
// whitespace. Trigram needs >=3 chars or it matches nothing, so short queries
// return '' (caller treats that as "no retrieval").
export function cleanFtsQuery(q) {
  const cleaned = String(q || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 3 ? cleaned : '';
}

// Open (creating if needed) a knowledge base at `dbPath`.
export function createKnowledge(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      mtime INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, doc_id UNINDEXED, tokenize='trigram'
    );
  `);

  function ingestText({ title, text, source, kind = 'text' }) {
    const chunks = chunkText(text);
    if (!chunks.length) return null;
    const now = Date.now();
    const insDoc = db.prepare(
      'INSERT INTO docs (source, title, kind, mtime, chunk_count) VALUES (?, ?, ?, ?, ?)'
    );
    const res = insDoc.run(source || title || 'untitled', title || 'untitled', kind, now, chunks.length);
    const docId = Number(res.lastInsertRowid);
    const insChunk = db.prepare('INSERT INTO chunks_fts (text, doc_id) VALUES (?, ?)');
    for (const c of chunks) insChunk.run(c, docId);
    return { id: docId, title: title || 'untitled', kind, chunks: chunks.length };
  }

  async function ingestFile(absPath, { title } = {}) {
    const ext = extname(absPath).toLowerCase();
    if (!TEXT_EXTS.has(ext)) {
      throw new Error(`不支持的文件类型：${ext || '(无扩展名)'}，仅支持纯文本类文件`);
    }
    const st = await stat(absPath);
    const text = await readFile(absPath, 'utf8');
    const name = title || absPath.split(/[\\/]/).pop();
    return ingestText({ title: name, text, source: absPath, kind: 'file' });
  }

  function ingestUrl({ url, text, title }) {
    if (!url || !text) throw new Error('ingestUrl 需要 url 与 text');
    return ingestText({ title: title || url, text, source: url, kind: 'url' });
  }

  // Top-k retrieval. Returns chunks joined with their document title/source.
  function retrieve(query, k = 5) {
    const q = cleanFtsQuery(query);
    if (!q) return [];
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT chunks_fts.text AS chunk, docs.title AS title, docs.source AS source,
                  docs.kind AS kind, bm25(chunks_fts) AS rank
           FROM chunks_fts
           JOIN docs ON docs.id = chunks_fts.doc_id
           WHERE chunks_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(q, Math.max(1, k | 0));
    } catch {
      // Malformed query (shouldn't happen after cleanFtsQuery) — fail safe.
      return [];
    }
    return rows.map((r) => ({
      title: r.title,
      source: r.source,
      kind: r.kind,
      text: r.chunk,
      score: r.rank
    }));
  }

  function listDocs() {
    return db
      .prepare('SELECT id, source, title, kind, mtime, chunk_count FROM docs ORDER BY id DESC')
      .all();
  }

  function removeDoc(id) {
    db.prepare('DELETE FROM chunks_fts WHERE doc_id = ?').run(id);
    db.prepare('DELETE FROM docs WHERE id = ?').run(id);
  }

  function clear() {
    db.prepare('DELETE FROM chunks_fts').run();
    db.prepare('DELETE FROM docs').run();
    try { db.exec('VACUUM'); } catch { /* best-effort */ }
  }

  function stats() {
    const d = db.prepare('SELECT COUNT(*) AS n FROM docs').get();
    const c = db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get();
    return { docs: d.n, chunks: c.n };
  }

  function close() {
    try { db.close(); } catch { /* ignore */ }
  }

  return { ingestText, ingestFile, ingestUrl, retrieve, listDocs, removeDoc, clear, stats, close, _db: db };
}
