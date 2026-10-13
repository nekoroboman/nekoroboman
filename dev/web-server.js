/**
 * 動作確認用: web/ の画面（Supabase 版）を、Supabase の代わりに試験用サーバー（gas-mock.js）につないで表示する。
 * node dev/web-server.js [ポート]
 * - ログインは試験用（パスワード test-pass-1234）
 * - リアルタイム通知は、同期番号が変わったら知らせる形でまねする
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./gas-mock');

const port = Number(process.argv[2] || process.env.PORT || 8090);
const gas = createGas({ port });
gas.ctx.setup();
const WEB = path.join(__dirname, '..', 'web');
const TEST_PASSWORD = 'test-pass-1234';
const accounts = {};

const FAKE = `<script>
window.HONBU_BACKEND = (function () {
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.text().then(t => { if (!r.ok) throw new Error(t); return t ? JSON.parse(t) : null; }));
  const NAMES = { requestTestMail: 'sendTestMail' };
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem('fake-session') || 'null'); } catch (e) { session = null; }
  return {
    async session() { return session; },
    async signIn(email, pw) { await post('/fake/login', { email: email, pw: pw }); session = { email: email }; sessionStorage.setItem('fake-session', JSON.stringify(session)); },
    async signOut() { session = null; sessionStorage.removeItem('fake-session'); },
    onSignedOut() {},
    setupAccount(email, pw) { return post('/fake/setup', { email: email, pw: pw }); },
    rpc(name, p) {
      const fn = name.replace(/^api_/, '').replace(/_([a-z])/g, (m, c) => c.toUpperCase());
      return post('/rpc', { name: NAMES[fn] || fn, payload: p });
    },
    preview(summary) { return post('/rpc', { name: 'previewReport', payload: { summary: summary } }); },
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

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'POST' && p === '/rpc') {
    const { name, payload } = await readBody(req);
    try { return send(res, 200, gas.ctx.rpc(name, payload), 'application/json'); } catch (e) { return send(res, 500, String(e.message || e)); }
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
  if (p === '/fake/rev') return send(res, 200, String(gas.ctx.publishedRev_()));
  if (p === '/__mail') {
    const last = gas.mails[gas.mails.length - 1];
    return send(res, 200, last ? last.htmlBody : 'まだ送っていません', 'text/html');
  }
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(WEB, path.normalize(rel));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found');
  let body = fs.readFileSync(file);
  if (rel === 'index.html') body = String(body).replace('<script src="config.js', FAKE + '\n  <script src="config.js');
  res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  res.end(body);
}).listen(port, () => console.log('http://localhost:' + port + '/'));
