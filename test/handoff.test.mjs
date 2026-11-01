import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { extractSession, listSessions, parseArgs, redact } from '../skills/codex-handoff/scripts/handoff.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';
const key = 'sk-' + 'synthetic-not-a-real-token-1234567890';
const line = (type, payload) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type, payload });
const message = (role, text) => line('response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });

function fixture(t, { compressed = false, archived = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-handoff-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const folder = path.join(home, archived ? 'archived_sessions' : 'sessions', '2026', '01');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `rollout-${ID}.jsonl${compressed ? '.zst' : ''}`);
  const content = [line('session_meta', { id: ID, cwd: home, model_provider: 'fixture' }),
    line('response_item', { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'SYSTEM HIDDEN' }] }),
    line('response_item', { type: 'reasoning', content: 'REASONING HIDDEN' }),
    message('user', '修复合成项目，保留现有改动。'),
    line('event_msg', { type: 'user_message', message: '修复合成项目，保留现有改动。' }),
    message('assistant', '已定位问题，尚未验证。'),
    line('response_item', { type: 'function_call', name: 'check', call_id: 'call_1', arguments: '{"target":"fixture"}' }),
    line('response_item', { type: 'function_call_output', call_id: 'call_1', output: 'fixture passed' }),
    message('user', `范围已缩小。api_key=${key}`),
    message('assistant', '下一步检查当前工作区。'), '{unfinished'].join('\n');
  fs.writeFileSync(file, compressed ? zstdCompressSync(Buffer.from(content)) : content);
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: ID, thread_name: '合成聊天标题', updated_at: '2026-01-02T00:00:00Z' }) + '\n');
  return { home, file };
}

test('scan lists Chinese titles and workspace without transcript or credentials', async t => {
  const { home } = fixture(t);
  const result = await listSessions({ home, query: '合成', scan: true });
  assert.equal(result.total, 1); assert.equal(result.sessions[0].title, '合成聊天标题');
  assert.equal(result.sessions[0].model_provider, 'fixture');
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal((await listSessions({ home, cwd: 'not-this-project', scan: true })).total, 0);
});

test('only user/assistant text; event duplicate, reasoning and system excluded', async t => {
  const { home, file } = fixture(t);
  const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const result = await extractSession({ home, session: ID });
  assert.equal(result.selection.message_total, 4); assert.equal(result.selection.tool_total, 2);
  assert.equal(result.messages.length, 4); assert.equal(result.tools.length, 0);
  assert.match(result.messages[2].text, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(result), /REASONING HIDDEN|SYSTEM HIDDEN/);
  assert.match(result.warnings.join(' '), /无效 JSON/);
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before);
});

test('range pagination and explicit tool output retain provenance', async t => {
  const { home } = fixture(t);
  const result = await extractSession({ home, session: ID, mode: 'range', from: 2, count: 2 });
  assert.deepEqual(result.selection.message_indexes, [2, 3]);
  assert.equal(result.selection.next_from, 4); assert.equal(result.messages[0].line, 6);
  const tools = await extractSession({ home, session: ID, mode: 'tools', count: 1 });
  assert.equal(tools.tools[0].call_id, 'call_1'); assert.equal(tools.selection.next_from, 2);
});

test('zstd archived sessions are selectable but hidden from default listing', async t => {
  const { home } = fixture(t, { compressed: true, archived: true });
  assert.equal((await listSessions({ home })).total, 0);
  assert.equal((await listSessions({ home, archived: true })).total, 1);
  const result = await extractSession({ home, session: ID });
  assert.equal(result.session.archived, true); assert.equal(result.messages.length, 4);
});

test('SQLite metadata is used without filtering providers; stale rollout recovered', async t => {
  const { home } = fixture(t);
  const db = new DatabaseSync(path.join(home, 'state_99.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, archived INTEGER, model_provider TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(ID, '索引标题', home, 1000, 0, 'other-provider', path.join(home, 'missing.jsonl'));
  db.close();
  const result = await listSessions({ home });
  assert.equal(result.sessions[0].title, '索引标题'); assert.equal(result.sessions[0].model_provider, 'other-provider');
  assert.equal(result.sessions[0].available, false);
  assert.equal((await extractSession({ home, session: ID })).messages.length, 4);
});

test('corrupt SQLite falls back with a warning', async t => {
  const { home } = fixture(t);
  fs.writeFileSync(path.join(home, 'state_99.sqlite'), 'not sqlite');
  const result = await listSessions({ home });
  assert.equal(result.total, 1); assert.match(result.warnings.join(' '), /只读打开/);
});

test('reject mismatched session identity and arbitrary session paths', async t => {
  const { home, file } = fixture(t);
  await assert.rejects(extractSession({ home, session: '../../auth.json' }), /UUID/);
  fs.writeFileSync(file, line('session_meta', { id: OLD, cwd: home }));
  const db = new DatabaseSync(path.join(home, 'state_1.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(ID, file); db.close();
  await assert.rejects(extractSession({ home, session: ID }), /ID 不一致/);
});

test('database cannot redirect reader outside sessions', async t => {
  const { home } = fixture(t);
  const outside = path.join(home, 'auth.jsonl');
  fs.writeFileSync(outside, line('session_meta', { id: OLD }) + '\n' + message('user', 'DO NOT READ'));
  const db = new DatabaseSync(path.join(home, 'state_1.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(OLD, outside); db.close();
  await assert.rejects(extractSession({ home, session: OLD }), /找不到聊天原文件/);
});

test('output budgets expose clipping without losing selection accounting', async t => {
  const { home, file } = fixture(t);
  fs.appendFileSync(file, '\n' + message('assistant', '长'.repeat(15000)));
  const result = await extractSession({ home, session: ID, maxChars: 1000, itemChars: 20000 });
  assert.ok(result.selection.clipped_items > 0);
  assert.ok(result.messages.reduce((n,m)=>n+m.text.length, 0) < 1200);
});

test('event-only legacy transcript, missing workspace and image marker', async t => {
  const { home, file } = fixture(t);
  fs.writeFileSync(file, [line('session_meta', { id: ID, cwd: path.join(home, 'deleted') }),
    line('event_msg', { type: 'user_message', message: 'legacy task' }),
    line('event_msg', { type: 'agent_message', message: 'legacy reply' })].join('\n'));
  const legacy = await extractSession({ home, session: ID });
  assert.equal(legacy.messages.length, 2); assert.equal(legacy.session.workspace_exists, false);
  fs.appendFileSync(file, '\n' + line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:private' }] }));
  assert.match((await extractSession({ home, session: ID })).messages[0].text, /图片未提取/);
});

test('bounds, unknown flags and missing argument are rejected', () => {
  for (const args of [['list','--limit','-1'], ['extract','--count','1.2'], ['list','--query'], ['list','--surprise'], ['list','--offset','NaN']]) assert.throws(()=>parseArgs(args));
  assert.equal(parseArgs(['extract','--max-chars','1000']).maxChars, 1000);
});

test('best-effort redaction covers common bearer, JWT and private key patterns', () => {
  const text = `Authorization: Bearer test-only-token\npassword="synthetic"\n${key}\neyJ${'a'.repeat(20)}.bbb.ccc\n-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----`;
  const result = redact(text);
  assert.doesNotMatch(result, /test-only-token|synthetic|FAKE|eyJa/);
});

test('malformed zstd rejects rather than silently producing empty context', async t => {
  const { home, file } = fixture(t, { compressed: true });
  const db = new DatabaseSync(path.join(home, 'state_1.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(ID, file); db.close();
  fs.writeFileSync(file, 'not a zstd stream');
  await assert.rejects(extractSession({ home, session: ID }));
});

test('brief preserves early actual goal and excludes assistant analysis channel', async t => {
  const { home, file } = fixture(t);
  const rows = [line('session_meta', { id: ID, cwd: home }), message('user', '# AGENTS.md instructions for fixture'),
    message('user', '实际原目标'), line('response_item', { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE ANALYSIS' }] })];
  for (let i=0; i<30; i++) rows.push(message(i%2 ? 'assistant' : 'user', `later ${i}`));
  fs.writeFileSync(file, rows.join('\n'));
  const result = await extractSession({ home, session: ID });
  assert.ok(result.messages.some(m=>m.text === '实际原目标'));
  assert.ok(result.selection.omitted_items > 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE ANALYSIS/);
});
