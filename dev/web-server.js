/**
 * 動作確認用: web/ の画面（Supabase 版）を、手元の PostgreSQL（PGlite）につないで表示する。
 * データベースの中身は supabase/migrations の SQL そのもの（本番と同じ）。本番の Supabase には接続しない。
 * node dev/web-server.js [ポート]
 * - ログインは試験用（共有・管理者のアカウント honbu-test@example.com ／ パスワード test-pass-1234）。招待したアカウントはリンクで決めたパスワード
 * - 管理画面（admin.html）も同じようにつなぐ
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
const ready = createDb().then(async d => {
  await d.sql('insert into auth.users (email, last_sign_in_at) values ($1, now())', [TEST_EMAIL]);
  return d;
});
const reportLib = import('../supabase/functions/mail/report.ts');

// 画面とデータベースのあいだの代わり（key: ログインを覚えておく場所。アプリと管理画面で別にする）
const fake = (globalName, key) => `<script>
window.${globalName} = (function () {
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.text().then(t => { if (!r.ok) throw new Error(t); return t ? JSON.parse(t) : null; }));
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem('${key}') || 'null'); } catch (e) { session = null; }
  return {
    async session() { return session; },
    async signIn(email, pw) { await post('/fake/login', { email: email, pw: pw }); session = { email: email, at: Math.floor(Date.now() / 1000) }; sessionStorage.setItem('${key}', JSON.stringify(session)); },
    async signOut() { session = null; sessionStorage.removeItem('${key}'); },
    onSignedOut() {},
    link(action, token, password) { return post('/fake/account', { action: action, token: token, password: password }); },
    rpc(name, p) { return post('/rpc', { name: name, payload: p, email: session && session.email, at: session && session.at }); },
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
const FAKE = fake('HONBU_BACKEND', 'fake-session');
const FAKE_ADMIN = fake('HONBU_ADMIN_BACKEND', 'fake-admin-session');

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
// 招待・パスワード再設定のメールも「送ったこと」にする
setInterval(async () => {
  const d = await ready;
  const rows = await d.sql("update public.invitations set mail_status = 'sent', mail_at = now(), pending_token = null where mail_status = 'queued' returning email, kind");
  for (const r of rows) {
    await d.sql("insert into public.mail_log (to_addr, subject, result) values ($1, $2, '送信済み')", [r.email, r.kind === 'reset' ? '【本部タスク】パスワード再設定のご案内' : '【本部タスク】招待が届いています']);
  }
}, 1500);
let lastMail = null;

http.createServer(async (req, res) => {
  const d = await ready;
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/rpc') {
      const { name, payload, email, at } = await readBody(req);
      if (!email) return send(res, 401, 'ログインしてください');
      return send(res, 200, JSON.stringify(await d.rpc(name, payload, email, at)), 'application/json');
    }
    if (req.method === 'POST' && p === '/fake/preview') {
      const { summary } = await readBody(req);
      const rep = await preview(d, !!summary);
      return send(res, 200, JSON.stringify({ subject: rep.subject, html: rep.html }), 'application/json');
    }
    if (req.method === 'POST' && p === '/fake/account') {
      // Edge Function「account」の代わり
      const { action, token, password } = await readBody(req);
      const info = (await d.sql('select public._invite_lookup($1) as r', [String(token || '')]))[0].r;
      if (!info.ok) return send(res, 410, info.error);
      if (action === 'info') return send(res, 200, JSON.stringify({ email: info.email, name: info.name, kind: info.kind }), 'application/json');
      if (String(password || '').length < 8) return send(res, 400, 'パスワードは8文字以上にしてください');
      if (!info.userId) await d.sql('insert into auth.users (email) values ($1)', [info.email]);
      const done = (await d.sql('select public._invite_complete($1) as r', [token]))[0].r;
      if (!done.ok) return send(res, 409, done.error);
      accounts[info.email] = password;
      return send(res, 200, JSON.stringify({ ok: true, email: info.email }), 'application/json');
    }
    if (req.method === 'POST' && p === '/fake/login') {
      const { email, pw } = await readBody(req);
      const want = accounts[email] || (email === TEST_EMAIL ? TEST_PASSWORD : null);
      if (!want || want !== pw) return send(res, 401, 'メールアドレスかパスワードが違います');
      await d.sql('update auth.users set last_sign_in_at = now() where email = $1', [email]);
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
  if (rel === 'admin.html') body = String(body).replace('<script src="config.js', FAKE_ADMIN + '\n  <script src="config.js');
  res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  res.end(body);
}).listen(port, () => console.log('http://localhost:' + port + '/'));
