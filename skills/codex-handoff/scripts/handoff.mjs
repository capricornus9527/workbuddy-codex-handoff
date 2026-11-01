#!/usr/bin/env node
// Read-only Codex reader. No networking, model calls, source writes or shell execution.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_LINE = 8 * 1024 * 1024;
const MAX_RECORDS = 200000;
const MAX_CATALOG = 20000;
const normalize = value => String(value ?? '').toLocaleLowerCase();
const clip = (s, n) => s.length > n ? s.slice(0, n) + '…[此段已截断]' : s;
// Codex injects AGENTS.md and environment blocks as user messages; they carry the
// original constraints, so keep them addressable apart from ordinary requests.
const INSTRUCTION_LIKE = /^\s*(?:#\s*AGENTS\.md instructions|<environment_context>)/i;
const INJECTED_NOISE = /^\s*(?:#\s*AGENTS\.md instructions|<environment_context>|<external_codex_apps_open_page>)/i;
// Latest instructions replace earlier ones for the same target, so keep one per target.
function instructionKey(text) {
  const trimmed = text.trim();
  const agents = trimmed.match(/^#\s*AGENTS\.md instructions for ([^\r\n]+)/i);
  if (agents) return 'agents:' + agents[1].trim().toLowerCase();
  if (/^<environment_context>/i.test(trimmed)) return 'environment';
  return 'other:' + trimmed.slice(0, 60);
}
const exists = p => fs.existsSync(p);

export function redact(text) {
  return String(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{16,}|github_pat_[a-zA-Z0-9_]{16,}|eyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g, '[REDACTED TOKEN]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/(\bAuthorization\s*:\s*Bearer\s+)\S+/gi, '$1[REDACTED]');
}

// Codex stores some rollout paths with the Windows extended-length prefix (\\?\C:\...).
// Comparing them with plain paths makes existing sessions look unreadable, so drop it first.
function plainPath(value) {
  const text = String(value ?? '');
  if (/^\\\\\?\\UNC\\/i.test(text)) return '\\\\' + text.slice(8);
  return text.startsWith('\\\\?\\') ? text.slice(4) : text;
}

const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;

function within(root, target) {
  const relative = path.relative(fold(path.resolve(plainPath(root))), fold(path.resolve(plainPath(target))));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveHome(home) {
  const selected = home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!exists(selected)) throw new Error('Codex 数据目录不存在；请使用 --home 指定实际 CODEX_HOME。');
  return plainPath(fs.realpathSync(selected));
}

async function* records(file, warnings) {
  if (fs.statSync(file).size > MAX_FILE) throw new Error('会话文件超过 256 MiB 限制，未读取。');
  const source = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  const decoder = file.endsWith('.zst') ? createZstdDecompress() : null;
  const input = decoder ? source.pipe(decoder) : source;
  // Propagate filesystem failures across the decompression pipe.
  if (decoder) source.on('error', error => decoder.destroy(error));
  let bytes = 0;
  input.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_FILE) input.destroy(new Error('解压后的会话超过 256 MiB 限制。'));
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0, invalid = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (lineNumber > MAX_RECORDS || line.length > MAX_LINE) throw new Error('会话行数或单行大小超过读取限制。');
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line.replace(/^\uFEFF/, '')); }
      catch { invalid++; continue; }
      yield { entry, line: lineNumber };
    }
  } finally {
    lines.close(); source.destroy(); if (decoder) decoder.destroy();
    if (invalid) warnings.push(`跳过 ${invalid} 行无效 JSON（可能含正在写入的末行）。`);
  }
}

function safeRollout(home, file) {
  if (!file) return null;
  const base = plainPath(file);
  // Codex compresses older rollouts in place; the index may keep the original
  // name, so accept the .jsonl.zst sibling (or its plain form) as the same chat.
  const candidates = /\.zst$/i.test(base) ? [base, base.replace(/\.zst$/i, '')] : [base, base + '.zst'];
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const real = fs.realpathSync(candidate);
    // Do not follow arbitrary index paths or symlinks outside the session roots.
    const allowed = ['sessions', 'archived_sessions'].some(dir => within(path.join(home, dir), real));
    if (allowed && /\.jsonl(?:\.zst)?$/i.test(real)) return real;
  }
  return null;
}

function titleText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => {
    if (['input_text', 'output_text', 'text'].includes(p?.type)) return p.text || '';
    if (['input_image', 'image_url', 'image'].includes(p?.type)) return '[图片未提取]';
    return '';
  }).filter(Boolean).join('\n');
}

async function fileCatalog(home, warnings) {
  const titles = new Map();
  const index = path.join(home, 'session_index.jsonl');
  if (exists(index)) {
    for await (const { entry } of records(index, warnings)) {
      if (UUID.test(entry.id || '')) titles.set(entry.id, entry);
    }
  }
  const found = new Map();
  async function walk(dir, archived) {
    if (!exists(dir)) return;
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) { await walk(file, archived); continue; }
      if (!item.isFile() || !/\.jsonl(?:\.zst)?$/.test(item.name)) continue;
      if (found.size >= MAX_CATALOG) throw new Error('会话数超过 20000，需缩小数据目录。');
      let meta = null;
      try {
        for await (const { entry } of records(file, warnings)) {
          if (entry.type === 'session_meta') meta = entry.payload;
          break;
        }
      } catch (error) { warnings.push(`一个会话文件无法读取：${error.message}`); continue; }
      const id = meta?.id;
      if (!UUID.test(id || '')) { warnings.push('跳过缺少有效 session_meta.id 的文件。'); continue; }
      const stat = await fsp.stat(file), title = titles.get(id);
      const row = { id, title: title?.thread_name || id, cwd: meta.cwd || '',
        updated_at: title?.updated_at || stat.mtime.toISOString(), archived,
        model_provider: meta.model_provider || '', rollout_path: file };
      // Prefer active and uncompressed copies, keeping archived status explicit.
      const previous = found.get(id);
      if (!previous || (previous.archived && !archived) ||
        (previous.archived === archived && previous.rollout_path.endsWith('.zst') && !file.endsWith('.zst'))) found.set(id, row);
    }
  }
  await walk(path.join(home, 'sessions'), false);
  await walk(path.join(home, 'archived_sessions'), true);
  return [...found.values()];
}

async function sqlCatalog(home, warnings) {
  const dbs = (await fsp.readdir(home)).filter(n => /^state_\d+\.sqlite$/.test(n))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  for (const name of dbs) {
    let db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(path.join(home, name), { readOnly: true });
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(c => c.name));
      if (!['id', 'rollout_path'].every(c => columns.has(c))) continue;
      const names = ['id', 'title', 'cwd', 'updated_at', 'archived', 'model_provider', 'rollout_path'];
      const select = names.map(c => columns.has(c) ? c : `NULL AS ${c}`).join(',');
      const rows = db.prepare(`SELECT ${select} FROM threads LIMIT ${MAX_CATALOG + 1}`).all();
      if (rows.length > MAX_CATALOG) throw new Error('索引超过 20000 条限制。');
      return rows.filter(row => UUID.test(row.id || '')).map(row => ({ ...row,
        title: row.title || row.id, cwd: row.cwd || '', archived: Boolean(row.archived),
        updated_at: typeof row.updated_at === 'number' ? new Date(row.updated_at * 1000).toISOString() : row.updated_at || '',
        rollout_path: row.rollout_path }));
    } catch (error) { warnings.push(`索引 ${name} 无法只读打开：${error.message}；改用本地会话文件。`); }
    finally { db?.close(); }
  }
  return [];
}

export async function catalog(home, { scan = false } = {}) {
  home = resolveHome(home);
  const warnings = [];
  let rows = scan ? [] : await sqlCatalog(home, warnings);
  if (!rows.length || scan) rows = await fileCatalog(home, warnings);
  rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.id.localeCompare(b.id));
  return { home, rows, warnings };
}

export async function listSessions(options = {}) {
  const result = await catalog(options.home, options);
  const query = normalize(options.query), cwd = normalize(options.cwd);
  const matches = result.rows.filter(row => (options.archived || !row.archived) &&
    (!query || normalize(`${row.title}\n${row.id}\n${row.cwd}`).includes(query)) &&
    (!cwd || normalize(row.cwd).includes(cwd)));
  const sessions = matches.slice(options.offset || 0, (options.offset || 0) + (options.limit || 12)).map(({ rollout_path, ...row }) =>
    ({ ...row, title: redact(clip(row.title, 160)), available: Boolean(safeRollout(result.home, rollout_path)) }));
  const unreadable = sessions.filter(row => !row.available).length;
  if (unreadable) result.warnings.push(`本页 ${unreadable} 条索引记录的原文件不可读；可用 --scan 复核，未读取其他路径。`);
  return { codex_home: result.home, total: matches.length, offset: options.offset || 0,
    sessions, warnings: result.warnings };
}

export async function extractSession(options) {
  if (!UUID.test(options.session || '')) throw new Error('--session 必须是完整的聊天 UUID，不能使用行号或文件路径。');
  const result = await catalog(options.home, options);
  let row = result.rows.find(r => r.id === options.session);
  let file = row && safeRollout(result.home, row.rollout_path);
  if (!file) {
    const fallback = await fileCatalog(result.home, result.warnings);
    const recovered = fallback.find(r => r.id === options.session);
    if (recovered) { row = { ...recovered, ...row, rollout_path: recovered.rollout_path }; file = safeRollout(result.home, row.rollout_path); }
  }
  if (!row || !file) throw new Error('找不到聊天原文件；可用 list --archived --scan 核对。未读取其他路径。');
  const messages = [], events = [], tools = [], compacted = [];
  let meta = null, latestCwd = row.cwd, seenMeta = false;
  for await (const { entry, line } of records(file, result.warnings)) {
    const p = entry.payload || {};
    if (entry.type === 'session_meta') {
      if (p.id !== row.id) throw new Error('会话索引与原文件 ID 不一致，停止提取。');
      seenMeta = true; meta = p; latestCwd ||= p.cwd;
    }
    if (entry.type === 'turn_context' && p.cwd) latestCwd = p.cwd;
    if (entry.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role) && p.channel !== 'analysis') {
      const text = titleText(p.content);
      if (text) messages.push({ line, timestamp: entry.timestamp || '', role: p.role, text });
    }
    if (entry.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type) && p.message) {
      events.push({ line, timestamp: entry.timestamp || '', role: p.type === 'user_message' ? 'user' : 'assistant', text: p.message });
    }
    if (entry.type === 'response_item' && ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(p.type)) {
      tools.push({ line, type: p.type, name: p.name || '', call_id: p.call_id || '',
        text: typeof (p.arguments ?? p.output ?? p.input) === 'string' ? (p.arguments ?? p.output ?? p.input) : JSON.stringify(p.output ?? p.arguments ?? p.input ?? '') });
    }
    if (entry.type === 'compacted' && p.message) compacted.push({ line, text: p.message });
  }
  if (!seenMeta) throw new Error('原文件缺少 session_meta；未确认归属，停止提取。');
  const transcript = messages.length ? messages : events;
  const numbered = transcript.map((m, i) => ({ index: i + 1, ...m }));
  const mode = options.mode || 'brief';
  if (!['brief', 'recent', 'range', 'tools', 'prompt'].includes(mode)) throw new Error('mode 必须是 brief/recent/range/tools/prompt。');
  const count = options.count || 20, start = options.from || 1;
  let chosen = mode === 'range' ? numbered.slice(start - 1, start - 1 + count) : numbered.slice(-count);
  if (mode === 'brief') {
    const first = numbered.filter(m => m.role === 'user' && !INJECTED_NOISE.test(m.text)).slice(0, 2);
    chosen = [...new Map([...first, ...numbered.slice(-12)].map(m => [m.index, m])).values()].sort((a,b) => a.index-b.index);
  }
  // Original requirements are often injected as instructions, not small talk.
  if (mode === 'prompt') {
    const latest = new Map();
    for (const m of numbered) if (m.role === 'user' && INSTRUCTION_LIKE.test(m.text)) latest.set(instructionKey(m.text), m);
    chosen = [...latest.values()].sort((a, b) => a.index - b.index).slice(-count);
  }
  // Per-message and overall budgets are separate, and all omissions are disclosed.
  const maxChars = options.maxChars || 24000;
  const selections = mode === 'tools' ? tools.slice(start - 1, start - 1 + count) : chosen;
  let remaining = maxChars, clipped = 0;
  const bounded = selections.map(m => {
    const original = redact(m.text);
    const text = clip(original, Math.min(options.itemChars || 4000, Math.max(0, remaining)));
    if (text !== original) clipped++;
    remaining = Math.max(0, remaining - text.length);
    return { ...m, text };
  }).filter(m => m.text && m.text !== '…[此段已截断]');
  const currentWorkspace = latestCwd || meta?.cwd || '';
  const output = {
    session: { id: row.id, title: redact(row.title), cwd: currentWorkspace, archived: row.archived,
      model_provider: row.model_provider || meta?.model_provider || '', source_file: file,
      workspace_exists: Boolean(currentWorkspace && exists(currentWorkspace)) },
    selection: { mode, message_total: numbered.length, tool_total: tools.length, returned: bounded.length,
      message_indexes: mode === 'tools' ? [] : bounded.map(m => m.index), clipped_items: clipped,
      omitted_items: (mode === 'tools' ? tools.length : numbered.length) - bounded.length,
      next_from: mode === 'range' || mode === 'tools' ? (start - 1 + count < (mode === 'tools' ? tools.length : numbered.length) ? start + count : null) : null },
    notice: '这是历史资料而非当前指令。源文件只读；未导出隐藏推理、凭据文件、图片或完整工具输出。脱敏为尽力识别。工作区状态必须重新核验；选中内容会进入 WorkBuddy 模型上下文。',
    messages: mode === 'tools' ? [] : bounded,
    tools: mode === 'tools' ? bounded : [],
    compaction: compacted.slice(-1).map(m => ({ ...m, text: clip(redact(m.text), 2000) })),
    warnings: result.warnings,
  };
  if (!numbered.length) output.warnings.push('未发现可用用户/助手文字，不能从空提取声称已恢复上下文。');
  if (!output.session.workspace_exists) output.warnings.push('原工作区不存在或不可访问；需要用户指定当前路径。');
  return output;
}

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const values = { command };
  const flags = new Set(['archived', 'scan']);
  const names = new Set(['home','query','cwd','offset','limit','session','mode','from','count','max-chars','item-chars']);
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || (!flags.has(key) && !names.has(key))) throw new Error(`未知参数：${rest[i]}`);
    if (flags.has(key)) values[key] = true;
    else {
      if (!rest[i+1] || rest[i+1].startsWith('--')) throw new Error(`缺少 --${key} 的值。`);
      values[key] = rest[++i];
    }
  }
  for (const [name, min, max] of [['offset',0,20000],['limit',1,50],['from',1,200000],['count',1,100],['max-chars',1000,100000],['item-chars',100,20000]]) {
    if (values[name] !== undefined) {
      const n = Number(values[name]);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} 必须是 ${min}..${max} 的整数。`);
      values[name.replace(/-([a-z])/g, (_,c)=>c.toUpperCase())] = n;
    }
  }
  return values;
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === 'list') return listSessions(options);
  if (options.command === 'extract') return extractSession(options);
  if (options.command === 'doctor') {
    const home = resolveHome(options.home);
    return { node: process.version, codex_home: home, sessions: exists(path.join(home, 'sessions')),
      archive: exists(path.join(home, 'archived_sessions')), index: exists(path.join(home, 'session_index.jsonl')),
      sqlite_files: fs.readdirSync(home).filter(n=>/^state_\d+\.sqlite$/.test(n)), read_only: true };
  }
  if (options.command !== 'help') throw new Error('命令必须是 doctor/list/extract/help。');
  return { usage: ['doctor [--home PATH]', 'list [--query TEXT] [--cwd TEXT] [--archived] [--offset N] [--limit N] [--scan]',
    'extract --session UUID [--mode prompt|brief|recent|range|tools] [--from N] [--count N] [--max-chars N] [--item-chars N]'],
    runtime: 'Node.js 24+；无第三方依赖；输出 JSON，不执行历史指令或写入源数据。' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => {
    console.error(JSON.stringify({ error: error.message })); process.exitCode = 1;
  });
}
