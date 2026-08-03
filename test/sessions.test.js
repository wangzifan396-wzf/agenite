// Session mirroring. The whole point is that history survives things the
// browser cannot survive, so the failure modes worth testing are the hostile
// ones: crafted ids, corrupt files, and conversations too big to store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeSessionId, listSessions, readSession, writeSession, deleteSession, searchSessionsForLabel } from '../src/core/sessions.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'agenite-sessions-'));
}

test('safeSessionId strips anything that could escape the folder', () => {
  assert.equal(safeSessionId('conv_abc123'), 'conv_abc123');
  assert.equal(safeSessionId('../../etc/passwd'), 'etcpasswd');
  assert.equal(safeSessionId('a/b\\c'), 'abc');
  assert.equal(safeSessionId(''), '');
  assert.equal(safeSessionId(null), '');
  assert.ok(safeSessionId('x'.repeat(500)).length <= 64);
});

test('write then read round-trips a conversation', async () => {
  const dir = await tempDir();
  try {
    const conv = {
      id: 'conv_round',
      title: '测试会话',
      updatedAt: 1700000000000,
      messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }]
    };
    await writeSession(conv, dir);
    const back = await readSession('conv_round', dir);
    assert.equal(back.id, 'conv_round');
    assert.equal(back.title, '测试会话');
    assert.equal(back.messages.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listSessions returns a newest-first index', async () => {
  const dir = await tempDir();
  try {
    await writeSession({ id: 'old', title: '旧', updatedAt: 1000, messages: [{ role: 'user', content: 'a' }] }, dir);
    await writeSession({ id: 'new', title: '新', updatedAt: 9000, messages: [{ role: 'user', content: 'b' }] }, dir);
    const list = await listSessions(dir);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'new', 'most recently updated first');
    assert.equal(list[0].count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt file is skipped instead of breaking the whole list', async () => {
  const dir = await tempDir();
  try {
    await writeSession({ id: 'good', title: 'ok', updatedAt: 5, messages: [] }, dir);
    await writeFile(join(dir, 'broken.json'), '{ this is not json', 'utf8');
    const list = await listSessions(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'good');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reading a missing or unsafe id returns null rather than throwing', async () => {
  const dir = await tempDir();
  try {
    assert.equal(await readSession('nope', dir), null);
    assert.equal(await readSession('../../secret', dir), null);
    assert.equal(await readSession('', dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an oversized conversation is truncated, not rejected', async () => {
  const dir = await tempDir();
  try {
    const messages = [];
    for (let i = 0; i < 400; i++) messages.push({ role: 'user', content: 'x'.repeat(20000) });
    const res = await writeSession({ id: 'huge', title: '大会话', updatedAt: 1, messages }, dir);
    assert.ok(res, 'write succeeded');
    const back = await readSession('huge', dir);
    assert.ok(back.messages.length < 400, 'older messages were dropped to fit');
    assert.ok(back.messages.length > 0, 'but the recent tail is kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleteSession removes the file and is safe to repeat', async () => {
  const dir = await tempDir();
  try {
    await writeSession({ id: 'gone', title: 'x', updatedAt: 1, messages: [] }, dir);
    assert.equal(await deleteSession('gone', dir), true);
    assert.equal((await readdir(dir)).length, 0);
    assert.equal(await deleteSession('gone', dir), false, 'deleting twice is not an error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('searchSessionsForLabel finds an entity across sessions with context', () => {
  const sessions = [
    { id: 's1', title: '关于 Agenite', updatedAt: 100, messages: [
      { role: 'user', content: '我们聊聊 Agenite 这个项目' },
      { role: 'assistant', content: 'Agenite 是个本地智能体' }
    ] },
    { id: 's2', title: '别的', updatedAt: 200, messages: [{ role: 'user', content: '今天天气不错' }] }
  ];
  const hits = searchSessionsForLabel(sessions, 'Agenite', { limit: 12, ctx: 40 });
  assert.ok(hits.length >= 1, 'found at least one match');
  assert.ok(hits.every((h) => h.sessionId === 's1'), 'matches come from the right session');
  assert.ok(hits[0].snippet.includes('Agenite'), 'snippet contains the entity');
  assert.ok(hits[0].snippet.length > 'Agenite'.length, 'snippet carries surrounding context');
});

test('searchSessionsForLabel is case-insensitive and empty when absent', () => {
  const sessions = [{ id: 's', title: 't', updatedAt: 1, messages: [{ role: 'user', content: 'Xyz 项目' }] }];
  assert.equal(searchSessionsForLabel(sessions, 'xyz').length, 1, 'case-insensitive');
  assert.deepEqual(searchSessionsForLabel(sessions, ''), [], 'empty query -> no matches');
  assert.deepEqual(searchSessionsForLabel(sessions, 'missing'), [], 'no match -> empty');
});

test('searchSessionsForLabel respects the limit', () => {
  const messages = [];
  for (let i = 0; i < 20; i++) messages.push({ role: 'user', content: '提到 Foobar 第 ' + i + ' 次' });
  const sessions = [{ id: 's', title: 't', updatedAt: 1, messages }];
  assert.equal(searchSessionsForLabel(sessions, 'Foobar', { limit: 5 }).length, 5);
});
