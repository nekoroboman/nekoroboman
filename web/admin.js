/*
 * 本部タスク — 管理画面（管理者だけ）
 * - 本部の人のアカウントを招待する・招待をやり直す／取り消す・パスワード再設定のリンクを作る・停止／再開・管理者にする
 * - アカウントのないメンバー（名前だけ）の追加・招待
 * - アプリとは別に、この画面だけのログインが要る（タブを閉じるか、30分操作がないとログアウト）
 * - 守りはデータベース側で行う（管理者でない人・ログインから8時間たった人は、何も読めず変えられない）
 */
(function () {
  'use strict';
  const { html, render, useState, useEffect } = window.htmPreact;
  const ICONS = window.ICONS || {};
  const root = document.getElementById('app');
  const IDLE_MS = 30 * 60 * 1000;

  /* ================= データベース（Supabase）とのやりとり ================= */
  // 試験のときは window.HONBU_ADMIN_BACKEND に差し替えられる（dev/ の試験用サーバー）
  const backend = window.HONBU_ADMIN_BACKEND || makeBackend(window.HONBU_CONFIG || {});
  function makeBackend(cfg) {
    // アプリとは別のログイン。このタブの中だけに覚える（タブを閉じたらログアウト）
    const sb = window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'honbu-admin-auth:' + cfg.url, storage: window.sessionStorage },
    });
    return {
      async session() {
        const { data } = await sb.auth.getSession();
        return data.session ? { email: data.session.user.email } : null;
      },
      async signIn(email, password) {
        const { error } = await sb.auth.signInWithPassword({ email: email, password: password });
        if (error) throw new Error(/invalid/i.test(error.message) ? 'メールアドレスかパスワードが違います' : error.message);
      },
      async signOut() { await sb.auth.signOut({ scope: 'local' }); },
      async rpc(name, payload) {
        const { data, error } = await sb.rpc('api_call', { p_fn: name, p: payload || {} });
        if (error) throw new Error(error.message || 'エラーが起きました');
        return data;
      },
      // Google 連携の初期設定（config: 済んでいるか / save_config: クライアント ID・シークレットを入れる）
      async google(action, body) {
        const { data } = await sb.auth.getSession();
        const headers = { 'Content-Type': 'application/json', apikey: cfg.key };
        if (data.session) headers.Authorization = 'Bearer ' + data.session.access_token;
        const res = await fetch(cfg.url + '/functions/v1/google', { method: 'POST', headers: headers, body: JSON.stringify(Object.assign({ action: action }, body || {})) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'エラーが起きました（' + res.status + '）');
        return out;
      },
    };
  }
  // 共有のアカウントで入ったときは、アプリでこの端末に選んでいる人を「操作した人」として残す
  const operator = () => { try { return JSON.parse(localStorage.getItem('nrbtask.operator') || '""') || ''; } catch (e) { return ''; } };
  const call = (name, payload) => backend.rpc(name, Object.assign({ actor: operator() }, payload || {}));
  const errText = e => String((e && e.message) || e || 'エラーが起きました').replace(/^Error:\s*/, '');
  const theme = (() => { try { return (JSON.parse(localStorage.getItem('nrbtask.prefs') || '{}') || {}).theme || 'auto'; } catch (e) { return 'auto'; } })();

  /* ================= 状態 ================= */
  const S = { auth: 'checking', loginMsg: '', me: null, data: null, loadErr: '', busy: '', dialog: null, snack: '' };
  function update(fn) { if (fn) fn(S); render(html`<${App} />`, root); }
  let snackTimer = null;
  function snack(text) {
    clearTimeout(snackTimer);
    update(s => { s.snack = text; });
    snackTimer = setTimeout(() => update(s => { s.snack = ''; }), 6000);
  }

  async function load() {
    try {
      const [me, data, google] = await Promise.all([call('api_me'), call('api_admin_accounts'), call('api_admin_google').catch(() => null)]);
      update(s => { s.me = me; s.data = data; s.google = google; s.loadErr = ''; });
    } catch (e) {
      const msg = errText(e);
      if (/管理者だけ|使えません|もう一度ログイン|JWT/.test(msg)) {
        await backend.signOut().catch(() => {});
        update(s => { s.auth = 'login'; s.loginMsg = /管理者だけ/.test(msg) ? 'このアカウントは管理者ではないため、管理画面には入れません。' : msg; s.data = null; });
      } else {
        update(s => { s.loadErr = msg; });
      }
    }
  }
  async function run(label, fn, done) {
    update(s => { s.busy = label; });
    try {
      const r = await fn();
      if (done) done(r);
      await load();
    } catch (e) {
      snack(errText(e));
    }
    update(s => { s.busy = ''; });
  }

  /* ================= 小さな道具 ================= */
  function Icon({ n }) {
    return html`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[n] || '' }}></svg>`;
  }
  function Logo() {
    return html`<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 3.5l6.5 6h9l6.5-6V18a11 11 0 0 1-11 11h0A11 11 0 0 1 5 18z" fill="#0b57d0"/><path d="M10.5 18l4 4 7.5-8" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const p2 = n => (n < 10 ? '0' : '') + n;
  function fmtAt(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d)) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + p2(d.getMinutes());
  }
  const linkUrl = l => new URL('./', location.href).href + '#' + (l.kind === 'reset' ? 'reset' : 'invite') + '=' + l.token;
  const relayOk = () => S.data && S.data.relaySeenAt && Date.now() - new Date(S.data.relaySeenAt).getTime() < 5 * 60 * 1000;

  /* ================= ログイン ================= */
  function Login() {
    const [email, setEmail] = useState('');
    const [pw, setPw] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const submit = async () => {
      setErr('');
      setBusy(true);
      try {
        await backend.signIn(email.trim(), pw);
        update(s => { s.auth = 'ok'; s.loginMsg = ''; });
        touch();
        await load();
      } catch (e) {
        setErr(errText(e));
      }
      setBusy(false);
    };
    return html`<div class="login-wrap"><div class="login-card">
      <div class="login-brand"><${Logo} /><span>本部タスク 管理画面</span></div>
      <h1>管理者のログイン</h1>
      <p class="muted">本部のアカウントを管理する画面です。入れるのは管理者だけです。アプリにログインしていても、ここではもう一度ログインが必要です。</p>
      ${S.loginMsg && html`<div class="notice bad">${S.loginMsg}</div>`}
      <form class="form-grid" onSubmit=${e => { e.preventDefault(); submit(); }}>
        <div><label class="lbl">メールアドレス</label>
          <input class="input" type="email" autocomplete="username" required value=${email} onInput=${e => setEmail(e.target.value)} /></div>
        <div><label class="lbl">パスワード</label>
          <input class="input" type="password" autocomplete="current-password" required value=${pw} onInput=${e => setPw(e.target.value)} /></div>
        ${err && html`<div class="af-err">${err}</div>`}
        <button class="btn primary" type="submit" disabled=${busy}>${busy ? 'お待ちください…' : 'ログイン'}</button>
      </form>
      <p class="muted" style="margin:16px 0 0;font-size:12px">このタブを閉じるか、30分操作がないと自動でログアウトします。</p>
      <a class="btn text login-switch" href="./">アプリに戻る</a>
    </div></div>`;
  }

  /* ================= 管理画面 ================= */
  function InviteCard() {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [admin, setAdmin] = useState(false);
    const ok = name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    const submit = () => run('invite', () => call('api_admin_invite', { name: name.trim(), email: email.trim(), isAdmin: admin }), r => {
      setName(''); setEmail(''); setAdmin(false);
      update(s => { s.dialog = { type: 'link', link: r.link, name: name.trim() }; });
    });
    return html`<section class="adm-card">
      <h2><${Icon} n="person_add" />アカウントを招待する</h2>
      <p class="muted">招待した人には、パスワードを決めるリンクがメールで届きます（7日間・1回だけ使えます）。招待されていないメールアドレスでは、アカウントは作れません。</p>
      ${S.data && !relayOk() && html`<div class="notice warn">メール送信用の GAS が動いていないため、招待メールは送られません。招待のあとに出るリンクをコピーして、本人に届けてください。</div>`}
      <form class="adm-invite" onSubmit=${e => { e.preventDefault(); if (ok) submit(); }}>
        <div><label class="lbl">名前</label><input class="input" placeholder="例: 山田 花子" value=${name} onInput=${e => setName(e.target.value)} /></div>
        <div class="grow2"><label class="lbl">メールアドレス（ログインに使う）</label><input class="input" type="email" placeholder="例: hanako@example.com" value=${email} onInput=${e => setEmail(e.target.value)} /></div>
        <label class="adm-check"><input type="checkbox" checked=${admin} onChange=${e => setAdmin(e.target.checked)} />管理者にする</label>
        <button class="btn primary" type="submit" disabled=${!ok || !!S.busy}>${S.busy === 'invite' ? '招待中…' : '招待する'}</button>
      </form>
    </section>`;
  }

  function statusChip(a) {
    if (a.status === 'active') return html`<span class="adm-chip ok">使用中</span>`;
    if (a.status === 'stopped') return html`<span class="adm-chip bad">停止中</span>`;
    return html`<span class="adm-chip wait">招待中</span>`;
  }
  function linkNote(a) {
    const l = a.link;
    if (!l) return a.status === 'invited' ? 'リンクがありません（「招待を送り直す」）' : '';
    const what = l.kind === 'reset' ? 'パスワード再設定' : '招待';
    if (l.expired) return what + 'のリンクは期限切れ';
    const mail = l.mailStatus === 'sent' ? 'メール送信済み ' + fmtAt(l.mailAt)
      : l.mailStatus === 'failed' ? 'メールを送れませんでした' + (l.mailError ? '（' + l.mailError + '）' : '')
      : l.mailStatus === 'sending' ? 'メール送信中' : 'メール送信待ち';
    return what + 'リンク: ' + mail + '・' + fmtAt(l.expiresAt) + 'まで';
  }

  function AccountRow({ a }) {
    const self = S.data && a.email === S.data.me;
    const busy = !!S.busy;
    const link = (fn, label) => run(fn + a.email, () => call(fn, { email: a.email }), r => update(s => { s.dialog = { type: 'link', link: r.link, name: a.name || a.email, label: label }; }));
    const confirm = (title, body, okLabel, fn, danger) => update(s => { s.dialog = { type: 'confirm', title: title, body: body, ok: okLabel, danger: danger, onOk: fn }; });
    const set = patch => run('update' + a.email, () => call('api_admin_update', Object.assign({ email: a.email }, patch)));
    return html`<tr class=${a.status === 'stopped' ? 'stopped' : ''}>
      <td data-h="名前"><b>${a.kind === 'shared' ? '共有のアカウント' : (a.name || '（名前なし）')}</b>
        ${a.isOwner ? html` <span class="adm-chip admin" title="管理者のすべての操作ができ、ほかの管理者は止めたり外したりできません">全権限</span>` : a.isAdmin && html` <span class="adm-chip admin">管理者</span>`}${self && html` <span class="adm-chip">あなた</span>`}
        ${a.kind === 'personal' && html`<button class="icon-btn sm" title="名前を変える" aria-label="名前を変える" onClick=${() => update(s => { s.dialog = { type: 'rename', memberId: a.memberId, name: a.name }; })}><${Icon} n="edit" /></button>`}
        ${a.kind === 'shared' && html`<div class="muted small">何人かで使い、端末ごとに操作する人を選ぶアカウント</div>`}</td>
      <td data-h="メールアドレス" class="adm-mail">${a.email}</td>
      <td data-h="状態">${statusChip(a)}<div class="muted small">${linkNote(a)}</div></td>
      <td data-h="最後のログイン">${fmtAt(a.lastSignInAt) || html`<span class="muted">まだありません</span>`}</td>
      <td data-h="操作"><div class="adm-acts">
        ${a.isOwner && !self && html`<span class="muted small">全権限のアカウントは、本人だけが変えられます</span>`}
        ${a.status === 'invited' && !a.isOwner && html`
          <button class="btn outline sm" disabled=${busy} onClick=${() => link('api_admin_reinvite', '招待')}>招待を送り直す</button>
          <button class="btn text sm" disabled=${busy || self} onClick=${() => confirm('招待を取り消しますか？', a.email + ' への招待を取り消します。送ったリンクは使えなくなります（メンバーの名前は残ります）。', '取り消す', () => run('cancel', () => call('api_admin_cancel', { email: a.email })), true)}>取り消す</button>`}
        ${a.status === 'active' && (!a.isOwner || self) && html`
          <button class="btn outline sm" disabled=${busy} onClick=${() => link('api_admin_reset', 'パスワード再設定')}>パスワード再設定</button>
          ${!self && !a.isOwner && html`<button class="btn text sm" disabled=${busy} onClick=${() => set({ isAdmin: !a.isAdmin })}>${a.isAdmin ? '管理者から外す' : '管理者にする'}</button>
          <button class="btn text sm danger-text" disabled=${busy} onClick=${() => confirm('アカウントを停止しますか？', (a.name || a.email) + ' さんは、すぐにアプリを使えなくなります（入れていたタスクや記録は残ります）。あとで「再開」できます。', '停止する', () => set({ status: 'stopped' }), true)}>停止</button>`}`}
        ${a.status === 'stopped' && html`<button class="btn outline sm" disabled=${busy} onClick=${() => set({ status: 'active' })}>再開</button>`}
      </div></td>
    </tr>`;
  }

  function AccountsCard() {
    const list = (S.data && S.data.accounts) || [];
    const n = st => list.filter(a => a.status === st).length;
    return html`<section class="adm-card">
      <h2><${Icon} n="groups" />アカウント<span class="muted adm-count">使用中 ${n('active')}・招待中 ${n('invited')}・停止中 ${n('stopped')}</span>
        <span class="grow"></span><button class="icon-btn sm" title="最新にする" aria-label="最新にする" onClick=${load}><${Icon} n="sync" /></button></h2>
      <div class="adm-table-wrap"><table class="adm-table">
        <thead><tr><th>名前</th><th>メールアドレス</th><th>状態</th><th>最後のログイン</th><th>操作</th></tr></thead>
        <tbody>${list.map(a => html`<${AccountRow} key=${a.email} a=${a} />`)}</tbody>
      </table></div>
      <p class="muted small">「停止」すると、その人はすぐに使えなくなります。パスワードを忘れた人には「パスワード再設定」でリンクを送ってください（24時間・1回だけ）。</p>
    </section>`;
  }

  function MembersCard() {
    const [name, setName] = useState('');
    const members = ((S.data && S.data.members) || []).filter(m => !m.hasAccount);
    const save = (m, patch) => run('member' + m.id, () => call('api_save_member', { member: Object.assign({ id: m.id, name: m.name, email: m.email || '', active: m.active }, patch) }));
    const add = () => {
      const n = name.trim();
      if (!n) return;
      const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      run('addMember', () => call('api_save_member', { member: { id: id, name: n, email: '', active: true } }), () => setName(''));
    };
    return html`<section class="adm-card">
      <h2><${Icon} n="person" />アカウントのないメンバー</h2>
      <p class="muted">担当者として選べる名前だけのメンバーです（共有のアカウントで、端末ごとに選ばれる人など）。メールアドレスを入れて「招待する」と、その人のアカウントを作れます。</p>
      ${members.map(m => html`<${MemberRow} key=${m.id} m=${m} save=${save} />`)}
      ${!members.length && html`<div class="muted small" style="margin:8px 0">いません</div>`}
      <form class="adm-addmem" onSubmit=${e => { e.preventDefault(); add(); }}>
        <input class="input" placeholder="名前だけのメンバーを追加（例: 佐藤）" value=${name} onInput=${e => setName(e.target.value)} />
        <button class="btn outline" type="submit" disabled=${!name.trim() || !!S.busy}>追加</button>
      </form>
    </section>`;
  }
  // Google 連携の初期設定（1回だけ）と、みんなの連携の状態
  function GoogleCard() {
    const [cfg, setCfg] = useState(null);
    const [id, setId] = useState('');
    const [secret, setSecret] = useState('');
    const [edit, setEdit] = useState(false);
    useEffect(() => { backend.google('config').then(setCfg).catch(e => setCfg({ error: errText(e) })); }, []);
    const ok = /\.apps\.googleusercontent\.com$/.test(id.trim()) && secret.trim().length >= 10;
    const save = () => run('google', () => backend.google('save_config', { clientId: id.trim(), clientSecret: secret.trim() }), r => {
      setCfg(Object.assign({}, cfg, r)); setId(''); setSecret(''); setEdit(false);
      snack('Google 連携の初期設定を保存しました。各自の「設定 → Google 連携」から、つなげるようになりました');
    });
    const copy = text => {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => snack('コピーしました'), () => snack('選んでコピーしてください'));
      else snack('選んでコピーしてください');
    };
    const members = (S.google && S.google.members) || [];
    const stChip = m => m.status === 'active' ? html`<span class="adm-chip ok">連携中</span>`
      : m.status === 'error' ? html`<span class="adm-chip bad">つなぎ直しが必要</span>` : html`<span class="adm-chip">まだ</span>`;
    const showForm = cfg && !cfg.error && !cfg.fromSecrets && (!cfg.configured || edit);
    return html`<section class="adm-card">
      <h2><${Icon} n="sync" />Google 連携（ToDo リスト・カレンダー）
        ${cfg && !cfg.error && (cfg.configured ? html`<span class="adm-chip ok">初期設定済み</span>` : html`<span class="adm-chip wait">初期設定がまだ</span>`)}</h2>
      <p class="muted">一人ずつ、自分の Google アカウントをつなぐと、担当のタスクが Google ToDo リストに、自分の予定とゲストに呼ばれた予定が Google カレンダーに出ます（アプリ → Google の一方向）。
        各自がアプリの「設定 → Google 連携」でつなぎます。その前に、管理者が下の初期設定を1回だけします。</p>
      ${cfg && cfg.error && html`<div class="notice bad">確かめられませんでした: ${cfg.error}</div>`}
      ${cfg && !cfg.error && html`
        <details class="adm-steps" open=${!cfg.configured}>
          <summary><b>初期設定のしかた（Google Cloud で1回だけ。本部の Google アカウントで）</b></summary>
          <ol>
            <li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud</a> でプロジェクトを作る（名前は「本部タスク」など）</li>
            <li>「API とサービス」→「ライブラリ」で <b>Google Tasks API</b> と <b>Google Calendar API</b> を探して、それぞれ「有効にする」</li>
            <li>「API とサービス」→「OAuth 同意画面」: 種類は「外部」、アプリ名「本部タスク」、サポートとデベロッパーのメールに本部のアドレスを入れて保存。最後に「アプリを公開」で<b>本番環境</b>にする（テストのままだと7日ごとにつなぎ直しになります）</li>
            <li>「認証情報」→「認証情報を作成」→「OAuth クライアント ID」: 種類は「ウェブ アプリケーション」。「承認済みのリダイレクト URI」に、次のアドレスをそのまま入れて「作成」
              <div class="adm-link"><input class="input" readOnly value=${cfg.redirectUri || ''} onFocus=${e => e.target.select()} />
                <button class="btn tonal" type="button" onClick=${() => copy(cfg.redirectUri || '')}><${Icon} n="content_copy" />コピー</button></div></li>
            <li>出てきた「クライアント ID」と「クライアント シークレット」を、下に貼り付けて「保存」（チャットやメールには貼らないでください）</li>
          </ol>
        </details>`}
      ${cfg && cfg.configured && !edit && html`<p class="small">クライアント ID: <code>${cfg.clientId}</code>${cfg.fromSecrets ? '（Supabase の Secrets に入っています）' : html` <button class="btn text sm" onClick=${() => setEdit(true)}>入れ直す</button>`}</p>`}
      ${showForm && html`<form class="adm-invite" onSubmit=${e => { e.preventDefault(); if (ok) save(); }}>
        <div class="grow2"><label class="lbl">クライアント ID</label><input class="input" placeholder="…apps.googleusercontent.com" value=${id} onInput=${e => setId(e.target.value)} autocomplete="off" /></div>
        <div class="grow2"><label class="lbl">クライアント シークレット</label><input class="input" type="password" placeholder="GOCSPX-…" value=${secret} onInput=${e => setSecret(e.target.value)} autocomplete="off" /></div>
        <button class="btn primary" type="submit" disabled=${!ok || !!S.busy}>${S.busy === 'google' ? '保存中…' : '保存'}</button>
        ${edit && html`<button class="btn text" type="button" onClick=${() => setEdit(false)}>やめる</button>`}
      </form>`}
      ${members.length > 0 && html`<div class="adm-table-wrap" style="margin-top:12px"><table class="adm-table">
        <thead><tr><th>メンバー</th><th>状態</th><th>Google アカウント</th><th>最後に反映</th></tr></thead>
        <tbody>${members.map(m => html`<tr key=${m.memberId}>
          <td data-h="メンバー"><b>${m.name}</b>${!m.hasAccount && html`<div class="muted small">アカウントがないため、つなげません</div>`}</td>
          <td data-h="状態">${stChip(m)}${m.lastError && html`<div class="muted small" style="white-space:pre-wrap">${m.lastError}</div>`}</td>
          <td data-h="Google アカウント" class="adm-mail">${m.email || html`<span class="muted">−</span>`}</td>
          <td data-h="最後に反映">${fmtAt(m.lastSyncedAt) || html`<span class="muted">−</span>`}</td>
        </tr>`)}</tbody></table></div>`}
    </section>`;
  }

  function MemberRow({ m, save }) {
    const [email, setEmail] = useState(m.email || '');
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    const invite = () => run('invite' + m.id, () => call('api_admin_invite', { memberId: m.id, email: email.trim() }),
      r => update(s => { s.dialog = { type: 'link', link: r.link, name: m.name }; }));
    return html`<div class=${'adm-mem' + (m.active ? '' : ' inactive')}>
      <input class="input" value=${m.name} aria-label="名前" onChange=${e => { const v = e.target.value.trim(); if (v && v !== m.name) save(m, { name: v }); }} />
      <input class="input grow2" type="email" placeholder="メールアドレス（招待するとき）" value=${email} aria-label="メールアドレス" onInput=${e => setEmail(e.target.value)} />
      <button class="btn outline sm" disabled=${!ok || !m.active || !!S.busy} onClick=${invite}>招待する</button>
      <label class="adm-check"><input type="checkbox" checked=${m.active} onChange=${e => save(m, { active: e.target.checked })} />在籍</label>
    </div>`;
  }

  /* ================= ダイアログ ================= */
  function Dialog() {
    const d = S.dialog;
    if (!d) return null;
    const close = () => update(s => { s.dialog = null; });
    let body = null;
    if (d.type === 'link') {
      const url = linkUrl(d.link);
      const reset = d.link.kind === 'reset';
      const copy = () => {
        const done = () => snack('リンクをコピーしました');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => snack('コピーできませんでした。リンクを選んでコピーしてください'));
        else snack('リンクを選んでコピーしてください');
      };
      body = html`<div class="dialog">
        <h2>${reset ? 'パスワード再設定のリンクを作りました' : '招待のリンクを作りました'}</h2>
        <p>${d.name ? d.name + 'さん' : ''}（${d.link.email}）${relayOk() ? 'にメールで送ります（1分ほどで届きます）。' : 'へのメールは、送信用 GAS が動いていないため送られません。'}
          メールが届かないときは、下のリンクを本人だけに届けてください。<b>${reset ? '24時間' : '7日間'}・1回だけ</b>使えます。</p>
        <div class="adm-link"><input class="input" readOnly value=${url} onFocus=${e => e.target.select()} />
          <button class="btn tonal" onClick=${copy}><${Icon} n="content_copy" />コピー</button></div>
        <p class="muted small">リンクを作り直すと、前のリンクは使えなくなります。</p>
        <div class="dlg-actions"><button class="btn primary" onClick=${close}>閉じる</button></div>
      </div>`;
    } else if (d.type === 'confirm') {
      body = html`<div class="dialog"><h2>${d.title}</h2><p>${d.body}</p>
        <div class="dlg-actions"><button class="btn text" onClick=${close}>キャンセル</button>
        <button class=${'btn ' + (d.danger ? 'danger' : 'primary')} onClick=${() => { close(); d.onOk(); }}>${d.ok}</button></div></div>`;
    } else if (d.type === 'rename') {
      body = html`<${RenameDialog} d=${d} close=${close} />`;
    }
    return html`<div class="dlg-scrim" onClick=${e => { if (e.target === e.currentTarget) close(); }}>${body}</div>`;
  }
  function RenameDialog({ d, close }) {
    const [name, setName] = useState(d.name || '');
    const m = ((S.data && S.data.members) || []).find(x => x.id === d.memberId);
    const ok = () => {
      const n = name.trim();
      if (!n || !m) return;
      close();
      run('rename', () => call('api_save_member', { member: { id: m.id, name: n, email: m.email || '', active: m.active } }));
    };
    return html`<div class="dialog"><h2>名前を変える</h2>
      <input class="input" value=${name} onInput=${e => setName(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && !e.isComposing) ok(); }} />
      <div class="dlg-actions"><button class="btn text" onClick=${close}>キャンセル</button><button class="btn primary" disabled=${!name.trim()} onClick=${ok}>保存</button></div></div>`;
  }

  function App() {
    let body;
    if (S.auth === 'checking') body = html`<div class="boot"><div class="boot-spin"></div><div>読み込み中…</div></div>`;
    else if (S.auth === 'login') body = html`<${Login} />`;
    else {
      body = html`<header class="adm-top">
          <div class="login-brand adm-brand"><${Logo} /><span>本部タスク <b>管理画面</b></span></div>
          <div class="grow"></div>
          <span class="muted adm-who">${S.me ? (S.me.name || '共有のアカウント') + '（' + S.me.email + '）' : ''}</span>
          <a class="btn text sm" href="./">アプリに戻る</a>
          <button class="btn outline sm" onClick=${logout}>ログアウト</button>
        </header>
        <main class="adm-main">
          ${S.loadErr && html`<div class="notice bad">読み込めませんでした: ${S.loadErr} <button class="btn text sm" onClick=${load}>もう一度</button></div>`}
          ${!S.data && !S.loadErr ? html`<div class="boot"><div class="boot-spin"></div></div>` : html`
            <${InviteCard} />
            <${AccountsCard} />
            <${MembersCard} />
            <${GoogleCard} />
            <p class="muted small adm-foot">30分操作がないと、自動でログアウトします。</p>`}
        </main>`;
    }
    return html`<div class="app adm" data-theme=${theme}>${body}<${Dialog} />
      ${S.snack && html`<div class="snack" role="status"><span class="s-text">${S.snack}</span></div>`}</div>`;
  }

  /* ================= 起動・自動ログアウト ================= */
  let lastActive = Date.now();
  function touch() { lastActive = Date.now(); }
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, touch, true));
  async function logout(msg) {
    await backend.signOut().catch(() => {});
    update(s => { s.auth = 'login'; s.data = null; s.me = null; s.dialog = null; s.loginMsg = typeof msg === 'string' ? msg : ''; });
  }
  setInterval(() => {
    if (S.auth === 'ok' && Date.now() - lastActive > IDLE_MS) logout('30分操作がなかったため、ログアウトしました。');
    else if (S.auth === 'ok' && !S.busy && !S.dialog && document.visibilityState === 'visible') load(); // 招待した人が使い始めたかなどを新しくする
  }, 30000);
  window.addEventListener('focus', () => { if (S.auth === 'ok' && !S.busy) load(); });

  (async function start() {
    update();
    let session = null;
    try { session = await backend.session(); } catch (e) { session = null; }
    if (!session) { update(s => { s.auth = 'login'; }); return; }
    update(s => { s.auth = 'ok'; });
    await load();
  })();
})();
