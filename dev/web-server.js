/**
 * 動作確認用: web/ の画面（Supabase 版）を、手元の PostgreSQL（PGlite）につないで表示する。
 * データベースの中身は supabase/migrations の SQL そのもの（本番と同じ）。本番の Supabase には接続しない。
 * node dev/web-server.js [ポート]
 * - ログインは試験用（パスワード test-pass-1234）
 * - リアルタイム通知は、同期番号が変わったら知らせる形でまねする
 * - メール送信用 GAS の代わりに、テスト送信を「送ったこと」にする
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createDb, TEST_EMAIL } = require('./pg-db');

const port = Number(process.argv[2] || process.env.PORT || 8090);
const WEB = path.join(__dirname, '..', 'web');
const TEST_PASSWORD = 'test-pass-1234';
const accounts = {};
const ready = createDb();
const reportLib = import('../supabase/functions/mail/report.ts');

const FAKE = `<script>
window.HONBU_BACKEND = (function () {
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.text().then(t => { if (!r.ok) throw new Error(t); return t ? JSON.parse(t) : null; }));
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem('fake-session') || 'null'); } catch (e) { session = null; }
  return {
    async session() { return session; },
    async signIn(email, pw) { await post('/fake/login', { email: email, pw: pw }); session = { email: email }; sessionStorage.setItem('fake-session', JSON.stringify(session)); },
    async signOut() { session = null; sessionStorage.removeItem('fake-session'); },
    onSignedOut() {},
    setupAccount(email, pw) { return post('/fake/setup', { email: email, pw: pw }); },
    rpc(name, p) { return post('/rpc', { name: name, payload: p }); },
    preview(summary) { return post('/fake/preview', { summary: !!summary }); },
    subscribe(onChange, onStatus) {
      let last = null;
      const t = setInterval(() => fetch('/fake/rev').then(r => r.text()).then(v => { if (last !== null && v !== last) onChange(); last = v; }).catch(() => {}), 700);
      setTimeout(() => onStatus('SUBSCRIBED'), 50);
      return () => clearInterval(t);
    },
  };
})();
</script>`;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.html': 'text/html' };

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
  });
}
function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': (type || 'text/plain') + '; charset=utf-8' });
  res.end(body);
}

// メールの中身（本物の Edge Function と同じ作り方）
async function preview(d, summary) {
  const R = await reportLib;
  const state = async k => ((await d.sql('select value from public.app_state where key = $1', [k]))[0] || {}).value || '';
  const now = new Date();
  const win = R.reportWindow(now, await state('mail_at'), summary);
  const cfg = R.mergeConfig((await d.sql('select public._config() as c'))[0].c);
  const recent = new Date(now.getTime() - 8 * 86400000).toISOString();
  const rep = R.buildReport({
    now, since: win.since, hasPrev: win.hasPrev, summary, cfg,
    members: await d.sql('select * from public.members'),
    lists: await d.sql('select * from public.lists where deleted_at is null'),
    tasks: await d.sql("select * from public.tasks where deleted_at is null and parent_id is null and (status <> 'done' or completed_at >= $1 or created_at >= $1)", [recent]),
    noteTaskIds: (await d.sql('select task_id from public.task_notes where created_at >= $1', [win.since])).map(r => r.task_id),
    url: 'http://localhost:' + port + '/',
  });
  return rep;
}

// メール送信用 GAS の代わり（テスト送信を受けたら、送ったことにして履歴に残す）
setInterval(async () => {
  const d = await ready;
  await d.sql("insert into public.app_state (key, value) values ('relay_seen_at', now()::text) on conflict (key) do update set value = excluded.value");
  const pending = (await d.sql("select value from public.app_state where key = 'test_request'"))[0];
  if (!pending || !pending.value) return;
  await d.sql("update public.app_state set value = '' where key = 'test_request'");
  const rep = await preview(d, false);
  const to = ((await d.sql("select public._config() -> 'mail' -> 'recipients' as r"))[0].r || []).join(', ');
  await d.sql("insert into public.mail_log (to_addr, subject, result) values ($1, $2, '送信済み')", [to, '[テスト] ' + rep.subject]);
  lastMail = rep;
}, 1000);
let lastMail = null;

http.createServer(async (req, res) => {
  const d = await ready;
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/rpc') {
      const { name, payload } = await readBody(req);
      return send(res, 200, JSON.stringify(await d.rpc(name, payload, TEST_EMAIL)), 'application/json');
    }
    if (req.method === 'POST' && p === '/fake/preview') {
      const { summary } = await readBody(req);
      const rep = await preview(d, !!summary);
      return send(res, 200, JSON.stringify({ subject: rep.subject, html: rep.html }), 'application/json');
    }
    if (req.method === 'POST' && p === '/fake/setup') {
      const { email, pw } = await readBody(req);
      if (!email || String(pw).length < 8) return send(res, 400, 'メールアドレスと、8文字以上のパスワードを入れてください');
      if (accounts[email]) return send(res, 409, 'すでに設定済みです。「ログイン」から入ってください');
      accounts[email] = pw;
      return send(res, 200, '{"ok":true}', 'application/json');
    }
    if (req.method === 'POST' && p === '/fake/login') {
      const { email, pw } = await readBody(req);
      if ((accounts[email] || TEST_PASSWORD) !== pw) return send(res, 401, 'メールアドレスかパスワードが違います');
      return send(res, 200, '{"ok":true}', 'application/json');
    }
    if (p === '/fake/rev') return send(res, 200, String(await d.rev()));
    if (p === '/__mail') return send(res, 200, lastMail ? lastMail.html : 'まだ送っていません', 'text/html');
  } catch (e) {
    return send(res, 500, String((e && e.message) || e));
  }
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(WEB, path.normalize(rel));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found');
  let body = fs.readFileSync(file);
  if (rel === 'index.html') body = String(body).replace('<script src="config.js', FAKE + '\n  <script src="config.js');
  res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  res.end(body);
}).listen(port, () => console.log('http://localhost:' + port + '/'));
