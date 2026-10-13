/**
 * 動作確認用のサーバー: node dev/server.js [ポート]
 * gas/ の画面を、GAS の代わりの試験用サーバー（gas-mock.js）につないで表示する。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./gas-mock');

const port = Number(process.argv[2] || process.env.PORT || 8080);
const gas = createGas({ port });
gas.ctx.setup();
const dir = path.join(__dirname, '..', 'gas');

const SHIM = `<script>
(function () {
  function runner(ok, ng) {
    return {
      withSuccessHandler: f => runner(f, ng),
      withFailureHandler: f => runner(ok, f),
      rpc: (name, payload) => {
        const delay = window.__RPC_DELAY__ || 0;
        setTimeout(() => {
          fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, payload }) })
            .then(r => r.text().then(t => ({ ok: r.ok, t })))
            .then(x => (x.ok ? ok && ok(x.t) : ng && ng(new Error(x.t))))
            .catch(e => ng && ng(new Error('NetworkError: ' + e.message)));
        }, delay);
      },
    };
  }
  window.google = { script: { run: runner(null, null) } };
})();
</script>`;

function page(task) {
  let html = process.env.DIST
    ? fs.readFileSync(path.join(__dirname, '..', 'dist', 'Index.html'), 'utf8')
    : fs.readFileSync(path.join(dir, 'Index.html'), 'utf8')
      .replace(/<\?!= include\('(\w+)'\); \?>/g, (m, name) => fs.readFileSync(path.join(dir, name + '.html'), 'utf8'));
  html = html.replace('<?= initialTask ?>', String(task || '').replace(/[^A-Za-z0-9_-]/g, ''));
  return html.replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">').replace('</head>', SHIM + '</head>');
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/rpc') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { name, payload } = JSON.parse(body);
        const out = gas.ctx.rpc(name, payload);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(out);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String(e.message || e));
      }
    });
    return;
  }
  if (url.pathname === '/__mail') {
    const last = gas.mails[gas.mails.length - 1];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(last ? last.htmlBody : 'まだ送っていません');
    return;
  }
  if (url.pathname === '/__send') {
    const at = url.searchParams.get('at');
    try {
      gas.props.MAIL_HOUR = '';
      const sent = gas.ctx.maybeSendReport_(at ? new Date(at) : new Date());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sent, count: gas.mails.length, subject: gas.mails.length ? gas.mails[gas.mails.length - 1].subject : '' }));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page(url.searchParams.get('task')));
}).listen(port, () => console.log('http://localhost:' + port + '/'));
