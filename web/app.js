/*
 * 本部タスク — 画面の動き（Supabase 版）
 * Google ToDo リストと同じ操作感 ＋ 誰が・いつまでに・何を ＋ 進捗管理
 *
 * 最新情報を反映するしくみ（同じアカウントを何人かで同時に使うため）
 * - 押した操作はすぐ画面に反映し、裏で順番にデータベースへ送る（送信待ちの列）
 * - データベースが変わるとリアルタイム通知が届く。届いたら「前回より新しい変更」だけを受け取り、画面に重ねる
 * - 通知が届かないときに備えて、30秒ごとにも確認する
 * - 他の人が変えたタスクは、オレンジ色に一瞬光らせて知らせる
 */
(function () {
  'use strict';
  const { html, render, useState, useEffect, useRef, useLayoutEffect } = window.htmPreact;
  const ICONS = window.ICONS || {};
  const root = document.getElementById('app');
  const INITIAL_TASK = (new URLSearchParams(location.search).get('task') || '').replace(/[^A-Za-z0-9_-]/g, '');
  // 招待・パスワード再設定のリンク（#invite=… / #reset=…）。合言葉はサーバーの記録に残らないよう # のうしろで受け取る
  const LINK = (function () {
    const m = /^#(invite|reset)=([A-Za-z0-9_-]{30,100})$/.exec(location.hash || '');
    return m ? { kind: m[1], token: m[2] } : null;
  })();
  // Google の許可画面から戻ってきたとき（#google=connected か #google=error:理由）
  const GOOGLE_BACK = (function () {
    const m = /^#google=(connected|error:(.*))$/.exec(location.hash || '');
    if (!m) return null;
    let msg = '';
    try { msg = decodeURIComponent(m[2] || ''); } catch (e) { msg = ''; }
    return { ok: m[1] === 'connected', msg: msg };
  })();

  /* ================= 端末ごとの保存（この端末だけの設定） ================= */
  const local = {
    get(k, d) { try { const v = localStorage.getItem('nrbtask.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('nrbtask.' + k, JSON.stringify(v)); } catch (e) { /* 保存できない環境では覚えない */ } },
  };
  const DEFAULT_PREFS = { addToTop: true, sound: false, motion: true, theme: 'auto' };

  /* ================= 状態 ================= */
  const S = {
    ready: false, bootError: '', rev: 0, online: true, lastSync: 0,
    auth: 'checking', rt: 'connecting', me: null,
    lists: {}, tasks: {}, members: {}, config: null, calendars: {}, events: {},
    mode: local.get('mode', 'tasks'),
    cal: { view: local.get('calView', 'week'), date: '', search: '', editor: null, vis: local.get('calVis', {}), more: 0, range: {} },
    queue: [],
    view: { type: 'all' }, selected: null, search: '',
    operator: local.get('operator', ''),
    prefs: Object.assign({}, DEFAULT_PREFS, local.get('prefs', {})),
    hidden: local.get('hidden', {}),
    navListsOpen: true, navMembersOpen: local.get('navMembersOpen', true), memberTab: 'assigned',
    completing: {}, flash: {}, remote: null,
    expandedDone: {}, drag: null, drop: null,
    pop: null, dialog: null, repeatDlg: null, snack: null, drawer: false, printId: null,
    trash: null, boardFilter: { assignee: '', listId: '', bucket: '' },
  };
  let CUR = null;
  let CAL = null; // カレンダー（calendar.js）
  let renderQueued = false;
  function update(fn) {
    if (fn) fn(S);
    if (!renderQueued) {
      renderQueued = true;
      setTimeout(() => { renderQueued = false; draw(); }, 0);
    }
  }
  function draw() { render(html`<${App} />`, root); }

  /* ================= 小さな道具 ================= */
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  const p2 = n => (n < 10 ? '0' : '') + n;
  const ymd = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const todayYmd = () => ymd(new Date());
  S.cal.date = todayYmd();
  const parseYmd = s => { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const nowIso = () => new Date().toISOString();
  const byNum = k => (a, b) => (a[k] || 0) - (b[k] || 0);

  function dueAt(t) {
    if (!t || !t.due) return Infinity;
    const d = parseYmd(t.due);
    const tm = (t.dueTime || '23:59').split(':').map(Number);
    d.setHours(tm[0], tm[1], 59, 0);
    return d.getTime();
  }
  function isOverdue(t) { return t.status !== 'done' && !!t.due && dueAt(t) < Date.now(); }
  function mdLabel(s) {
    if (!s) return '';
    const d = parseYmd(s);
    const base = (d.getMonth() + 1) + '月' + d.getDate() + '日(' + DOW[d.getDay()] + ')';
    return d.getFullYear() === new Date().getFullYear() ? base : d.getFullYear() + '年' + base;
  }
  function dayWord(s) {
    const t = todayYmd();
    if (s === t) return '今日';
    if (s === addDays(t, 1)) return '明日';
    if (s === addDays(t, -1)) return '昨日';
    return mdLabel(s);
  }
  const dateWord = (s, tm) => dayWord(s) + (tm ? ' ' + tm : '');
  // 一覧の小さな印用（10/19(月) のように短く）
  function shortWord(s, tm) {
    const t = todayYmd();
    let w;
    if (s === t) w = '今日';
    else if (s === addDays(t, 1)) w = '明日';
    else if (s === addDays(t, -1)) w = '昨日';
    else { const d = parseYmd(s); w = (d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '/') + (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[d.getDay()] + ')'; }
    return w + (tm ? ' ' + tm : '');
  }
  function dueLabel(t) { return t.due ? dateWord(t.due, t.dueTime) : t.repeat && t.doDate ? '期限なし' : ''; }
  function doLabel(t) { return t.doDate ? dateWord(t.doDate, t.doTime) : ''; }
  const isDoLate = t => t.status !== 'done' && !!t.doDate && t.doDate < todayYmd() && !isOverdue(t);
  function doAt(t) {
    if (!t || !t.doDate) return Infinity;
    const d = parseYmd(t.doDate);
    const tm = (t.doTime || '00:00').split(':').map(Number);
    d.setHours(tm[0], tm[1], 0, 0);
    return d.getTime();
  }
  // 「いつやる」と「期限」の早いほう（並べ替え用）
  const whenAt = t => Math.min(doAt(t), dueAt(t));
  const nextDate = t => [t.doDate, t.due].filter(Boolean).sort()[0] || '';
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  function fmtAt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const same = ymd(d) === todayYmd();
    return (same ? '今日 ' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + d.getHours() + ':' + p2(d.getMinutes());
  }
  function fmtRel(iso) {
    if (!iso) return '';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return Math.floor(s / 60) + '分前';
    if (s < 86400) return Math.floor(s / 3600) + '時間前';
    if (s < 86400 * 7) return Math.floor(s / 86400) + '日前';
    return fmtAt(iso);
  }
  /* ---- 繰り返し（Google カレンダー・ToDo リストと同じ RRULE の形。データベースの _check_repeat と同じ決まり） ---- */
  const RR_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const LEGACY_RR = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY' };
  function rrParse(s) {
    const o = { freq: '', interval: 1, days: [], nth: 0, nthDow: -1, mday: 0, until: '', count: 0 };
    s = LEGACY_RR[s] || s || '';
    if (s.indexOf('every:') === 0) {
      const p = s.split(':');
      o.freq = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[p[2]] || '';
      o.interval = Number(p[1]) || 1;
      o.days = p[3] ? p[3].split(',').map(Number) : [];
      return o;
    }
    s.split(';').forEach(part => {
      const k = part.split('=')[0];
      const v = part.split('=')[1] || '';
      if (k === 'FREQ') o.freq = v;
      else if (k === 'INTERVAL') o.interval = Number(v) || 1;
      else if (k === 'BYDAY') {
        if (/^-?\d/.test(v)) { o.nth = Number(v.replace(/[A-Z]/g, '')); o.nthDow = RR_DAYS.indexOf(v.replace(/[-\d]/g, '')); }
        else o.days = v.split(',').map(x => RR_DAYS.indexOf(x)).filter(x => x >= 0);
      } else if (k === 'BYMONTHDAY') o.mday = Number(v);
      else if (k === 'UNTIL') o.until = v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8);
      else if (k === 'COUNT') o.count = Number(v);
    });
    return o;
  }
  function rrFormat(o) {
    if (!o.freq) return '';
    let s = 'FREQ=' + o.freq;
    if (o.interval > 1) s += ';INTERVAL=' + o.interval;
    if (o.freq === 'WEEKLY' && o.days.length) s += ';BYDAY=' + o.days.slice().sort().map(i => RR_DAYS[i]).join(',');
    if (o.freq === 'MONTHLY' && o.nth) s += ';BYDAY=' + o.nth + RR_DAYS[o.nthDow];
    else if (o.freq === 'MONTHLY' && o.mday) s += ';BYMONTHDAY=' + o.mday;
    if (o.until) s += ';UNTIL=' + o.until.replace(/-/g, '');
    else if (o.count) s += ';COUNT=' + o.count;
    return s;
  }
  const daysInMonth = s => { const d = parseYmd(s); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };
  const nthOf = s => Math.ceil(parseYmd(s).getDate() / 7);
  const isLastWeek = s => parseYmd(s).getDate() + 7 > daysInMonth(s);
  const nthWord = n => (n === -1 ? '最終' : '第' + n);
  function rrLabel(s, anchor) {
    if (!s) return '';
    const o = rrParse(s);
    const a = anchor ? parseYmd(anchor) : null;
    let t = '';
    if (o.freq === 'DAILY') t = o.interval > 1 ? o.interval + '日ごと' : '毎日';
    else if (o.freq === 'WEEKLY') {
      const days = o.days.length ? o.days : a ? [a.getDay()] : [];
      const w = days.join(',') === '1,2,3,4,5' ? '平日（月〜金）' : days.map(i => DOW[i]).join('・') + '曜日';
      t = (o.interval > 1 ? o.interval + '週間ごと ' : '毎週 ') + (days.length ? w : '');
    } else if (o.freq === 'MONTHLY') {
      const on = o.nth ? nthWord(o.nth) + DOW[o.nthDow] + '曜日' : o.mday === -1 ? '最終日' : (o.mday || (a ? a.getDate() : '')) + '日';
      t = (o.interval > 1 ? o.interval + 'か月ごと ' : '毎月 ') + on;
    } else if (o.freq === 'YEARLY') t = (o.interval > 1 ? o.interval + '年ごと ' : '毎年 ') + (a ? (a.getMonth() + 1) + '月' + a.getDate() + '日' : '');
    if (o.until) t += '（' + mdLabel(o.until) + 'まで）';
    else if (o.count) t += '（' + o.count + '回）';
    return t.trim();
  }
  // 基準の日から選べる決まり（Google カレンダーと同じ並び）
  function rrPresets(anchor) {
    const a = parseYmd(anchor || todayYmd());
    const dw = RR_DAYS[a.getDay()];
    const out = [
      ['', '繰り返さない'],
      ['FREQ=DAILY', '毎日'],
      ['FREQ=WEEKLY;BYDAY=' + dw, '毎週 ' + DOW[a.getDay()] + '曜日'],
      ['FREQ=MONTHLY;BYMONTHDAY=' + a.getDate(), '毎月 ' + a.getDate() + '日'],
    ];
    if (anchor && a.getDate() === daysInMonth(anchor)) out.push(['FREQ=MONTHLY;BYMONTHDAY=-1', '毎月 最終日']);
    if (nthOf(ymd(a)) <= 4) out.push(['FREQ=MONTHLY;BYDAY=' + nthOf(ymd(a)) + dw, '毎月 ' + nthWord(nthOf(ymd(a))) + DOW[a.getDay()] + '曜日']);
    if (isLastWeek(ymd(a))) out.push(['FREQ=MONTHLY;BYDAY=-1' + dw, '毎月 最終' + DOW[a.getDay()] + '曜日']);
    out.push(['FREQ=YEARLY', '毎年 ' + (a.getMonth() + 1) + '月' + a.getDate() + '日']);
    out.push(['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '毎週 平日（月〜金）']);
    return out;
  }
  // 次の回の日（データベースの _repeat_step と同じ考え方。表示用）
  function rrStep(o, from) {
    const f = parseYmd(from);
    const add = n => { const d = new Date(f); d.setDate(d.getDate() + n); return ymd(d); };
    if (o.freq === 'DAILY') return add(o.interval);
    if (o.freq === 'YEARLY') {
      const d = new Date(f.getFullYear() + o.interval, f.getMonth(), 1);
      d.setDate(Math.min(f.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
      return ymd(d);
    }
    if (o.freq === 'WEEKLY') {
      const days = o.days.length ? o.days : [f.getDay()];
      for (let k = 1; k <= 6 - f.getDay(); k++) if (days.indexOf((f.getDay() + k) % 7) >= 0) return add(k);
      const sun = -f.getDay() + 7 * o.interval;
      for (let k = 0; k < 7; k++) if (days.indexOf(k) >= 0) return add(sun + k);
      return '';
    }
    if (o.freq === 'MONTHLY') {
      for (let k = 0; k < 240; k++) {
        const m = new Date(f.getFullYear(), f.getMonth() + k * o.interval, 1);
        const last = new Date(m.getFullYear(), m.getMonth() + 1, 0);
        let d;
        if (o.nth === -1) { d = new Date(last); d.setDate(last.getDate() - ((last.getDay() - o.nthDow + 7) % 7)); }
        else if (o.nth) { d = new Date(m); d.setDate(1 + ((o.nthDow - m.getDay() + 7) % 7) + 7 * (o.nth - 1)); }
        else if (o.mday === -1) d = last;
        else { d = new Date(m); d.setDate(Math.min(o.mday || f.getDate(), last.getDate())); }
        if (ymd(d) > from) return ymd(d);
      }
    }
    return '';
  }
  function rrNext(s, from, index) {
    const o = rrParse(s);
    if (!o.freq || !from) return '';
    const d = rrStep(o, from);
    if (!d || (o.until && d > o.until) || (o.count && (index || 1) + 1 > o.count)) return '';
    return d;
  }
  const STATUS_LABEL = { todo: '未着手', doing: '進行中', done: '完了' };

  function memberName(id) { const m = CUR && CUR.members[id]; return m ? m.name : ''; }
  function activeMembers() { return Object.values(CUR.members).filter(m => m.active).sort(byNum('sortOrder')); }
  function listName(id) { const l = CUR && CUR.lists[id]; return l ? l.name : ''; }
  const COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#007b83', '#c5221f', '#5f6368', '#b06000', '#1967d2', '#a50e0e', '#137333'];
  function colorOf(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }

  function Icon({ n, cls }) {
    return html`<svg class=${'ic' + (cls ? ' ' + cls : '')} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[n] || '' }}></svg>`;
  }
  function Avatar({ id, size }) {
    const s = size || 28;
    const name = memberName(id);
    if (!name) return html`<span class="avatar none" style=${{ width: s + 'px', height: s + 'px', fontSize: s * 0.5 + 'px' }}><${Icon} n="person" /></span>`;
    return html`<span class="avatar" title=${name} style=${{ width: s + 'px', height: s + 'px', fontSize: s * 0.46 + 'px', background: colorOf(id) }}>${name.slice(0, 1)}</span>`;
  }
  function Logo() {
    return html`<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 3.5l6.5 6h9l6.5-6V18a11 11 0 0 1-11 11h0A11 11 0 0 1 5 18z" fill="#0b57d0"/><path d="M10.5 18l4 4 7.5-8" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  let audio = null;
  function ding() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audio.currentTime;
      [[880, 0], [1318.5, 0.09]].forEach(([f, d]) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + d);
        g.gain.exponentialRampToValueAtTime(0.16, t0 + d + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.28);
        o.connect(g);
        g.connect(audio.destination);
        o.start(t0 + d);
        o.stop(t0 + d + 0.3);
      });
    } catch (e) { /* 音が出せない環境 */ }
  }

  /* ================= データベース（Supabase）とのやりとり ================= */
  // 試験のときは window.HONBU_BACKEND に差し替えられる（dev/ の試験用サーバー）
  const backend = window.HONBU_BACKEND || makeSupabaseBackend(window.HONBU_CONFIG || {});

  function makeSupabaseBackend(cfg) {
    const sb = window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'honbu-task-auth:' + cfg.url }, // つなぎ先が変わったら、前のログインは使わない
    });
    async function postFn(name, body, withAuth) {
      const headers = { 'Content-Type': 'application/json', apikey: cfg.key };
      if (withAuth) {
        const { data } = await sb.auth.getSession();
        if (data.session) headers.Authorization = 'Bearer ' + data.session.access_token;
      }
      const res = await fetch(cfg.url + '/functions/v1/' + name, { method: 'POST', headers: headers, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'エラーが起きました（' + res.status + '）');
      return out;
    }
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
      onSignedOut(fn) { sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') fn(); }); },
      // 招待・パスワード再設定のリンク（info: 確かめる / accept: パスワードを決める）
      link(action, token, password) { return postFn('account', { action: action, token: token, password: password || '' }, false); },
      async rpc(name, payload) {
        const { data, error } = await sb.rpc('api_call', { p_fn: name, p: payload });
        if (error) throw new Error(error.message || 'エラーが起きました');
        return data;
      },
      preview(summary) { return postFn('mail', { action: 'preview', summary: !!summary }, true); },
      // Google 連携（config / start / disconnect / syncme）
      google(action, body) { return postFn('google', Object.assign({ action: action }, body || {}), true); },
      subscribe(onChange, onStatus) {
        const ch = sb.channel('honbu-task');
        ['tasks', 'lists', 'members', 'settings', 'calendars', 'events'].forEach(t => ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, onChange));
        ch.subscribe(status => onStatus(status));
        return () => sb.removeChannel(ch);
      },
    };
  }

  const RPC = {
    bootstrap: 'api_bootstrap', sync: 'api_sync', taskDetail: 'api_task_detail', trash: 'api_trash',
    createList: 'api_create_list', updateList: 'api_update_list', deleteList: 'api_delete_list', reorderLists: 'api_reorder_lists',
    createTask: 'api_create_task', updateTask: 'api_update_task', deleteTask: 'api_delete_task', restoreTask: 'api_restore_task',
    clearCompleted: 'api_clear_completed', addNote: 'api_add_note', saveMember: 'api_save_member', saveConfig: 'api_save_config',
    mailStatus: 'api_mail_status', sendTestMail: 'api_request_test_mail', me: 'api_me',
    saveCalendar: 'api_save_calendar', deleteCalendar: 'api_delete_calendar', createEvent: 'api_create_event', updateEvent: 'api_update_event',
    deleteEvent: 'api_delete_event', respondEvent: 'api_respond_event', eventTrash: 'api_event_trash', restoreEvent: 'api_restore_event',
    eventsRange: 'api_events_range', googleStatus: 'api_google_status', googleSettings: 'api_google_settings',
  };
  function call(fn, payload) {
    const p = Object.assign({ actor: S.operator || '' }, payload || {});
    if (fn === 'previewReport') return backend.preview(p.summary);
    return backend.rpc(RPC[fn], p);
  }
  const errText = e => String((e && e.message) || e || 'エラーが起きました').replace(/^Error:\s*/, '').replace(/^Exception:\s*/, '');
  const retryable = e => /BUSY|Network|HTTP|timed? ?out|too many|Service|Failed to fetch|Load failed|サーバー|一時的|Timeout|Unavailable|JWT|fetch/i.test(errText(e));

  function snack(text, opts) {
    const id = uid();
    update(s => { s.snack = Object.assign({ id: id, text: text }, opts || {}); });
    setTimeout(() => update(s => { if (s.snack && s.snack.id === id) s.snack = null; }), (opts && opts.ms) || 5000);
  }

  function applyEntities(map, arr, keepDeleted) {
    (arr || []).forEach(e => {
      const cur = map[e.id];
      if (cur && (cur.rev || 0) > (e.rev || 0)) return;
      if (e.deletedAt && !keepDeleted) delete map[e.id];
      else map[e.id] = e;
    });
  }
  function applyResult(res) {
    if (!res) return;
    applyEntities(S.lists, res.lists);
    applyEntities(S.tasks, res.tasks);
    applyEntities(S.members, res.members, true);
    applyEntities(S.calendars, res.calendars);
    applyEntities(S.events, res.events);
    if (res.config) S.config = res.config;
  }
  function replaceAll(res) {
    S.lists = {}; S.tasks = {}; S.members = {}; S.calendars = {}; S.events = {};
    applyResult(res);
  }

  /* 送信待ちの列（押した順にサーバーへ送る） */
  function enqueue(fn, payload, after) {
    S.queue.push({ fn: fn, payload: payload, at: nowIso(), tries: 0, after: after });
    update();
    pump();
  }
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (S.queue.length) {
      const op = S.queue[0];
      if (op.fn === 'updateTask' || op.fn === 'updateEvent') {
        const known = (op.fn === 'updateTask' ? S.tasks : S.events)[op.payload.id];
        if (op.payload.baseVersion === undefined) op.payload.baseVersion = known ? known.version : 0;
      }
      try {
        const res = await call(op.fn, op.payload);
        applyResult(res);
        S.queue.shift();
        S.online = true;
        if (res && res.mergedBy) {
          const tid = op.payload.id;
          snack(((S.members[res.mergedBy] || {}).name || 'ほかの人') + 'さんの変更と合わせて保存しました');
          if (op.fn === 'updateTask' && S.selected === tid) S.remote = { id: tid, by: res.mergedBy, at: Date.now() };
        }
        if (op.after) { try { op.after(res); } catch (e) { /* 後処理の失敗は無視 */ } }
      } catch (err) {
        if (retryable(err) && op.tries < 8) {
          op.tries++;
          S.online = false;
          update();
          await new Promise(r => setTimeout(r, Math.min(20000, 800 * Math.pow(2, op.tries))));
          continue;
        }
        S.queue.shift();
        snack(errText(err).replace(/^BUSY:\s*/, ''), { kind: 'error', ms: 7000 });
        doSync();
      }
      update();
    }
    pumping = false;
    update();
  }

  /* 数秒ごとに最新を取りに行く */
  let syncing = false;
  let syncTimer = null;
  async function doSync() {
    if (syncing || !S.ready) return;
    syncing = true;
    try {
      const res = await call('sync', { rev: S.rev });
      if (!res.unchanged) {
        if (res.full) replaceAll(res);
        else { noticeRemote(res); applyResult(res); }
      }
      S.rev = res.rev;
      S.online = true;
      S.lastSync = Date.now();
      checkOperator();
    } catch (e) {
      S.online = false;
    }
    syncing = false;
    update();
    scheduleSync();
  }
  // リアルタイム通知がつながっているときは30秒ごとの確認だけ。つながらないときは4秒ごと（触っていないときは15秒）。裏にあるときは60秒ごと
  let lastTouch = Date.now();
  ['pointerdown', 'keydown', 'wheel'].forEach(ev => document.addEventListener(ev, () => {
    const idle = Date.now() - lastTouch > 5 * 60000;
    lastTouch = Date.now();
    if (idle) doSync();
  }, { passive: true }));
  function scheduleSync() {
    clearTimeout(syncTimer);
    const live = S.rt === 'SUBSCRIBED';
    const ms = document.visibilityState !== 'visible' ? 60000 : live ? 30000 : Date.now() - lastTouch > 5 * 60000 ? 15000 : 4000;
    syncTimer = setTimeout(doSync, ms);
  }
  let unsubscribe = null;
  let rtTimer = null;
  function startRealtime() {
    if (unsubscribe) unsubscribe();
    unsubscribe = backend.subscribe(() => {
      clearTimeout(rtTimer);
      rtTimer = setTimeout(doSync, 150);
    }, status => {
      S.rt = status;
      if (status === 'SUBSCRIBED') doSync();
      else scheduleSync();
      update();
    });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') doSync(); });
  window.addEventListener('focus', () => doSync());
  window.addEventListener('online', () => { doSync(); pump(); });

  /* 他の人の変更を知らせる */
  function noticeRemote(res) {
    const me = S.operator;
    if (CAL) CAL.noticeRemote(res);
    (res.tasks || []).forEach(t => {
      const by = t.deletedAt ? t.deletedBy : t.updatedBy;
      if (!by || by === me) return;
      const old = S.tasks[t.id];
      if (old && old.version === t.version) return;
      S.flash[t.id] = Date.now();
      setTimeout(() => update(s => { delete s.flash[t.id]; }), 2600);
      if (S.selected === t.id) S.remote = { id: t.id, by: by, at: Date.now(), deleted: !!t.deletedAt };
      if (!t.deletedAt && !t.parentId && t.assignee === me && t.status !== 'done' && (!old || old.assignee !== me)) {
        const who = (S.members[by] || {}).name || 'ほかの人';
        snack(who + 'さんから担当タスクが届きました：「' + t.title + '」', { action: { label: '開く', fn: () => openTask(t.id) }, ms: 8000 });
      }
    });
  }

  const isPersonal = () => !!(S.me && S.me.memberId);
  const isAdmin = () => !!(S.me && S.me.isAdmin);
  const ADMIN_URL = 'admin.html';
  function checkOperator() {
    if (isPersonal()) {
      if (S.operator !== S.me.memberId) { S.operator = S.me.memberId; local.set('operator', S.operator); }
      if (S.dialog && S.dialog.type === 'who') S.dialog = null;
      return;
    }
    if (S.queue.some(op => op.fn === 'saveMember')) return;
    const m = S.members[S.operator];
    if (!S.operator || !m || !m.active) {
      if (!S.dialog || S.dialog.type !== 'who') S.dialog = { type: 'who', required: true };
    }
  }

  /* ================= 画面に出す前の組み立て（送信待ちも重ねる） ================= */
  function derive() {
    const tasks = Object.assign({}, S.tasks);
    const lists = Object.assign({}, S.lists);
    const members = Object.assign({}, S.members);
    const calendars = Object.assign({}, S.calendars);
    const events = Object.assign({}, S.events);
    S.queue.forEach(op => { overlay(op, tasks, lists, members); if (CAL) CAL.overlay(op, events, calendars); });
    const listArr = Object.values(lists).filter(l => !l.deletedAt).sort(byNum('sortOrder'));
    const children = {};
    const byList = {};
    Object.values(tasks).forEach(t => {
      if (t.deletedAt || !lists[t.listId] || lists[t.listId].deletedAt) return;
      if (t.parentId) (children[t.parentId] = children[t.parentId] || []).push(t);
      else (byList[t.listId] = byList[t.listId] || []).push(t);
    });
    Object.keys(children).forEach(k => children[k].sort((a, b) => (a.sortOrder - b.sortOrder) || (a.createdAt < b.createdAt ? -1 : 1)));
    return { tasks: tasks, lists: lists, members: members, listArr: listArr, children: children, byList: byList, calendars: calendars, events: events };
  }

  function overlay(op, tasks, lists, members) {
    const p = op.payload;
    const kids = id => Object.values(tasks).filter(t => t.parentId === id);
    switch (op.fn) {
      case 'createTask':
        tasks[p.task.id] = Object.assign({
          status: 'todo', version: 0, rev: 0, starred: false, details: '', due: '', dueTime: '', doDate: '', doTime: '', repeat: '', repeatIndex: 1, noteText: '',
          createdAt: op.at, createdBy: S.operator, updatedAt: op.at, updatedBy: S.operator, parentId: '',
        }, p.task, { _pending: true });
        break;
      case 'updateTask': {
        const cur = tasks[p.id];
        if (!cur) break;
        const t = Object.assign({}, cur, p.patch);
        if ('status' in p.patch) {
          if (p.patch.status === 'done' && cur.status !== 'done') {
            t.completedAt = op.at;
            kids(p.id).forEach(c => { tasks[c.id] = Object.assign({}, c, { status: 'done', completedAt: op.at }); });
          }
          if (p.patch.status !== 'done') t.completedAt = '';
        }
        if ('starred' in p.patch) t.starredAt = p.patch.starred ? (cur.starredAt || op.at) : '';
        if ('listId' in p.patch && !cur.parentId) kids(p.id).forEach(c => { tasks[c.id] = Object.assign({}, c, { listId: p.patch.listId }); });
        tasks[p.id] = t;
        break;
      }
      case 'deleteTask':
        delete tasks[p.id];
        kids(p.id).forEach(c => delete tasks[c.id]);
        break;
      case 'clearCompleted': {
        const doneTop = {};
        Object.values(tasks).forEach(t => { if (t.listId === p.listId && !t.parentId && t.status === 'done') doneTop[t.id] = 1; });
        Object.values(tasks).forEach(t => { if (t.listId === p.listId && (t.status === 'done' || doneTop[t.parentId])) delete tasks[t.id]; });
        break;
      }
      case 'addNote': {
        const cur = tasks[p.taskId];
        if (cur) tasks[p.taskId] = Object.assign({}, cur, { noteText: p.text, noteAt: op.at, noteBy: S.operator, status: cur.status === 'todo' ? 'doing' : cur.status, _notePending: true });
        break;
      }
      case 'createList':
        lists[p.id] = { id: p.id, name: p.name, sortMode: 'my', sortOrder: 1e9, rev: 0, _pending: true };
        break;
      case 'updateList':
        if (lists[p.id]) lists[p.id] = Object.assign({}, lists[p.id], p.patch);
        break;
      case 'deleteList':
        delete lists[p.id];
        break;
      case 'reorderLists':
        p.ids.forEach((id, i) => { if (lists[id]) lists[id] = Object.assign({}, lists[id], { sortOrder: i + 1 }); });
        break;
      case 'saveMember':
        members[p.member.id] = Object.assign({ sortOrder: 1e9, rev: 0 }, members[p.member.id] || {}, p.member, { _pending: true });
        break;
    }
  }

  /* ================= 操作 ================= */
  const act = {
    createTask(task) { enqueue('createTask', { task: task }); },
    updateTask(id, patch) { enqueue('updateTask', { id: id, patch: patch }); },
    deleteTask(t) {
      enqueue('deleteTask', { id: t.id });
      if (S.selected === t.id) S.selected = null;
      snack('タスクを削除しました', { action: { label: '元に戻す', fn: () => enqueue('restoreTask', { id: t.id }) } });
    },
    addNote(taskId, text) { enqueue('addNote', { taskId: taskId, text: text, id: uid() }); },
    createList(name, then) { const id = uid(); enqueue('createList', { id: id, name: name }); if (then) then(id); },
    updateList(id, patch) { enqueue('updateList', { id: id, patch: patch }); },
    saveMember(member) { enqueue('saveMember', { member: member }); },
  };

  function complete(t) {
    if (S.completing[t.id] || t.status === 'done') return;
    const prev = t.status;
    update(s => { s.completing[t.id] = true; });
    if (S.prefs.sound) ding();
    setTimeout(() => {
      act.updateTask(t.id, { status: 'done' });
      update(s => { delete s.completing[t.id]; });
      snack('タスクを完了しました', { action: { label: '元に戻す', fn: () => act.updateTask(t.id, { status: prev }) } });
    }, S.prefs.motion ? 650 : 0);
  }
  function uncomplete(t) { act.updateTask(t.id, { status: t.noteText ? 'doing' : 'todo' }); }
  function toggleStar(t) { act.updateTask(t.id, { starred: !t.starred }); }
  function openTask(id) {
    const t = CUR && CUR.tasks[id];
    update(s => { s.selected = id; s.remote = null; s.drawer = false; if (t && s.view.type === 'list' && s.view.id !== t.listId && !t.parentId) s.view = { type: 'list', id: t.listId }; });
  }
  function go(view) { update(s => { s.view = view; s.search = ''; s.drawer = false; if (view.type === 'trash') s.trash = null; }); }
  function setPref(k, v) { update(s => { s.prefs[k] = v; local.set('prefs', s.prefs); }); }
  function setMode(m) { update(s => { s.mode = m; s.pop = null; s.drawer = false; local.set('mode', m); }); }
  function setOperator(id) { update(s => { s.operator = id; local.set('operator', id); s.dialog = null; }); }
  function newSortOrder(listId) {
    const open = (CUR.byList[listId] || []).filter(t => t.status !== 'done').map(t => t.sortOrder || 0);
    if (!open.length) return 0;
    return S.prefs.addToTop ? Math.min.apply(null, open) - 1024 : Math.max.apply(null, open) + 1024;
  }
  function openPop(e, type, ctx, side) {
    openPopAt(e.currentTarget.getBoundingClientRect(), type, ctx, side);
  }
  // side: true のときは、押した場所の横に出す（カレンダー）
  function openPopAt(r, type, ctx, side) {
    update(s => { s.pop = { id: uid(), type: type, side: !!side, rect: { left: r.left, top: r.top, bottom: r.bottom, right: r.right }, ctx: ctx || {} }; });
  }
  const closePop = () => update(s => { s.pop = null; });
  function confirmDlg(title, body, okLabel, onOk, danger) { update(s => { s.dialog = { type: 'confirm', title: title, body: body, ok: okLabel, onOk: onOk, danger: danger }; }); }
  function printList(id) {
    update(s => { s.printId = id; s.pop = null; });
    setTimeout(() => { window.print(); setTimeout(() => update(s => { s.printId = null; }), 500); }, 300);
  }

  /* ================= 並べ替え・まとめ ================= */
  function sortMy(arr) { return arr.slice().sort((a, b) => (a.sortOrder - b.sortOrder) || (a.createdAt < b.createdAt ? 1 : -1)); }
  function dateBucket(t) {
    if (isOverdue(t)) return { key: '0', label: '期限切れ', red: true };
    if (!t.due) return { key: '9', label: '期限なし' };
    const td = todayYmd();
    if (t.due === td) return { key: '1', label: '今日' };
    if (t.due === addDays(td, 1)) return { key: '2', label: '明日' };
    return { key: '3' + t.due, label: mdLabel(t.due) };
  }
  function doBucket(t) {
    if (!t.doDate) return { key: '9', label: 'いつやるが未定' };
    const td = todayYmd();
    if (t.doDate < td) return { key: '0', label: 'やる日を過ぎている', red: true };
    if (t.doDate === td) return { key: '1', label: '今日' };
    if (t.doDate === addDays(td, 1)) return { key: '2', label: '明日' };
    return { key: '3' + t.doDate, label: mdLabel(t.doDate) };
  }
  // メンバー別・自分の担当の見出し（期限切れ → 今日 → 明日 → 1週間以内 → それ以降）
  function whenBucket(t) {
    const td = todayYmd();
    if (isOverdue(t)) return { key: '0', label: '期限切れ', red: true };
    if ((t.doDate && t.doDate <= td) || t.due === td) return { key: '1', label: '今日' };
    const d = nextDate(t);
    if (d === addDays(td, 1)) return { key: '2', label: '明日' };
    if (d && d <= addDays(td, 7)) return { key: '3', label: '1週間以内' };
    return { key: '4', label: 'それ以降' };
  }
  function groupsFor(list, open) {
    const mode = list.sortMode || 'my';
    if (mode === 'date') return groupBy(open.slice().sort((a, b) => dueAt(a) - dueAt(b) || doAt(a) - doAt(b) || a.sortOrder - b.sortOrder), dateBucket);
    if (mode === 'do') return groupBy(open.slice().sort((a, b) => doAt(a) - doAt(b) || dueAt(a) - dueAt(b) || a.sortOrder - b.sortOrder), doBucket);
    if (mode === 'assignee') {
      const sorted = open.slice().sort((a, b) => memberName(a.assignee).localeCompare(memberName(b.assignee), 'ja') || whenAt(a) - whenAt(b));
      return groupBy(sorted, t => ({ key: t.assignee, label: memberName(t.assignee) || '（担当者なし）' }));
    }
    if (mode === 'starred') {
      const st = open.filter(t => t.starred).sort((a, b) => (a.starredAt < b.starredAt ? 1 : -1));
      return [{ key: 'all', label: '', items: st.concat(sortMy(open.filter(t => !t.starred))) }];
    }
    if (mode === 'title') return [{ key: 'all', label: '', items: open.slice().sort((a, b) => a.title.localeCompare(b.title, 'ja')) }];
    return [{ key: 'all', label: '', items: sortMy(open) }];
  }
  function groupBy(arr, fn) {
    const out = [];
    const idx = {};
    arr.forEach(t => {
      const g = fn(t);
      if (!(g.key in idx)) { idx[g.key] = out.length; out.push({ key: g.key, label: g.label, red: g.red, items: [] }); }
      out[idx[g.key]].items.push(t);
    });
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  function openOf(listId) { return (CUR.byList[listId] || []).filter(t => t.status !== 'done' || S.completing[t.id]); }

  /** 進捗ボードとメールで同じ考え方 */
  function collect() {
    const cfg = S.config || { soonDays: 3, staleDays: 3 };
    const td = todayYmd();
    const soon = addDays(td, cfg.soonDays);
    const staleMs = Date.now() - cfg.staleDays * 86400000;
    const top = [];
    CUR.listArr.forEach(l => (CUR.byList[l.id] || []).forEach(t => top.push(t)));
    const open = top.filter(t => t.status !== 'done');
    const b = { overdue: [], today: [], todayDo: [], soon: [], stale: [] };
    open.forEach(t => {
      if (isOverdue(t)) b.overdue.push(t);
      else if (t.due === td) b.today.push(t);
      else if (t.doDate && t.doDate <= td) b.todayDo.push(t);
      else if (t.due && t.due <= soon) b.soon.push(t);
      const last = Math.max(new Date(t.updatedAt || 0).getTime(), new Date(t.noteAt || 0).getTime(), new Date(t.createdAt || 0).getTime());
      if (last < staleMs) b.stale.push(t);
    });
    Object.keys(b).forEach(k => b[k].sort((x, y) => (k === 'todayDo' ? doAt(x) - doAt(y) : 0) || dueAt(x) - dueAt(y)));
    const d = new Date();
    const weekStart = addDays(td, -((d.getDay() + 6) % 7));
    const rows = {};
    const row = id => rows[id] || (rows[id] = { id: id, overdue: 0, today: 0, todayDo: 0, soon: 0, doing: 0, todo: 0, doneWeek: 0 });
    b.overdue.forEach(t => row(t.assignee).overdue++);
    b.today.forEach(t => row(t.assignee).today++);
    b.todayDo.forEach(t => row(t.assignee).todayDo++);
    b.soon.forEach(t => row(t.assignee).soon++);
    open.forEach(t => row(t.assignee)[t.status === 'doing' ? 'doing' : 'todo']++);
    top.filter(t => t.status === 'done' && t.completedAt && ymd(new Date(t.completedAt)) >= weekStart).forEach(t => row(t.assignee).doneWeek++);
    const byAssignee = Object.values(rows).sort((x, y) => ((CUR.members[x.id] || {}).sortOrder || 9999) - ((CUR.members[y.id] || {}).sortOrder || 9999));
    return { cfg: cfg, top: top, open: open, b: b, byAssignee: byAssignee };
  }

  /* ================= 画面 ================= */
  function App() {
    CUR = derive();
    useGlobalKeys();
    if (S.auth === 'login') return html`<div class="app" data-theme=${S.prefs.theme}><${Login} /></div>`;
    if (S.auth === 'link') return html`<div class="app" data-theme=${S.prefs.theme}><${LinkScreen} /></div>`;
    if (!S.ready) {
      return html`<div class="boot">${S.bootError
        ? html`<div class="boot-error"><b>読み込めませんでした</b><br/>${S.bootError}<br/><br/>
            <button class="btn primary" onClick=${() => location.reload()}>もう一度読み込む</button>
            <button class="btn text" onClick=${() => backend.signOut().then(() => location.reload())}>ログアウト</button></div>`
        : html`<div class="boot-spin"></div><div>読み込み中…</div>`}</div>`;
    }
    const calMode = S.mode === 'calendar' && !!CAL;
    return html`
      <div class=${'app' + (S.prefs.motion ? '' : ' no-motion') + (calMode ? ' cal-mode' : '')} data-theme=${S.prefs.theme}>
        <${TopBar} />
        <div class="body">
          ${calMode ? html`<${CAL.Sidebar} />` : html`<${Nav} />`}
          <main class=${'main' + (calMode ? ' cal-main' : '')}>${calMode ? html`<${CAL.Main} />` : mainView()}</main>
          ${!calMode && S.selected && html`<${DetailPanel} key=${S.selected} id=${S.selected} />`}
        </div>
        ${calMode && S.cal.editor && html`<${CAL.Editor} key=${S.cal.editor.key} />`}
        ${S.drawer && html`<div class="scrim" onClick=${() => update(s => { s.drawer = false; })}></div>`}
        <${PopLayer} />
        <${DialogLayer} />
        <${RepeatLayer} />
        <${Snack} />
      </div>
      <${PrintArea} />`;
  }

  function useGlobalKeys() {
    useEffect(() => {
      const h = e => {
        if (e.key !== 'Escape') { if (S.mode === 'calendar' && CAL) CAL.onKey(e); return; }
        if (S.pop) return closePop();
        if (S.repeatDlg) return update(s => { s.repeatDlg = null; });
        if (S.dialog && !S.dialog.required) return update(s => { s.dialog = null; });
        if (S.selected && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) update(s => { s.selected = null; });
      };
      document.addEventListener('keydown', h);
      return () => document.removeEventListener('keydown', h);
    }, []);
  }

  function mainView() {
    if (S.search.trim()) return html`<${SearchView} />`;
    switch (S.view.type) {
      case 'list': {
        const l = CUR.lists[S.view.id];
        if (!l) return html`<${Board} />`;
        return html`<div class="single"><${ListCard} key=${l.id} list=${l} wide /></div>`;
      }
      case 'starred': return html`<${StarredView} />`;
      case 'mine': return html`<${MemberView} key=${'mine:' + S.operator} id=${S.operator} mine />`;
      case 'member': return CUR.members[S.view.id] ? html`<${MemberView} key=${S.view.id} id=${S.view.id} />` : html`<${Board} />`;
      case 'progress': return html`<${ProgressView} />`;
      case 'trash': return html`<${TrashView} />`;
      default: return html`<${Board} />`;
    }
  }

  function TopBar() {
    const saving = S.queue.length > 0;
    const syncCls = !S.online ? 'offline' : saving ? 'saving' : '';
    const syncText = !S.online ? 'オフライン（再接続中）' : saving ? '保存中…' : '最新の状態';
    // リアルタイム通知がつながっていないときも、数秒ごとの確認で最新になる
    const syncTitle = S.lastSync ? '最後に確認: ' + new Date(S.lastSync).toLocaleTimeString('ja-JP') : '';
    return html`<header class="topbar">
      <button class="icon-btn only-mobile" aria-label="メニュー" onClick=${() => update(s => { s.drawer = !s.drawer; })}><${Icon} n="menu" /></button>
      <div class="brand" onClick=${() => (S.mode === 'calendar' ? update(s => { s.cal.date = todayYmd(); s.cal.search = ''; }) : go({ type: 'all' }))}><${Logo} /><span>${S.mode === 'calendar' ? 'カレンダー' : '本部タスク'}</span></div>
      ${CAL && html`<div class="mode-switch" role="tablist" aria-label="切り替え">
        <button role="tab" class=${S.mode !== 'calendar' ? 'on' : ''} aria-selected=${S.mode !== 'calendar'} title="タスク" onClick=${() => setMode('tasks')}><${Icon} n="task_alt" /><span class="hide-sm">タスク</span></button>
        <button role="tab" class=${S.mode === 'calendar' ? 'on' : ''} aria-selected=${S.mode === 'calendar'} title="カレンダー" onClick=${() => setMode('calendar')}><${Icon} n="event" /><span class="hide-sm">カレンダー</span></button>
      </div>`}
      ${S.mode === 'calendar' && CAL ? html`<${CAL.TopControls} />` : html`<label class="search"><${Icon} n="search" />
        <input placeholder="タスクを検索" value=${S.search} onInput=${e => update(s => { s.search = e.target.value; })} />
        ${S.search && html`<button class="icon-btn sm" aria-label="検索を消す" onClick=${() => update(s => { s.search = ''; })}><${Icon} n="close" /></button>`}
      </label>`}
      <div class=${'sync ' + syncCls} title=${syncTitle}><${Icon} n=${!S.online ? 'cloud_off' : saving ? 'sync' : 'cloud_done'} /><span class="txt">${syncText}</span></div>
      <button class="who-chip" title=${isPersonal() ? 'ログインしている人' : '操作している人（タップで切り替え）'} onClick=${() => update(s => { s.dialog = isPersonal() ? { type: 'settings', tab: 'display' } : { type: 'who' }; })}>
        <${Avatar} id=${S.operator} size=${30} /><span class="hide-sm">${memberName(S.operator) || '操作する人'}</span>
      </button>
      <button class="icon-btn" aria-label="設定" onClick=${() => update(s => { s.dialog = { type: 'settings', tab: 'display' }; })}><${Icon} n="settings" /></button>
    </header>`;
  }

  function Nav() {
    const st = collect();
    const mine = st.open.filter(t => t.assignee === S.operator).length;
    const item = (icon, label, view, count, red) => html`
      <button class=${'nav-item' + (S.view.type === view.type && !S.search ? ' active' : '')} onClick=${() => go(view)}>
        <${Icon} n=${icon} /><span class="label">${label}</span>${count ? html`<span class=${'count' + (red ? ' red' : '')}>${count}</span>` : ''}
      </button>`;
    const dragList = useRef(null);
    return html`<nav class=${'nav' + (S.drawer ? ' open' : '')}>
      <button class="create-btn" onClick=${() => update(s => { s.dialog = { type: 'create' }; s.drawer = false; })}><${Icon} n="add" />作成</button>
      ${item('task_alt', 'すべてのタスク', { type: 'all' })}
      ${item('star', 'スター付き', { type: 'starred' })}
      ${item('person', '自分の担当', { type: 'mine' }, mine)}
      ${item('dashboard', '進捗ボード', { type: 'progress' }, st.b.overdue.length, true)}
      <div class="nav-sep"></div>
      <button class=${'nav-head' + (S.navListsOpen ? '' : ' closed')} onClick=${() => update(s => { s.navListsOpen = !s.navListsOpen; })}>
        <span class="grow" style="text-align:left">リスト</span><${Icon} n="expand_more" />
      </button>
      ${S.navListsOpen && CUR.listArr.map(l => html`
        <div key=${l.id} class=${'nav-list' + (S.view.type === 'list' && S.view.id === l.id && !S.search ? ' active' : '') + (S.drop && S.drop.navBefore === l.id ? ' drop' : '')}
          draggable="true"
          onDragStart=${e => { dragList.current = l.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'list:' + l.id); }}
          onDragOver=${e => { if (!dragList.current) return; e.preventDefault(); if (!S.drop || S.drop.navBefore !== l.id) update(s => { s.drop = { navBefore: l.id }; }); }}
          onDragEnd=${() => { dragList.current = null; update(s => { s.drop = null; }); }}
          onDrop=${e => {
            e.preventDefault();
            const from = dragList.current;
            dragList.current = null;
            S.drop = null;
            if (!from || from === l.id) return update();
            const ids = CUR.listArr.map(x => x.id).filter(x => x !== from);
            ids.splice(ids.indexOf(l.id), 0, from);
            enqueue('reorderLists', { ids: ids });
          }}>
          <label class="cb" title="「すべてのタスク」に表示する"><input type="checkbox" checked=${!S.hidden[l.id]} onChange=${() => update(s => { s.hidden[l.id] = !s.hidden[l.id]; if (!s.hidden[l.id]) delete s.hidden[l.id]; local.set('hidden', s.hidden); })} /><span class="box"></span></label>
          <button class="nav-list-name" onClick=${() => go({ type: 'list', id: l.id })}>${l.name}</button>
          <span class="count">${openOf(l.id).length || ''}</span>
        </div>`)}
      ${S.navListsOpen && html`<button class="nav-item" onClick=${() => update(s => { s.dialog = { type: 'listName', mode: 'new' }; s.drawer = false; })}><${Icon} n="add" /><span class="label">新しいリストを作成</span></button>`}
      <div class="nav-sep"></div>
      <button class=${'nav-head' + (S.navMembersOpen ? '' : ' closed')} onClick=${() => update(s => { s.navMembersOpen = !s.navMembersOpen; local.set('navMembersOpen', s.navMembersOpen); })}>
        <span class="grow" style="text-align:left">メンバー</span><${Icon} n="expand_more" />
      </button>
      ${S.navMembersOpen && activeMembers().map(m => {
        const n = st.open.filter(t => t.assignee === m.id).length;
        const late = st.b.overdue.some(t => t.assignee === m.id);
        return html`<button key=${m.id} class=${'nav-member' + (S.view.type === 'member' && S.view.id === m.id && !S.search ? ' active' : '')} onClick=${() => go({ type: 'member', id: m.id })}>
          <${Avatar} id=${m.id} size=${24} /><span class="nm">${m.name}${m.id === S.operator ? '（自分）' : ''}</span>
          <span class=${'count' + (late ? ' red' : '')} title=${late ? '期限切れがあります' : ''}>${n || ''}</span>
        </button>`;
      })}
      <div class="nav-sep"></div>
      ${item('delete', 'ごみ箱', { type: 'trash' })}
    </nav>`;
  }

  /* ---------- すべてのタスク（リストを横に並べる） ---------- */
  function Board() {
    const shown = CUR.listArr.filter(l => !S.hidden[l.id]);
    return html`<div class="board">
      ${shown.map(l => html`<${ListCard} key=${l.id} list=${l} />`)}
      ${!shown.length && html`<div class="empty" style="margin:auto">左の「リスト」で、表示するリストにチェックを入れてください</div>`}
      <button class="new-list-card" onClick=${() => update(s => { s.dialog = { type: 'listName', mode: 'new' }; })}><${Icon} n="add" />新しいリストを作成</button>
    </div>`;
  }

  function ListCard({ list, wide }) {
    const [adding, setAdding] = useState(false);
    const all = CUR.byList[list.id] || [];
    const open = all.filter(t => t.status !== 'done' || S.completing[t.id]);
    const openIds = {};
    open.forEach(t => { openIds[t.id] = 1; });
    const done = all.filter(t => t.status === 'done' && !S.completing[t.id])
      .concat(Object.values(CUR.children).flat().filter(c => openIds[c.parentId] && c.status === 'done' && !S.completing[c.id] && c.listId === list.id))
      .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
    const expanded = !!S.expandedDone[list.id];
    const mode = list.sortMode || 'my';
    const groups = groupsFor(list, open);
    const canDrag = mode === 'my';
    const dropEnd = S.drop && S.drop.listId === list.id && !S.drop.before;

    const onDragOver = e => {
      if (!S.drag) return;
      e.preventDefault();
      const row = e.target.closest && e.target.closest('.task:not(.sub)');
      let before = null;
      if (row && canDrag) {
        const r = row.getBoundingClientRect();
        const id = row.getAttribute('data-id');
        if (e.clientY < r.top + r.height / 2) before = id;
        else {
          const items = groups[0] ? groups[0].items : [];
          const i = items.findIndex(t => t.id === id);
          before = items[i + 1] ? items[i + 1].id : null;
        }
      }
      if (!S.drop || S.drop.listId !== list.id || S.drop.before !== before) update(s => { s.drop = { listId: list.id, before: before }; });
    };
    const onDrop = e => {
      e.preventDefault();
      const drag = S.drag;
      const drop = S.drop;
      update(s => { s.drag = null; s.drop = null; });
      if (!drag || !drop) return;
      const t = CUR.tasks[drag];
      if (!t) return;
      const items = sortMy(openOf(list.id).filter(x => x.id !== drag && x.status !== 'done'));
      let idx = drop.before ? items.findIndex(x => x.id === drop.before) : items.length;
      if (idx < 0) idx = items.length;
      if (!canDrag) idx = S.prefs.addToTop ? 0 : items.length;
      const prev = items[idx - 1];
      const next = items[idx];
      const order = prev && next ? (prev.sortOrder + next.sortOrder) / 2 : prev ? prev.sortOrder + 1024 : next ? next.sortOrder - 1024 : 0;
      const patch = { sortOrder: order };
      if (t.listId !== list.id) patch.listId = list.id;
      if (t.listId === list.id && t.sortOrder === order) return;
      act.updateTask(t.id, patch);
      if (patch.listId) snack('「' + list.name + '」に移動しました');
    };

    return html`<section class=${'card' + (wide ? ' wide' : '') + (S.drop && S.drop.listId === list.id ? ' drop-card' : '')} onDragOver=${onDragOver} onDrop=${onDrop}>
      <header class="card-head">
        <h2 class="card-title" title=${list.name}>${list.name}</h2>
        <button class="icon-btn" aria-label="リストのメニュー" onClick=${e => openPop(e, 'listMenu', { listId: list.id })}><${Icon} n="more_vert" /></button>
      </header>
      ${mode !== 'my' && html`<div class="card-sub">並べ替え: ${SORT_LABEL[mode]}</div>`}
      <div class="card-scroll">
        ${adding
          ? html`<${AddForm} listId=${list.id} onClose=${() => setAdding(false)} />`
          : html`<button class="add-task" onClick=${() => setAdding(true)}><${Icon} n="add" />タスクを追加</button>`}
        <div class=${'task-list' + (dropEnd ? ' drop-end' : '')}>
          ${groups.map(g => html`
            ${g.label && html`<div class=${'group-head' + (g.red ? ' red' : '')}>${g.label}</div>`}
            ${g.items.map(t => html`<${TaskRow} key=${t.id} task=${t} draggable=${true} />`)}`)}
        </div>
        ${!open.length && !adding && html`<${Empty} allDone=${done.length > 0} />`}
        ${done.length > 0 && html`<div class="done-sec">
          <button class="done-head" onClick=${() => update(s => { s.expandedDone[list.id] = !expanded; })}>
            <${Icon} n=${expanded ? 'expand_more' : 'chevron_right'} />完了（${done.length}件）
          </button>
          ${expanded && done.map(t => html`<${TaskRow} key=${t.id} task=${t} done sub=${!!t.parentId} />`)}
        </div>`}
      </div>
    </section>`;
  }

  const SORT_LABEL = { my: '自分の並べ替え順', do: 'いつやる', date: '期限', starred: 'スター付き（最近）', title: 'タイトル', assignee: '担当者' };
  function Empty({ allDone }) {
    return html`<div class="empty">
      <svg viewBox="0 0 160 120" aria-hidden="true">
        <circle cx="80" cy="62" r="40" fill="var(--primary-soft)" />
        <path d="M62 63l12 12 25-27" fill="none" stroke="var(--primary)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M28 30l4 9 9 4-9 4-4 9-4-9-9-4 9-4zM132 20l3 6 6 3-6 3-3 6-3-6-6-3 6-3zM134 84l2.5 5 5 2.5-5 2.5-2.5 5-2.5-5-5-2.5 5-2.5z" fill="var(--orange)" opacity=".8" />
      </svg>
      ${allDone
        ? html`<div class="em-title">すべてのタスクを完了しました</div><div>おつかれさまでした！</div>`
        : html`<div class="em-title">タスクはまだありません</div><div>「タスクを追加」から登録できます</div>`}
    </div>`;
  }

  function TaskRow({ task: t, done, sub, showList, draggable, hideAsk, hideWho }) {
    const completing = !!S.completing[t.id];
    const overdue = !done && isOverdue(t);
    const isToday = !done && !overdue && t.due === todayYmd();
    const doLate = !done && isDoLate(t);
    const doToday = !done && !doLate && t.doDate === todayYmd();
    const asker = !t.parentId && !hideAsk && t.createdBy && t.createdBy !== t.assignee ? memberName(t.createdBy) : '';
    const allKids = !t.parentId ? (CUR.children[t.id] || []) : [];
    const openKids = !done ? allKids.filter(c => c.status !== 'done' || S.completing[c.id]) : [];
    const doneKids = allKids.filter(c => c.status === 'done').length;
    const parent = t.parentId ? CUR.tasks[t.parentId] : null;
    const showWho = !hideWho && t.assignee && (!parent || parent.assignee !== t.assignee);
    const cls = ['task', done && 'is-done', completing && 'completing', (sub || t.parentId) && 'sub', S.selected === t.id && 'selected',
      S.flash[t.id] && 'flash', t._pending && 'pending', S.drop && S.drop.before === t.id && 'drop-before', S.drag === t.id && 'dragging'].filter(Boolean).join(' ');
    const canDrag = draggable && !t.parentId && !done;
    return html`<div>
      <div class=${cls} data-id=${t.id} draggable=${canDrag ? 'true' : 'false'}
        onDragStart=${canDrag ? e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); setTimeout(() => update(s => { s.drag = t.id; }), 0); } : undefined}
        onDragEnd=${canDrag ? () => update(s => { s.drag = null; s.drop = null; }) : undefined}
        onClick=${() => openTask(t.id)}>
        <button class="check" aria-label=${done ? '未完了に戻す' : '完了にする'} title=${done ? '未完了に戻す' : '完了にする'}
          onClick=${e => { e.stopPropagation(); if (done) uncomplete(t); else complete(t); }}>
          <span class="circle"></span><${Icon} n="check" cls="tick" />
        </button>
        <div class="t-body">
          <div class="t-title">${t.title}</div>
          ${t.details && !done && html`<div class="t-details">${t.details}</div>`}
          <div class="t-meta">
            ${showList && html`<span class="chip list">${listName(t.listId)}</span>`}
            ${t.doDate && !done && html`<span class=${'chip do' + (doLate ? ' late' : doToday ? ' now' : '')} title=${'いつやる: ' + mdLabel(t.doDate) + (t.repeat ? '（' + rrLabel(t.repeat, t.doDate) + '）' : '')}><${Icon} n="today" />やる ${shortWord(t.doDate, t.doTime)}${doLate ? ' 過ぎ' : ''}${t.repeat && html`<${Icon} n="repeat" />`}</span>`}
            ${t.due && !done && html`<span class=${'chip' + (overdue ? ' red' : isToday ? ' today' : '')} title=${'期限（いつまでに）: ' + mdLabel(t.due)}><${Icon} n="event" />期限 ${shortWord(t.due, t.dueTime)}${overdue ? ' 期限切れ' : ''}${t.repeat && !t.doDate && html`<${Icon} n="repeat" />`}</span>`}
            ${!t.due && t.repeat && t.doDate && !done && html`<span class="chip muted-chip" title="繰り返しのタスクで、期限を決めていません">期限なし</span>`}
            ${showWho && !done && html`<span class="chip who" title=${asker ? asker + 'さんからの依頼' : '担当'}><${Avatar} id=${t.assignee} size=${18} />${memberName(t.assignee)}${asker && html`<span class="from">← ${asker}</span>`}</span>`}
            ${!showWho && asker && !done && html`<span class="chip ask" title="このタスクを頼んだ人"><${Icon} n="outbox" />${asker}さんから</span>`}
            ${t.status === 'doing' && !done && html`<span class="chip doing">進行中</span>`}
            ${allKids.length > 0 && html`<span class="chip" title="サブタスク"><${Icon} n="subdirectory_arrow_right" />${doneKids}/${allKids.length}</span>`}
            ${done && t.completedAt && html`<span class="muted" style="font-size:12px">完了: ${fmtAt(t.completedAt)}${t.completedBy && memberName(t.completedBy) ? '（' + memberName(t.completedBy) + '）' : ''}</span>`}
          </div>
          ${t.noteText && !done && html`<div class="t-note"><${Icon} n="chat" /><div class="grow" style="min-width:0"><div class="txt">${t.noteText}</div><div class="muted">${memberName(t.noteBy)}・${fmtRel(t.noteAt)}</div></div></div>`}
        </div>
        ${!done && html`<button class=${'star' + (t.starred ? ' on' : '')} aria-label=${t.starred ? 'スターを外す' : 'スターを付ける'} onClick=${e => { e.stopPropagation(); toggleStar(t); }}><${Icon} n=${t.starred ? 'star' : 'star_border'} /></button>`}
        <button class="more" aria-label="タスクのメニュー" onClick=${e => { e.stopPropagation(); openPop(e, 'taskMenu', { id: t.id }); }}><${Icon} n="more_vert" /></button>
      </div>
      ${openKids.map(c => html`<${TaskRow} key=${c.id} task=${c} sub />`)}
    </div>`;
  }

  /* ---------- タスクの追加（その場で入力） ---------- */
  const NO_DATES = { doDate: '', doTime: '', due: '', dueTime: '', repeat: '' };
  // 期限が必要か（繰り返しのタスクは「いつやる」があれば期限なしでよい）
  const needsDue = v => !v.due && !(v.repeat && v.doDate);
  function AddForm({ listId, onClose, inDialog, assignee: presetWho, showList }) {
    const [title, setTitle] = useState('');
    const [details, setDetails] = useState('');
    const [dates, setDates] = useState(NO_DATES);
    const [assignee, setAssignee] = useState(presetWho || S.operator || '');
    const [lid, setLid] = useState(listId || (CUR.listArr[0] && CUR.listArr[0].id));
    const [err, setErr] = useState('');
    const titleRef = useRef(null);
    const boxRef = useRef(null);
    useEffect(() => { if (titleRef.current) titleRef.current.focus(); }, []);
    useEffect(() => {
      if (inDialog) return undefined;
      const h = e => {
        if (!boxRef.current || boxRef.current.contains(e.target)) return;
        if (e.target.closest && e.target.closest('.popover, .pop-scrim, .dialog, .dlg-scrim')) return;
        if (!titleRef.current || !titleRef.current.value.trim()) onClose();
      };
      document.addEventListener('mousedown', h);
      return () => document.removeEventListener('mousedown', h);
    }, []);
    const setD = patch => { setDates(prev => Object.assign({}, prev, patch)); setErr(''); };
    const submit = () => {
      const tt = title.trim();
      if (!tt) { setErr('title'); if (titleRef.current) titleRef.current.focus(); return false; }
      if (!assignee) { setErr('who'); return false; }
      if (needsDue(dates)) { setErr('due'); return false; }
      act.createTask(Object.assign({ id: uid(), listId: lid, title: tt, details: details.trim(), assignee: assignee, sortOrder: newSortOrder(lid) }, dates));
      if (assignee !== S.operator) snack(memberName(assignee) + 'さんにタスクを依頼しました');
      setTitle('');
      setDetails('');
      setErr('');
      if (titleRef.current) titleRef.current.focus();
      return true;
    };
    const errMsg = {
      title: 'タスク名（何を）を入れてください', who: '担当者（誰が）を選んでください',
      due: dates.repeat ? '期限（いつまでに）か「いつやる」を選んでください' : '期限（いつまでに）を選んでください',
    }[err];
    const onKey = e => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); const ok = submit(); if (ok && inDialog) onClose(); }
      if (e.key === 'Escape' && !inDialog) { e.stopPropagation(); onClose(); }
    };
    const dateCtx = kind => ({ kind: kind, value: dates, top: true, onChange: setD });
    const other = assignee && assignee !== S.operator;
    return html`<div class="add-form" ref=${boxRef} style=${inDialog ? 'border:0;padding:0' : ''}>
      ${!inDialog && html`<div class="ph"><span></span></div>`}
      <div class="af-body">
        <input ref=${titleRef} class="af-title" placeholder="タイトル（何を）" value=${title}
          onInput=${e => { setTitle(e.target.value); if (err === 'title') setErr(''); }} onKeyDown=${onKey} />
        <input class="af-details" placeholder="詳細（どのように・任意）" value=${details} onInput=${e => setDetails(e.target.value)} onKeyDown=${onKey} />
        <div class="af-chips">
          <button class=${'chip-btn' + (dates.doDate ? ' set' : '')} title="いつやる（任意）"
            onClick=${e => openPop(e, 'date', dateCtx('do'))}>
            <${Icon} n="today" />${dates.doDate ? 'やる: ' + doLabel(dates) : 'いつやる'}
          </button>
          <button class=${'chip-btn' + (dates.due || !needsDue(dates) ? ' set' : '') + (err === 'due' ? ' error' : '')} title="期限（いつまでに）"
            onClick=${e => openPop(e, 'date', dateCtx('due'))}>
            <${Icon} n="event" />${dates.due ? '期限: ' + dueLabel(dates) : !needsDue(dates) ? '期限なし' : '期限（いつまでに）'}
          </button>
          <button class=${'chip-btn' + (dates.repeat ? ' set' : '')} title="繰り返し"
            onClick=${e => openPop(e, 'repeatMenu', { value: dates, onChange: setD })}>
            <${Icon} n="repeat" />${dates.repeat ? rrLabel(dates.repeat, dates.doDate || dates.due) : '繰り返し'}
          </button>
          <button class=${'chip-btn' + (assignee ? ' set' : '') + (err === 'who' ? ' error' : '')}
            onClick=${e => openPop(e, 'member', { value: assignee, onChange: v => { setAssignee(v); setErr(''); } })}>
            ${assignee ? html`<${Avatar} id=${assignee} size=${20} />` : html`<${Icon} n="person" />`}${assignee ? memberName(assignee) : '担当者（誰が）'}
          </button>
          ${(inDialog || showList) && html`<select class="input" style="width:auto;height:32px;padding:0 8px" aria-label="リスト" value=${lid} onChange=${e => setLid(e.target.value)}>
            ${CUR.listArr.map(l => html`<option value=${l.id}>${l.name}</option>`)}
          </select>`}
        </div>
        ${errMsg ? html`<div class="af-err">${errMsg}</div>`
          : other ? html`<div class="af-hint ask"><${Icon} n="outbox" />${memberName(assignee)}さんにタスクを依頼します（相手の画面に知らせが出ます）</div>`
          : html`<div class="af-hint">Enterで登録。誰が・いつまでに・何を、の3つが必要です（いつやるは任意）</div>`}
        ${inDialog && html`<div class="dlg-actions"><button class="btn text" onClick=${onClose}>キャンセル</button><button class="btn primary" onClick=${() => { if (submit()) onClose(); }}>作成</button></div>`}
      </div>
    </div>`;
  }

  /* ---------- 詳細パネル ---------- */
  function DetailPanel({ id }) {
    const t = CUR.tasks[id];
    const [detail, setDetail] = useState(null);
    const [note, setNote] = useState('');
    const [reason, setReason] = useState(null);
    const [reasonText, setReasonText] = useState('');
    const [subTitle, setSubTitle] = useState('');
    const subRef = useRef(null);
    const ver = t ? t.version + ':' + (t.noteAt || '') : '';
    useEffect(() => {
      if (!t || t._pending) return undefined;
      let alive = true;
      call('taskDetail', { id: id }).then(d => { if (alive) setDetail(d); }).catch(() => {});
      return () => { alive = false; };
    }, [id, ver]);

    const close = () => update(s => { s.selected = null; s.remote = null; });
    if (!t) {
      return html`<aside class="panel"><div class="panel-head"><button class="icon-btn" aria-label="閉じる" onClick=${close}><${Icon} n="close" /></button></div>
        <div class="panel-body"><div class="notice warn">このタスクは削除されたか、見つかりません。${S.remote && S.remote.deleted ? '（' + memberName(S.remote.by) + 'さんが削除しました）' : ''}</div></div></aside>`;
    }
    const top = !t.parentId;
    const parent = t.parentId ? CUR.tasks[t.parentId] : null;
    const kids = CUR.children[t.id] || [];
    const overdue = isOverdue(t);
    const remote = S.remote && S.remote.id === id && !S.remote.deleted ? S.remote : null;
    const notes = (detail && detail.id === id ? detail.notes : []).slice();
    if (t.noteText && (!notes.length || notes[0].at !== t.noteAt)) notes.unshift({ id: 'pending', text: t.noteText, by: t.noteBy, at: t.noteAt, pending: !!t._notePending });
    const hist = detail && detail.id === id ? detail.history : null;

    const sendNote = () => {
      const v = note.trim();
      if (!v) return;
      act.addNote(id, v);
      setNote('');
    };
    const changeDates = v => {
      const patch = {};
      ['doDate', 'doTime', 'due', 'dueTime', 'repeat'].forEach(k => { if (k in v && (v[k] || '') !== (t[k] || '')) patch[k] = v[k] || ''; });
      if (!Object.keys(patch).length) return;
      if (top && needsDue(Object.assign({}, t, patch))) { snack('期限（いつまでに）は必須です。繰り返しのタスクは「いつやる」があれば期限なしにできます', { kind: 'error' }); return; }
      if (patch.due && t.due && patch.due > t.due && top) { setReason({ from: t.due, to: patch.due }); setReasonText(''); }
      act.updateTask(id, patch);
    };
    const dateValue = { doDate: t.doDate || '', doTime: t.doTime || '', due: t.due || '', dueTime: t.dueTime || '', repeat: t.repeat || '' };
    const asker = top && t.createdBy && t.createdBy !== t.assignee ? memberName(t.createdBy) : '';
    const doLate = isDoLate(t);
    const next = t.repeat && t.status !== 'done' ? rrNext(t.repeat, t.doDate || t.due, t.repeatIndex) : '';
    const addSub = () => {
      const v = subTitle.trim();
      if (!v) return;
      const max = kids.reduce((a, c) => Math.max(a, c.sortOrder || 0), 0);
      act.createTask({ id: uid(), parentId: id, listId: t.listId, title: v, sortOrder: max + 1024 });
      setSubTitle('');
    };
    const setStatus = s => {
      if (s === t.status) return;
      if (s === 'done') complete(t);
      else act.updateTask(id, { status: s });
    };

    return html`<aside class="panel" aria-label="タスクの詳細">
      <div class="panel-head">
        <button class="icon-btn" aria-label="閉じる" onClick=${close}><${Icon} n=${window.innerWidth <= 900 ? 'arrow_back' : 'close'} /></button>
        ${top
          ? html`<select class="input" style="width:auto;height:36px" aria-label="リスト" value=${t.listId} onChange=${e => act.updateTask(id, { listId: e.target.value })}>
              ${CUR.listArr.map(l => html`<option value=${l.id}>${l.name}</option>`)}
            </select>`
          : html`<div class="p-parent"><${Icon} n="subdirectory_arrow_right" />サブタスク：<a onClick=${() => parent && openTask(parent.id)}>${parent ? parent.title : ''}</a></div>`}
        <span class="grow"></span>
        <button class=${'star' + (t.starred ? ' on' : '')} style="opacity:1" aria-label="スター" onClick=${() => toggleStar(t)}><${Icon} n=${t.starred ? 'star' : 'star_border'} /></button>
        <button class="icon-btn" aria-label="削除" title="削除" onClick=${() => act.deleteTask(t)}><${Icon} n="delete" /></button>
      </div>
      <div class="panel-body">
        ${remote && html`<div class="remote"><${Icon} n="sync" /><span>${memberName(remote.by) || 'ほかの人'}さんがこのタスクを更新しました（${fmtRel(new Date(remote.at).toISOString())}）。最新の内容を表示しています。</span></div>`}
        <div class="p-title-row">
          <button class="check" aria-label="完了" onClick=${() => (t.status === 'done' ? uncomplete(t) : complete(t))}>
            <span class="circle" style=${t.status === 'done' ? 'background:var(--primary);border-color:var(--primary)' : ''}></span>
            <${Icon} n="check" cls="tick" />
          </button>
          <${EditableText} key=${id + ':title'} value=${t.title} cls="p-title" single placeholder="タイトル（何を）"
            onSave=${v => { if (v.trim()) act.updateTask(id, { title: v.trim() }); }} />
        </div>
        <${EditableText} key=${id + ':details'} value=${t.details || ''} cls="p-details" placeholder="詳細を追加（どのように・任意）"
          onSave=${v => act.updateTask(id, { details: v })} />

        <div class="field">
          <label><${Icon} n="person" />誰が${top && html`<span class="req">必須</span>`}</label>
          <button class="field-btn" onClick=${e => openPop(e, 'member', { value: t.assignee, optional: !top, onChange: v => { if (v !== t.assignee) act.updateTask(id, { assignee: v }); } })}>
            ${t.assignee ? html`<${Avatar} id=${t.assignee} size=${24} />${memberName(t.assignee)}` : html`<span class="muted">${top ? '担当者を選ぶ' : '（親タスクと同じ）'}</span>`}
            ${asker && html`<span class="ask-note"><${Icon} n="outbox" />依頼: ${asker}</span>`}
          </button>
        </div>
        <div class="field">
          <label><${Icon} n="today" />いつやる</label>
          <button class=${'field-btn' + (doLate ? ' orange' : '')} onClick=${e => openPop(e, 'date', { kind: 'do', value: dateValue, top: top, onChange: changeDates })}>
            ${t.doDate ? html`${mdLabel(t.doDate)}${t.doTime ? ' ' + t.doTime : ''}${doLate ? '（やる日を過ぎています）' : ''}` : html`<span class="muted">やる日を決める（任意）</span>`}
          </button>
        </div>
        <div class="field">
          <label><${Icon} n="event" />いつまでに${top && (t.repeat ? html`<span class="req soft" title="繰り返しのタスクは「いつやる」があれば期限なしにできます">任意</span>` : html`<span class="req">必須</span>`)}</label>
          <button class=${'field-btn' + (overdue ? ' red' : '')} onClick=${e => openPop(e, 'date', { kind: 'due', value: dateValue, top: top, onChange: changeDates })}>
            ${t.due ? html`${mdLabel(t.due)}${t.dueTime ? ' ' + t.dueTime : ''}${overdue ? '（期限切れ）' : ''}` : html`<span class="muted">${!top ? '（親タスクと同じ）' : t.repeat && t.doDate ? '期限なし（繰り返し）' : '期限を選ぶ'}</span>`}
          </button>
        </div>
        ${top && html`<div class="field">
          <label><${Icon} n="repeat" />繰り返し</label>
          <button class="field-btn" onClick=${e => openPop(e, 'repeatMenu', { value: dateValue, onChange: changeDates })}>
            ${t.repeat ? html`<span>${rrLabel(t.repeat, t.doDate || t.due)}</span>${next && html`<span class="muted" style="font-size:12px">次の回: ${mdLabel(next)}</span>`}` : html`<span class="muted">繰り返さない</span>`}
          </button>
        </div>`}
        ${reason && html`<div class="reason">
          <div style="font-size:13px;font-weight:600;margin-bottom:6px">期限を ${mdLabel(reason.from)} → ${mdLabel(reason.to)} に延ばしました。理由を残しますか？（任意）</div>
          <textarea rows="2" placeholder="例: 先方の返事待ちのため" value=${reasonText} onInput=${e => setReasonText(e.target.value)}></textarea>
          <div class="dlg-actions" style="margin-top:8px">
            <button class="btn text sm" onClick=${() => setReason(null)}>残さない</button>
            <button class="btn primary sm" disabled=${!reasonText.trim()} onClick=${() => { act.addNote(id, '期限を ' + mdLabel(reason.from) + ' → ' + mdLabel(reason.to) + ' に延長。理由: ' + reasonText.trim()); setReason(null); }}>記録する</button>
          </div>
        </div>`}
        <div class="field">
          <label><${Icon} n="flag" />ステータス</label>
          <div class="seg">${['todo', 'doing', 'done'].map(s => html`<button class=${t.status === s ? 'on' : ''} onClick=${() => setStatus(s)}>${STATUS_LABEL[s]}</button>`)}</div>
        </div>

        ${top && html`<div>
          <div class="sec-title"><${Icon} n="subdirectory_arrow_right" />サブタスク${kids.length ? '（' + kids.filter(k => k.status === 'done').length + '/' + kids.length + '）' : ''}</div>
          ${kids.map(c => html`<div key=${c.id} class=${'sub-row' + (c.status === 'done' ? ' done' : '')}>
            <button class="check" aria-label="完了" onClick=${() => (c.status === 'done' ? uncomplete(c) : act.updateTask(c.id, { status: 'done' }))}><span class="circle"></span><${Icon} n="check" cls="tick" /></button>
            <${EditableText} key=${c.id + ':t'} value=${c.title} single onSave=${v => { if (v.trim()) act.updateTask(c.id, { title: v.trim() }); }} />
            ${(c.assignee || c.due) && html`<span class="meta">${c.assignee ? memberName(c.assignee) : ''} ${c.due ? dueLabel(c) : ''}</span>`}
            <button class="icon-btn sm" aria-label="サブタスクの詳細" onClick=${() => openTask(c.id)}><${Icon} n="chevron_right" /></button>
          </div>`)}
          <div class="sub-add"><${Icon} n="add" />
            <input ref=${subRef} placeholder="サブタスクを追加" value=${subTitle} onInput=${e => setSubTitle(e.target.value)}
              onKeyDown=${e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); addSub(); } }} onBlur=${addSub} />
          </div>
        </div>`}

        <div class="sec-title"><${Icon} n="chat" />最新状況</div>
        <div class="note-box">
          <textarea class="note-input" rows="3" placeholder="今の状況を書く（例: 下書きまで完了。明日の午前に送る）" value=${note}
            onInput=${e => setNote(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendNote(); } }}></textarea>
          <div class="note-actions"><span class="muted">書いた内容は日時と名前つきで残り、メールにも載ります</span>
            <button class="btn primary sm" disabled=${!note.trim()} onClick=${sendNote}><${Icon} n="send" />記録する</button></div>
        </div>
        <div class="timeline">
          ${notes.map((n, i) => html`<div key=${n.id} class=${'tl-item' + (i === 0 ? ' latest' : '')}>
            <${Avatar} id=${n.by} size=${28} />
            <div class="tl-body"><div class="tl-head">${memberName(n.by) || '（不明）'}・${fmtAt(n.at)}${n.pending ? '（保存中）' : ''}${i === 0 ? '・最新' : ''}</div><div class="tl-text">${n.text}</div></div>
          </div>`)}
          ${!notes.length && html`<div class="muted" style="font-size:13px">まだ入力がありません</div>`}
        </div>

        <details class="hist">
          <summary><${Icon} n="history" />変更の記録</summary>
          ${!hist ? html`<div class="muted">読み込み中…</div>` : hist.map(h => html`<div key=${h.id} class="hist-item">${fmtAt(h.at)}　${memberName(h.by) || '（不明）'}：${histText(h)}</div>`)}
        </details>
        <div class="p-foot">
          作成: ${fmtAt(t.createdAt)}（${memberName(t.createdBy) || '不明'}）<br/>
          更新: ${fmtAt(t.updatedAt)}（${memberName(t.updatedBy) || '不明'}）
          ${t.completedAt && html`<br/>完了: ${fmtAt(t.completedAt)}（${memberName(t.completedBy) || '不明'}）${t.onTime === false ? '・期限後に完了' : t.onTime === true ? '・期限内に完了' : ''}`}
        </div>
      </div>
    </aside>`;
  }

  const FIELD_LABEL = { title: 'タスク名', assignee: '担当者', due: '期限', dueTime: '期限の時刻', doDate: 'いつやる', doTime: 'いつやるの時刻', status: 'ステータス', listId: 'リスト', repeat: '繰り返し' };
  function histVal(field, v) {
    if (v === '' || v === undefined) return '（なし）';
    if (field === 'assignee') return memberName(v) || v;
    if (field === 'status') return STATUS_LABEL[v] || v;
    if (field === 'listId') return listName(v) || '（削除されたリスト）';
    if (field === 'due' || field === 'doDate') return mdLabel(v);
    if (field === 'repeat') return rrLabel(v, '');
    return v;
  }
  function histText(h) {
    if (h.action === 'create') return h.field === 'repeat' ? '繰り返しで作成しました' : '作成しました';
    if (h.action === 'delete') return '削除しました';
    if (h.action === 'restore') return 'ごみ箱から戻しました';
    return (FIELD_LABEL[h.field] || h.field) + 'を「' + histVal(h.field, h.before) + '」→「' + histVal(h.field, h.after) + '」に変更';
  }

  /** 入力中は自分の下書きを表示し、離れたときに保存する。入力中に他の人が変えたら知らせる */
  function EditableText({ value, onSave, cls, placeholder, single }) {
    const [draft, setDraft] = useState(null);
    const base = useRef(value);
    const skip = useRef(false);
    const ref = useRef(null);
    const editing = draft !== null;
    const shown = editing ? draft : value;
    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    });
    return html`<div class="et">
      <textarea ref=${ref} rows="1" class=${cls || ''} placeholder=${placeholder || ''} value=${shown}
        onFocus=${() => { base.current = value; skip.current = false; setDraft(value); }}
        onInput=${e => setDraft(e.target.value)}
        onKeyDown=${e => {
          if (single && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.target.blur(); }
          if (e.key === 'Escape') { e.stopPropagation(); skip.current = true; e.target.blur(); }
        }}
        onBlur=${e => {
          const d = e.target.value;
          setDraft(null);
          if (!skip.current && d !== base.current) onSave(d);
        }}></textarea>
      ${editing && value !== base.current && html`<div class="conflict">入力中に、ほかの人がここを変更しました（このまま保存すると上書きします）</div>`}
    </div>`;
  }

  /* ---------- スター付き・自分の担当・検索 ---------- */
  function StarredView() {
    const items = Object.values(CUR.tasks).filter(t => t.starred && t.status !== 'done' && !t.deletedAt && CUR.lists[t.listId])
      .sort((a, b) => (a.starredAt < b.starredAt ? 1 : -1));
    return html`<div class="single"><section class="card wide">
      <header class="card-head"><h2 class="card-title">スター付き</h2></header>
      <div class="card-sub">スターを付けたタスク（最近付けた順）</div>
      <div class="card-scroll">
        ${items.map(t => html`<${TaskRow} key=${t.id} task=${t} showList />`)}
        ${!items.length && html`<div class="empty"><div class="em-title">スター付きのタスクはありません</div><div>大事なタスクに ☆ を付けると、ここに集まります</div></div>`}
      </div>
    </section></div>`;
  }

  /* ---------- メンバーごとのタスク（自分の担当もここ） ---------- */
  function MemberView({ id, mine }) {
    const [adding, setAdding] = useState(false);
    const [showDone, setShowDone] = useState(false);
    const tab = S.memberTab === 'asked' ? 'asked' : 'assigned';
    const setTab = v => update(s => { s.memberTab = v; });
    const name = memberName(id);
    const live = t => !t.deletedAt && CUR.lists[t.listId] && !t.parentId;
    const all = Object.values(CUR.tasks).filter(live);
    const assigned = all.filter(t => t.assignee === id);
    const asked = all.filter(t => t.createdBy === id && t.assignee !== id);
    const base = tab === 'asked' ? asked : assigned;
    const open = base.filter(t => t.status !== 'done' || S.completing[t.id]);
    const done = base.filter(t => t.status === 'done' && !S.completing[t.id]).sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1)).slice(0, 50);
    const groups = groupBy(open.slice().sort((a, b) => whenAt(a) - whenAt(b) || dueAt(a) - dueAt(b)), whenBucket);
    const openCount = arr => arr.filter(t => t.status !== 'done').length;
    const isMe = id === S.operator;
    return html`<div class="single"><section class="card wide">
      <header class="card-head member-head">
        <${Avatar} id=${id} size=${36} />
        <h2 class="card-title">${mine ? '自分の担当' : name + 'さんのタスク'}</h2>
      </header>
      <div class="card-sub">${name}さん${tab === 'asked' ? 'がほかの人に頼んだ、終わっていないタスク' : 'が担当の、終わっていないタスク'}（期限・いつやるの近い順）</div>
      <div class="tabs member-tabs">
        <button class=${tab === 'assigned' ? 'on' : ''} onClick=${() => setTab('assigned')}>担当（${openCount(assigned)}）</button>
        <button class=${tab === 'asked' ? 'on' : ''} onClick=${() => setTab('asked')}>依頼したタスク（${openCount(asked)}）</button>
      </div>
      <div class="card-scroll">
        ${tab === 'assigned' && (adding
          ? html`<${AddForm} key=${'add:' + id} assignee=${id} showList onClose=${() => setAdding(false)} />`
          : html`<button class="add-task" onClick=${() => setAdding(true)}><${Icon} n=${isMe ? 'add' : 'person_add'} />${isMe ? 'タスクを追加' : name + 'さんにタスクを依頼'}</button>`)}
        ${groups.map(g => html`<div class=${'group-head' + (g.red ? ' red' : '')}>${g.label}（${g.items.length}）</div>
          ${g.items.map(t => html`<${TaskRow} key=${t.id} task=${t} showList hideAsk=${tab === 'asked'} hideWho=${tab === 'assigned'} />`)}`)}
        ${!open.length && !adding && html`<div class="empty"><div class="em-title">${tab === 'asked' ? '頼んでいるタスクはありません' : '終わっていないタスクはありません'}</div>
          ${tab === 'assigned' && !isMe ? html`<div>「${name}さんにタスクを依頼」から登録できます</div>` : ''}</div>`}
        ${done.length > 0 && html`<div class="done-sec">
          <button class="done-head" onClick=${() => setShowDone(!showDone)}><${Icon} n=${showDone ? 'expand_more' : 'chevron_right'} />完了（${done.length}件${done.length >= 50 ? '・新しい50件' : ''}）</button>
          ${showDone && done.map(t => html`<${TaskRow} key=${t.id} task=${t} done showList />`)}
        </div>`}
      </div>
    </section></div>`;
  }

  function SearchView() {
    const words = S.search.trim().toLowerCase().split(/\s+/);
    const hits = Object.values(CUR.tasks).filter(t => {
      if (t.deletedAt || !CUR.lists[t.listId]) return false;
      const hay = (t.title + ' ' + (t.details || '') + ' ' + (t.noteText || '') + ' ' + memberName(t.assignee)).toLowerCase();
      return words.every(w => hay.indexOf(w) >= 0);
    }).sort((a, b) => (a.status === 'done') - (b.status === 'done') || dueAt(a) - dueAt(b));
    return html`<div class="single"><section class="card wide">
      <header class="card-head"><h2 class="card-title">検索: ${S.search}</h2></header>
      <div class="card-sub">${hits.length}件見つかりました（タスク名・詳細・最新状況・担当者から探します）</div>
      <div class="card-scroll">${hits.map(t => html`<${TaskRow} key=${t.id} task=${t} done=${t.status === 'done'} showList />`)}</div>
    </section></div>`;
  }

  /* ---------- 進捗ボード ---------- */
  function ProgressView() {
    const st = collect();
    const f = S.boardFilter;
    const setF = patch => update(s => { s.boardFilter = Object.assign({}, s.boardFilter, patch); });
    const pass = t => (!f.assignee || t.assignee === f.assignee) && (!f.listId || t.listId === f.listId);
    const sections = [
      { key: 'overdue', label: '期限切れ', items: st.b.overdue, cls: 'red', icon: 'warning' },
      { key: 'today', label: '今日まで', items: st.b.today, cls: 'orange', icon: 'event' },
      { key: 'todayDo', label: '今日やる予定（やる日を過ぎたものを含む）', items: st.b.todayDo, cls: '', icon: 'today' },
      { key: 'soon', label: st.cfg.soonDays + '日以内', items: st.b.soon, cls: '', icon: 'schedule' },
      { key: 'stale', label: st.cfg.staleDays + '日以上 更新が止まっている', items: st.b.stale, cls: '', icon: 'history' },
    ];
    const tile = (key, label, n, cls) => html`<button class=${'tile ' + cls + (key && f.bucket === key ? ' on' : '')} onClick=${() => setF({ bucket: f.bucket === key ? '' : key })}>
      <div class="tl">${label}</div><div class="tn">${n}</div></button>`;
    const num = (r, k, cls) => html`<td class="num"><button class=${r[k] ? cls : 'muted'} onClick=${() => setF({ assignee: r.id, bucket: ['overdue', 'today', 'todayDo', 'soon'].indexOf(k) >= 0 ? k : '' })}>${r[k]}</button></td>`;
    const shownSections = sections.filter(s => !f.bucket || s.key === f.bucket);
    return html`<div class="page">
      <h1>進捗ボード</h1>
      <p class="muted">本部全体のタスクの今の状況です。毎時のメールと同じ考え方で数えています。数字を押すと絞り込めます。</p>
      <div class="tiles">
        ${tile('', '未完了', st.open.length, '')}
        ${tile('overdue', '期限切れ', st.b.overdue.length, st.b.overdue.length ? 'red' : '')}
        ${tile('today', '今日まで', st.b.today.length, st.b.today.length ? 'orange' : '')}
        ${tile('todayDo', '今日やる', st.b.todayDo.length, st.b.todayDo.length ? 'teal' : '')}
        ${tile('soon', st.cfg.soonDays + '日以内', st.b.soon.length, '')}
        ${tile('stale', '更新が止まっている', st.b.stale.length, '')}
      </div>
      <div class="panel-card">
        <h2><${Icon} n="group" />担当者別</h2>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>担当</th><th class="num">期限切れ</th><th class="num">今日まで</th><th class="num">今日やる</th><th class="num">${st.cfg.soonDays}日以内</th><th class="num">進行中</th><th class="num">未着手</th><th class="num">今週の完了</th></tr></thead>
          <tbody>
            ${st.byAssignee.map(r => html`<tr key=${r.id} class=${f.assignee === r.id ? 'on' : ''}>
              <td><div style="display:flex;align-items:center;gap:2px">
                <button style="display:flex;align-items:center;gap:8px" title="この人で絞り込む" onClick=${() => setF({ assignee: f.assignee === r.id ? '' : r.id })}><${Avatar} id=${r.id} size=${24} />${memberName(r.id) || '（未設定）'}</button>
                ${CUR.members[r.id] && html`<button class="icon-btn sm" aria-label=${memberName(r.id) + 'さんのタスクを開く'} title="この人のタスクを開く" onClick=${() => go({ type: 'member', id: r.id })}><${Icon} n="chevron_right" /></button>`}
              </div></td>
              ${num(r, 'overdue', 'red')}${num(r, 'today', 'orange')}${num(r, 'todayDo', 'teal')}${num(r, 'soon', '')}${num(r, 'doing', '')}${num(r, 'todo', '')}${num(r, 'doneWeek', '')}
            </tr>`)}
            ${!st.byAssignee.length && html`<tr><td colspan="8" class="muted">タスクはまだありません</td></tr>`}
          </tbody>
        </table></div>
      </div>
      <div class="filters">
        <select value=${f.assignee} onChange=${e => setF({ assignee: e.target.value })}>
          <option value="">担当者: すべて</option>${activeMembers().map(m => html`<option value=${m.id}>${m.name}</option>`)}
        </select>
        <select value=${f.listId} onChange=${e => setF({ listId: e.target.value })}>
          <option value="">リスト: すべて</option>${CUR.listArr.map(l => html`<option value=${l.id}>${l.name}</option>`)}
        </select>
        ${(f.assignee || f.listId || f.bucket) && html`<button class="btn text sm" onClick=${() => setF({ assignee: '', listId: '', bucket: '' })}>絞り込みを解除</button>`}
      </div>
      ${shownSections.map(s => {
        const items = s.items.filter(pass);
        return html`<div class="panel-card" key=${s.key}>
          <h2><${Icon} n=${s.icon} />${s.label}（${items.length}件）</h2>
          ${items.map(t => html`<${TaskRow} key=${t.id} task=${t} showList />`)}
          ${!items.length && html`<div class="muted" style="padding:4px 20px 16px">ありません</div>`}
        </div>`;
      })}
    </div>`;
  }

  /* ---------- ごみ箱 ---------- */
  function TrashView() {
    const [busy, setBusy] = useState(false);
    const load = () => { setBusy(true); call('trash', {}).then(r => update(s => { s.trash = r.items; })).catch(e => snack(errText(e), { kind: 'error' })).then(() => setBusy(false)); };
    useEffect(() => { load(); }, []);
    const items = S.trash;
    return html`<div class="single"><section class="card wide">
      <header class="card-head"><h2 class="card-title">ごみ箱</h2><button class="icon-btn" aria-label="読み込み直す" onClick=${load}><${Icon} n="sync" /></button></header>
      <div class="card-sub">削除したタスクは30日間ここに残り、元に戻せます。30日たつと完全に消えます。</div>
      <div class="card-scroll">
        ${!items ? html`<div class="empty">${busy ? '読み込み中…' : ''}</div>` : items.map(it => html`<div key=${it.id} class="task" style="cursor:default">
          <div class="check"><${Icon} n="delete" /></div>
          <div class="t-body">
            <div class="t-title">${it.title}</div>
            <div class="t-meta">
              <span class="chip list">${it.parentTitle ? 'サブタスク（' + it.parentTitle + '）' : it.listName}${it.listDeleted ? '（リスト削除済み）' : ''}</span>
              ${it.assignee && html`<span class="chip who"><${Avatar} id=${it.assignee} size=${18} />${memberName(it.assignee)}</span>`}
              <span class="muted" style="font-size:12px">削除: ${fmtAt(it.deletedAt)}（${memberName(it.deletedBy) || '不明'}）</span>
            </div>
          </div>
          <button class="btn text sm" onClick=${() => enqueue('restoreTask', { id: it.id }, () => { snack('元に戻しました'); load(); })}><${Icon} n="restore_from_trash" />元に戻す</button>
        </div>`)}
        ${items && !items.length && html`<div class="empty"><div class="em-title">ごみ箱は空です</div></div>`}
      </div>
    </section></div>`;
  }

  /* ---------- ポップアップ（日付・担当者・メニュー） ---------- */
  function PopLayer() {
    const ref = useRef(null);
    const [pos, setPos] = useState(null);
    const pop = S.pop;
    useLayoutEffect(() => {
      if (!pop || !ref.current) { if (pos) setPos(null); return; }
      const el = ref.current;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = Math.min(pop.rect.left, window.innerWidth - w - 8);
      let top = pop.rect.bottom + 4;
      if (top + h > window.innerHeight - 8) top = Math.max(8, pop.rect.top - h - 4);
      if (pop.side && window.innerWidth > 600) {
        left = pop.rect.right + 8 + w <= window.innerWidth - 8 ? pop.rect.right + 8 : pop.rect.left - w - 8;
        top = Math.min(Math.max(8, pop.rect.top), window.innerHeight - h - 8);
      }
      left = Math.max(8, left);
      top = Math.max(8, top);
      if (!pos || pos.left !== left || pos.top !== top || pos.key !== pop) setPos({ left: left, top: top, key: pop });
    });
    if (!pop) return null;
    const style = pos && pos.key === pop ? { left: pos.left + 'px', top: pos.top + 'px' } : { left: '-9999px', top: '0px' };
    let body = null;
    if (pop.type === 'date') body = html`<${DatePop} key=${pop.id} ctx=${pop.ctx} />`;
    else if (pop.type === 'member') body = html`<${MemberPop} key=${pop.id} ctx=${pop.ctx} />`;
    else if (pop.type === 'repeatMenu') body = html`<${RepeatMenu} key=${pop.id} ctx=${pop.ctx} />`;
    else if (pop.type === 'taskMenu') body = html`<${TaskMenu} key=${pop.id} ctx=${pop.ctx} />`;
    else if (pop.type === 'listMenu') body = html`<${ListMenu} key=${pop.id} ctx=${pop.ctx} />`;
    else if (CAL && CAL.pops[pop.type]) body = html`<${CAL.pops[pop.type]} key=${pop.id} ctx=${pop.ctx} />`;
    return html`<div class="pop-scrim" onMouseDown=${closePop}></div><div class=${'popover' + (pop.type.indexOf('cal') === 0 ? ' cal-popover' : '')} ref=${ref} style=${style} role="dialog">${body}</div>`;
  }

  function nextMonday() { const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; d.setDate(d.getDate() + add); return ymd(d); }
  // 繰り返しを変えるときの、日付の後始末（日付がなければ今日から・やめるときに期限がなければ「いつやる」の日を期限にする）
  function repeatPatch(v, rule) {
    const p = { repeat: rule };
    if (rule && !v.doDate && !v.due) p.doDate = todayYmd();
    if (!rule && !v.due && v.doDate) { p.due = v.doDate; p.dueTime = v.doTime || ''; }
    return p;
  }
  function openRepeatDialog(value, onSave, kind) {
    update(s => { s.pop = null; s.repeatDlg = { id: uid(), kind: kind || 'task', value: Object.assign({}, NO_DATES, value), onSave: onSave }; });
  }

  /** 日付のポップアップ。kind: 'do'（いつやる）／'due'（期限・いつまでに） */
  function DatePop({ ctx }) {
    const isDo = ctx.kind === 'do';
    const [v, setV] = useState(Object.assign({}, NO_DATES, ctx.value || {}));
    const dk = isDo ? 'doDate' : 'due';
    const tk = isDo ? 'doTime' : 'dueTime';
    const set = patch => { setV(Object.assign({}, v, patch)); ctx.onChange(patch); };
    const td = todayYmd();
    const quick = [['今日', td], ['明日', addDays(td, 1)], ['来週の月曜', nextMonday()]];
    const required = !isDo && ctx.top && !(v.repeat && v.doDate);
    const canClear = isDo ? !(ctx.top && v.repeat && !v.due) : !required;
    const clearLabel = isDo ? 'いつやるをなくす' : ctx.top ? '期限なしにする' : '期限をなくす';
    const anchor = v.doDate || v.due;
    const presets = rrPresets(anchor);
    const known = presets.some(x => x[0] === v.repeat);
    return html`<div class="date-pop">
      <div class="menu-label" style="padding:0">${isDo ? 'いつやる（任意）' : '期限（いつまでに）' + (required ? '・必須' : '')}</div>
      <div class="quick">${quick.map(q => html`<button class=${v[dk] === q[1] ? 'on' : ''} onClick=${() => set({ [dk]: q[1] })}>${q[0]}</button>`)}</div>
      <div class="row"><label>日付</label><input class="input" type="date" value=${v[dk]} onInput=${e => { if (e.target.value || canClear) set(e.target.value ? { [dk]: e.target.value } : { [dk]: '', [tk]: '' }); }} /></div>
      <div class="row"><label>時刻</label><input class="input" type="time" value=${v[tk]} disabled=${!v[dk]} onInput=${e => set({ [tk]: e.target.value })} />
        ${v[tk] && html`<button class="icon-btn sm" aria-label="時刻を消す" onClick=${() => set({ [tk]: '' })}><${Icon} n="close" /></button>`}</div>
      <div class="muted" style="font-size:12px">${isDo ? '取りかかる日です。期限（いつまでに）とは別に決められます' : '時刻を入れないときは「その日中」になります'}</div>
      ${ctx.top && html`<div class="row"><label>繰り返し</label>
        <select class="input" value=${v.repeat && !known ? 'cur' : v.repeat} onChange=${e => {
          const x = e.target.value;
          if (x === 'custom') openRepeatDialog(v, ctx.onChange);
          else if (x !== 'cur') set(repeatPatch(v, x));
        }}>
          ${presets.map(p => html`<option value=${p[0]}>${p[1]}</option>`)}
          ${v.repeat && !known && html`<option value="cur">${rrLabel(v.repeat, anchor)}</option>`}
          <option value="custom">カスタム…</option>
        </select></div>`}
      ${!v[dk] && required && html`<div class="af-err" style="margin:0">期限は必ず選んでください${ctx.top ? '（繰り返しのタスクは「いつやる」があれば期限なしにできます）' : ''}</div>`}
      <div class="dlg-actions" style="margin-top:4px">
        ${canClear && v[dk] && html`<button class="btn text sm" onClick=${() => { set({ [dk]: '', [tk]: '' }); closePop(); }}>${clearLabel}</button>`}
        <button class="btn primary sm" onClick=${closePop}>OK</button>
      </div>
    </div>`;
  }

  /** 繰り返しのメニュー（Google カレンダーと同じ選び方） */
  function RepeatMenu({ ctx }) {
    const v = Object.assign({}, NO_DATES, ctx.value || {});
    const anchor = v.doDate || v.due;
    const presets = rrPresets(anchor);
    const known = presets.some(x => x[0] === v.repeat);
    const pick = rule => { ctx.onChange(repeatPatch(v, rule)); closePop(); };
    return html`<div style="min-width:240px">
      <div class="menu-label">繰り返し</div>
      ${presets.map(p => html`<button key=${p[0]} class="menu-item" onClick=${() => pick(p[0])}><span class="chk">${v.repeat === p[0] ? html`<${Icon} n="check" />` : ''}</span>${p[1]}</button>`)}
      ${v.repeat && !known && html`<button class="menu-item" onClick=${closePop}><span class="chk"><${Icon} n="check" /></span>${rrLabel(v.repeat, anchor)}</button>`}
      <div class="menu-sep"></div>
      <button class="menu-item" onClick=${() => openRepeatDialog(v, ctx.onChange)}><span class="chk"></span>カスタム…</button>
    </div>`;
  }

  /** 繰り返しの詳しい設定（Google ToDo リストの「繰り返し」と同じ項目） */
  function RepeatLayer() {
    const d = S.repeatDlg;
    if (!d) return null;
    const close = () => update(s => { s.repeatDlg = null; });
    return html`<div class="dlg-scrim top" onMouseDown=${e => { if (e.target === e.currentTarget) close(); }}><${RepeatDialog} key=${d.id} d=${d} close=${close} /></div>`;
  }
  function monthOptions(start) {
    const a = parseYmd(start);
    const out = [['day', '毎月 ' + a.getDate() + '日']];
    if (nthOf(start) <= 4) out.push(['nth', '毎月 第' + nthOf(start) + DOW[a.getDay()] + '曜日']);
    if (isLastWeek(start)) out.push(['last', '毎月 最終' + DOW[a.getDay()] + '曜日']);
    if (a.getDate() === daysInMonth(start)) out.push(['lastday', '毎月 最終日']);
    return out;
  }
  function RepeatDialog({ d, close }) {
    const isEvent = d.kind === 'event';
    const v0 = d.value;
    const o0 = rrParse(v0.repeat || '');
    const start0 = v0.doDate || v0.due || todayYmd();
    const [st, setSt] = useState(() => {
      const a = parseYmd(start0);
      let month = 'day';
      if (o0.freq === 'MONTHLY') {
        if (o0.nth === -1 && o0.nthDow === a.getDay() && isLastWeek(start0)) month = 'last';
        else if (o0.nth > 0 && o0.nth === nthOf(start0) && o0.nthDow === a.getDay()) month = 'nth';
        else if (o0.mday === -1 && a.getDate() === daysInMonth(start0)) month = 'lastday';
        else if (!o0.nth && (!o0.mday || o0.mday === a.getDate())) month = 'day';
        else month = 'keep';
      }
      return {
        n: o0.interval || 1, unit: o0.freq || 'WEEKLY', days: o0.days.length ? o0.days : [a.getDay()], month: month,
        start: start0, startTime: v0.doDate ? v0.doTime || '' : '',
        dueOn: v0.doDate ? !!v0.due : true, offset: v0.doDate && v0.due ? Math.max(0, daysBetween(v0.doDate, v0.due)) : 0, dueTime: v0.due ? v0.dueTime || '' : '',
        ends: o0.until ? 'until' : o0.count ? 'count' : 'never', until: o0.until || addDays(start0, 30), count: o0.count || 10,
      };
    });
    const [err, setErr] = useState('');
    const set = patch => { setSt(Object.assign({}, st, patch)); setErr(''); };
    const build = () => {
      const a = parseYmd(st.start || start0);
      const o = { freq: st.unit, interval: Math.max(1, Math.min(999, Number(st.n) || 1)), days: [], nth: 0, nthDow: -1, mday: 0, until: '', count: 0 };
      if (st.unit === 'WEEKLY') o.days = st.days.length ? st.days : [a.getDay()];
      if (st.unit === 'MONTHLY') {
        if (st.month === 'keep') Object.assign(o, { nth: o0.nth, nthDow: o0.nthDow, mday: o0.mday });
        else if (st.month === 'nth') Object.assign(o, { nth: nthOf(ymd(a)), nthDow: a.getDay() });
        else if (st.month === 'last') Object.assign(o, { nth: -1, nthDow: a.getDay() });
        else if (st.month === 'lastday') o.mday = -1;
        else o.mday = a.getDate();
      }
      if (st.ends === 'until') o.until = st.until;
      if (st.ends === 'count') o.count = Math.max(1, Math.min(999, Number(st.count) || 1));
      return rrFormat(o);
    };
    const rule = build();
    // 曜日などの決まりに合わない開始日は、最初に当てはまる日にずらす（Google カレンダーと同じ）
    const first = (() => {
      if (!st.start) return '';
      const o = rrParse(rule);
      if (o.freq !== 'WEEKLY' && o.freq !== 'MONTHLY') return st.start;
      return rrStep(Object.assign({}, o, { interval: 1 }), addDays(st.start, -1)) || st.start;
    })();
    const mOpts = monthOptions(st.start || start0);
    if (st.month === 'keep') mOpts.push(['keep', rrLabel(rrFormat(Object.assign({}, o0, { freq: 'MONTHLY', interval: 1, until: '', count: 0 })), st.start)]);
    // この先の予定（3回分）
    const upcoming = [];
    if (first) {
      let cur = first;
      upcoming.push(cur);
      for (let i = 1; i < 4; i++) { cur = rrNext(rule, cur, i); if (!cur) break; upcoming.push(cur); }
    }
    const offsets = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30];
    if (offsets.indexOf(Number(st.offset)) < 0) offsets.push(Number(st.offset));
    const save = () => {
      if (!st.start) return setErr('開始日を選んでください');
      if (st.ends === 'until' && (!st.until || st.until < first)) return setErr('終了日は開始日より後の日にしてください');
      const due = st.dueOn ? addDays(first, Number(st.offset) || 0) : '';
      d.onSave({ repeat: rule, doDate: first, doTime: st.startTime || '', due: due, dueTime: st.dueOn ? st.dueTime || '' : '' });
      close();
    };
    const stop = () => { d.onSave(repeatPatch(v0, '')); close(); };
    const unitWord = { DAILY: '日ごと', WEEKLY: '週間ごと', MONTHLY: 'か月ごと', YEARLY: '年ごと' };
    return html`<div class="dialog repeat-dlg" role="dialog" aria-label="繰り返し">
      <h2>繰り返し</h2>
      <div class="rp-row"><label>繰り返す間隔</label>
        <div class="rp-ctl"><input class="input num" type="number" min="1" max="999" value=${st.n} onInput=${e => set({ n: e.target.value })} />
          <select class="input" style="width:auto" value=${st.unit} onChange=${e => set({ unit: e.target.value })}>
            ${Object.keys(unitWord).map(k => html`<option value=${k}>${unitWord[k]}</option>`)}
          </select></div></div>
      ${st.unit === 'WEEKLY' && html`<div class="rp-row"><label>曜日</label>
        <div class="dows">${DOW.map((w, i) => html`<button class=${st.days.indexOf(i) >= 0 ? 'on' : ''} aria-pressed=${st.days.indexOf(i) >= 0}
          onClick=${() => { const has = st.days.indexOf(i) >= 0; const nd = has ? st.days.filter(x => x !== i) : st.days.concat([i]); if (nd.length) set({ days: nd.sort() }); }}>${w}</button>`)}</div></div>`}
      ${st.unit === 'MONTHLY' && html`<div class="rp-row"><label>日にち</label>
        <select class="input" style="width:auto" value=${st.month} onChange=${e => set({ month: e.target.value })}>
          ${mOpts.map(m => html`<option value=${m[0]}>${m[1]}</option>`)}
        </select></div>`}
      <div class="rp-row"><label>${isEvent ? '開始日' : '開始（いつやる）'}</label>
        <div class="rp-ctl"><input class="input" type="date" value=${st.start} onInput=${e => { if (e.target.value) set({ start: e.target.value, month: st.month === 'keep' ? 'keep' : 'day', days: st.unit === 'WEEKLY' && st.days.length === 1 ? [parseYmd(e.target.value).getDay()] : st.days }); }} />
          ${!isEvent && html`<input class="input" type="time" value=${st.startTime} onInput=${e => set({ startTime: e.target.value })} aria-label="開始の時刻" />`}</div></div>
      ${!isEvent && html`<div class="rp-sec">期限（いつまでに）</div>`}
      ${!isEvent && html`<label class="rp-radio"><input type="radio" name="rp-due" checked=${st.dueOn} onChange=${() => set({ dueOn: true })} />
        <span>期限を決める：開始日の</span>
        <select class="input" style="width:auto" disabled=${!st.dueOn} value=${st.offset} onChange=${e => set({ offset: Number(e.target.value), dueOn: true })}>
          ${offsets.map(n => html`<option value=${n}>${n === 0 ? '当日' : n + '日後'}</option>`)}
        </select>
        <input class="input" type="time" style="width:auto" disabled=${!st.dueOn} value=${st.dueTime} onInput=${e => set({ dueTime: e.target.value })} aria-label="期限の時刻" /></label>
      <label class="rp-radio"><input type="radio" name="rp-due" checked=${!st.dueOn} onChange=${() => set({ dueOn: false })} /><span>期限なし（「いつやる」の日だけ）</span></label>`}
      <div class="rp-sec">終了</div>
      <label class="rp-radio"><input type="radio" name="rp-end" checked=${st.ends === 'never'} onChange=${() => set({ ends: 'never' })} /><span>なし</span></label>
      <label class="rp-radio"><input type="radio" name="rp-end" checked=${st.ends === 'until'} onChange=${() => set({ ends: 'until' })} /><span>終了日</span>
        <input class="input" type="date" style="width:auto" disabled=${st.ends !== 'until'} value=${st.until} onInput=${e => set({ until: e.target.value })} /></label>
      <label class="rp-radio"><input type="radio" name="rp-end" checked=${st.ends === 'count'} onChange=${() => set({ ends: 'count' })} />
        <input class="input num" type="number" min="1" max="999" disabled=${st.ends !== 'count'} value=${st.count} onInput=${e => set({ count: e.target.value })} /><span>回繰り返したら終了</span></label>
      <div class="notice rp-sum">
        <b>${rrLabel(rule, st.start)}</b>${isEvent ? '' : st.dueOn ? '・期限は' + (Number(st.offset) ? st.offset + '日後' : '当日') + (st.dueTime ? ' ' + st.dueTime : '') : '・期限なし'}<br/>
        予定: ${upcoming.map(mdLabel).join('、')}${upcoming.length >= 4 ? '…' : ''}<br/>
        ${first && first !== st.start ? html`<span>開始日は、決まりに合う最初の日（${mdLabel(first)}）になります</span><br/>` : ''}
        <span class="muted">${isEvent ? '予定は、終了の決まりまで毎回カレンダーに出ます' : '完了にすると、次の回のタスクが自動でできます'}</span>
      </div>
      ${err && html`<div class="af-err">${err}</div>`}
      <div class="dlg-actions">
        ${v0.repeat && html`<button class="btn text" style="margin-right:auto" onClick=${stop}>繰り返さない</button>`}
        <button class="btn text" onClick=${close}>キャンセル</button>
        <button class="btn primary" onClick=${save}>完了</button>
      </div>
    </div>`;
  }

  function MemberPop({ ctx }) {
    const [name, setName] = useState('');
    const add = () => {
      const n = name.trim();
      if (!n) return;
      const id = uid();
      act.saveMember({ id: id, name: n, email: '', active: true });
      ctx.onChange(id);
      closePop();
    };
    return html`<div>
      <div class="menu-label">担当者（誰が）</div>
      ${ctx.optional && html`<button class="menu-item" onClick=${() => { ctx.onChange(''); closePop(); }}><span class="chk">${!ctx.value ? html`<${Icon} n="check" />` : ''}</span>（親タスクと同じ）</button>`}
      ${activeMembers().map(m => html`<button key=${m.id} class="menu-item" onClick=${() => { ctx.onChange(m.id); closePop(); }}>
        <span class="chk">${ctx.value === m.id ? html`<${Icon} n="check" />` : ''}</span><${Avatar} id=${m.id} size=${26} />${m.name}${m.id === S.operator ? '（自分）' : ''}
      </button>`)}
      <div class="menu-sep"></div>
      <div class="member-add"><input class="input" style="height:36px" placeholder="メンバーを追加（名前）" value=${name} onInput=${e => setName(e.target.value)}
        onKeyDown=${e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) add(); }} />
        <button class="btn tonal sm" disabled=${!name.trim()} onClick=${add}>追加</button></div>
    </div>`;
  }

  function TaskMenu({ ctx }) {
    const [moving, setMoving] = useState(false);
    const t = CUR.tasks[ctx.id];
    if (!t) return html`<div class="menu-label">タスクが見つかりません</div>`;
    if (moving) {
      return html`<div><div class="menu-label">移動先のリスト</div>
        ${CUR.listArr.map(l => html`<button key=${l.id} class="menu-item" disabled=${l.id === t.listId} onClick=${() => {
          act.updateTask(t.id, { listId: l.id, sortOrder: newSortOrder(l.id) });
          closePop();
          snack('「' + l.name + '」に移動しました');
        }}><span class="chk">${l.id === t.listId ? html`<${Icon} n="check" />` : ''}</span>${l.name}</button>`)}</div>`;
    }
    return html`<div>
      <button class="menu-item" onClick=${() => { closePop(); openTask(t.id); }}><${Icon} n="edit" />詳細を開く</button>
      ${!t.parentId && html`<button class="menu-item" onClick=${() => { update(s => { s.pop = null; s.selected = t.id; }); setTimeout(() => { const el = document.querySelector('.sub-add input'); if (el) el.focus(); }, 80); }}><${Icon} n="subdirectory_arrow_right" />サブタスクを追加</button>`}
      ${!t.parentId && html`<button class="menu-item" onClick=${() => setMoving(true)}><${Icon} n="swap_horiz" />別のリストに移動<span class="grow"></span><${Icon} n="chevron_right" /></button>`}
      <div class="menu-sep"></div>
      <button class="menu-item danger" onClick=${() => { closePop(); act.deleteTask(t); }}><${Icon} n="delete" />削除</button>
    </div>`;
  }

  function ListMenu({ ctx }) {
    const l = CUR.lists[ctx.listId];
    if (!l) return null;
    const hasDone = (CUR.byList[l.id] || []).some(t => t.status === 'done');
    const modes = ['my', 'do', 'date', 'starred', 'title', 'assignee'].map(k => [k, SORT_LABEL[k]]);
    return html`<div>
      <div class="menu-label">並べ替え</div>
      ${modes.map(m => html`<button key=${m[0]} class="menu-item" onClick=${() => { act.updateList(l.id, { sortMode: m[0] }); closePop(); }}>
        <span class="chk">${(l.sortMode || 'my') === m[0] ? html`<${Icon} n="check" />` : ''}</span>${m[1]}</button>`)}
      <div class="menu-sep"></div>
      <button class="menu-item" onClick=${() => update(s => { s.pop = null; s.dialog = { type: 'listName', mode: 'rename', id: l.id }; })}><${Icon} n="edit" />リスト名を変更</button>
      <button class="menu-item" onClick=${() => printList(l.id)}><${Icon} n="print" />リストを印刷</button>
      <button class="menu-item" disabled=${!hasDone} onClick=${() => { closePop(); confirmDlg('完了したタスクをすべて削除しますか？', '「' + l.name + '」の完了済みタスクをごみ箱に移します（30日間は元に戻せます）。', '削除', () => enqueue('clearCompleted', { listId: l.id }), true); }}><${Icon} n="done_all" />完了したタスクをすべて削除</button>
      <button class="menu-item danger" disabled=${CUR.listArr.length <= 1} onClick=${() => { closePop(); confirmDlg('リストを削除しますか？', '「' + l.name + '」と、その中のタスクがすべて削除されます（タスクは30日間ごみ箱から戻せます）。', '削除', () => { enqueue('deleteList', { id: l.id }); if (S.view.type === 'list' && S.view.id === l.id) go({ type: 'all' }); }, true); }}>
        <${Icon} n="delete" />リストを削除${CUR.listArr.length <= 1 ? '（最後の1つは消せません）' : ''}</button>
    </div>`;
  }

  /* ---------- ダイアログ ---------- */
  function DialogLayer() {
    const d = S.dialog;
    if (!d) return null;
    const close = () => update(s => { s.dialog = null; });
    let body = null;
    if (d.type === 'who') body = html`<${WhoDialog} d=${d} close=${close} />`;
    else if (d.type === 'create') body = html`<div class="dialog"><h2>タスクを作成</h2><${AddForm} inDialog listId=${S.view.type === 'list' ? S.view.id : ''} assignee=${S.view.type === 'member' ? S.view.id : ''} onClose=${close} /></div>`;
    else if (d.type === 'listName') body = html`<${ListNameDialog} d=${d} close=${close} />`;
    else if (d.type === 'confirm') {
      body = html`<div class="dialog"><h2>${d.title}</h2><p>${d.body}</p>
        <div class="dlg-actions"><button class="btn text" onClick=${close}>キャンセル</button>
        <button class=${'btn ' + (d.danger ? 'danger' : 'primary')} onClick=${() => { close(); d.onOk(); }}>${d.ok}</button></div></div>`;
    } else if (d.type === 'settings') body = html`<${SettingsDialog} d=${d} close=${close} />`;
    else if (CAL && CAL.dialogs[d.type]) body = html`<${CAL.dialogs[d.type]} d=${d} close=${close} />`;
    else if (d.type === 'preview') {
      body = html`<div class="dialog wide"><h2>メールのプレビュー</h2><p style="font-weight:600">件名: ${d.subject}</p>
        <iframe class="preview-frame" sandbox="" srcdoc=${d.html}></iframe>
        <div class="dlg-actions"><button class="btn primary" onClick=${() => update(s => { s.dialog = { type: 'settings', tab: 'mail' }; })}>閉じる</button></div></div>`;
    }
    return html`<div class="dlg-scrim" onMouseDown=${e => { if (e.target === e.currentTarget && !d.required) close(); }}>${body}</div>`;
  }

  function WhoDialog({ d, close }) {
    const [name, setName] = useState('');
    const members = activeMembers();
    const add = () => {
      const n = name.trim();
      if (!n) return;
      const id = uid();
      act.saveMember({ id: id, name: n, email: '', active: true });
      setOperator(id);
    };
    return html`<div class="dialog">
      <h2>操作する人を選んでください</h2>
      <p>このアカウントは何人かで使う「共有のアカウント」です。誰が登録・変更したかを記録するため、<b>この端末で操作する人</b>を選んでください。あとから右上でいつでも切り替えられます。</p>
      ${members.length > 0 && html`<div class="who-grid">${members.map(m => html`<button key=${m.id} class=${'who-btn' + (m.id === S.operator ? ' on' : '')} onClick=${() => setOperator(m.id)}><${Avatar} id=${m.id} size=${32} />${m.name}</button>`)}</div>`}
      ${!isAdmin() && html`<p class="muted">一覧にいないときは、管理者にメンバーの追加を頼んでください。</p>`}
      ${isAdmin() && html`<div class="form-grid">
        <div><label class="lbl">${members.length ? '一覧にいないときは、名前を入れて追加' : 'まず、自分の名前を入れてください'}</label>
          <div style="display:flex;gap:8px"><input class="input" placeholder="例: 山田" value=${name} onInput=${e => setName(e.target.value)}
            onKeyDown=${e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) add(); }} />
          <button class="btn primary" disabled=${!name.trim()} onClick=${add}>追加して選ぶ</button></div></div>
      </div>`}
      ${!d.required && html`<div class="dlg-actions"><button class="btn text" onClick=${close}>閉じる</button></div>`}
    </div>`;
  }

  function ListNameDialog({ d, close }) {
    const l = d.id ? CUR.lists[d.id] : null;
    const [name, setName] = useState(l ? l.name : '');
    const ref = useRef(null);
    useEffect(() => { if (ref.current) { ref.current.focus(); ref.current.select(); } }, []);
    const ok = () => {
      const n = name.trim();
      if (!n) return;
      if (d.mode === 'new') act.createList(n, id => go({ type: 'list', id: id }));
      else if (l && n !== l.name) act.updateList(l.id, { name: n });
      close();
    };
    return html`<div class="dialog"><h2>${d.mode === 'new' ? '新しいリストを作成' : 'リスト名を変更'}</h2>
      <input ref=${ref} class="input" placeholder="リスト名（例: 研修、出店、経理）" value=${name} onInput=${e => setName(e.target.value)}
        onKeyDown=${e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) ok(); }} />
      <div class="dlg-actions"><button class="btn text" onClick=${close}>キャンセル</button><button class="btn primary" disabled=${!name.trim()} onClick=${ok}>${d.mode === 'new' ? '作成' : '保存'}</button></div>
    </div>`;
  }

  function Switch({ checked, onChange }) {
    return html`<label class="switch"><input type="checkbox" checked=${checked} onChange=${e => onChange(e.target.checked)} /><span></span></label>`;
  }

  function SettingsDialog({ d, close }) {
    const tab = d.tab || 'display';
    const setTab = t => update(s => { s.dialog = Object.assign({}, s.dialog, { tab: t }); });
    return html`<div class="dialog wide">
      <div style="display:flex;align-items:center"><h2 class="grow" style="margin:0">設定</h2><button class="icon-btn" aria-label="閉じる" onClick=${close}><${Icon} n="close" /></button></div>
      <div class="tabs" style="margin-top:8px">
        ${[['display', 'この端末の表示'], ['calendar', 'カレンダー'], ['google', 'Google 連携'], ['members', 'メンバー'], ['mail', 'メール通知']].filter(x => x[0] !== 'calendar' || CAL).map(x => html`<button class=${tab === x[0] ? 'on' : ''} onClick=${() => setTab(x[0])}>${x[1]}</button>`)}
      </div>
      ${tab === 'display' && html`<${DisplaySettings} />`}
      ${tab === 'calendar' && CAL && html`<${CAL.Settings} />`}
      ${tab === 'google' && html`<${GoogleSettings} />`}
      ${tab === 'members' && html`<${MemberSettings} />`}
      ${tab === 'mail' && html`<${MailSettings} />`}
    </div>`;
  }

  function DisplaySettings() {
    const p = S.prefs;
    const row = (title, sub, k) => html`<div class="set-row"><div class="set-text">${title}<small>${sub}</small></div><${Switch} checked=${!!p[k]} onChange=${v => setPref(k, v)} /></div>`;
    return html`<div>
      ${isPersonal()
        ? html`<div class="set-row"><div class="set-text">ログインしている人<small>${S.me.email}${S.me.isOwner ? '・全権限' : ''}（登録・変更・最新状況に、この名前が残ります）</small></div>
            <span class="who-chip"><${Avatar} id=${S.operator} size=${28} />${memberName(S.operator)}</span></div>`
        : html`<div class="set-row"><div class="set-text">この端末で操作する人<small>共有のアカウント（${S.me ? S.me.email : ''}）です。登録・変更・最新状況に、この名前が残ります</small></div>
            <button class="who-chip" onClick=${() => update(s => { s.dialog = { type: 'who' }; })}><${Avatar} id=${S.operator} size=${28} />${memberName(S.operator) || '選ぶ'}</button></div>`}
      ${isAdmin() && html`<div class="set-row"><div class="set-text">アカウントの管理（管理者だけ）<small>本部の人の招待・停止・パスワード再設定は、管理画面で行います（もう一度ログインが必要です）</small></div>
        <a class="btn outline sm" href=${ADMIN_URL} target="_blank" rel="noopener">管理画面を開く</a></div>`}
      ${row('新しいタスクを一番上に追加', 'オフにすると、リストの一番下に追加します', 'addToTop')}
      ${row('完了したときに音を鳴らす', 'チェックを付けたときに短い音を鳴らします', 'sound')}
      ${row('動きの演出', '完了・スター・画面の切り替えのアニメーション', 'motion')}
      <div class="set-row"><div class="set-text">ログアウト<small>この端末のログインを解除します（次はメールアドレスとパスワードが必要です）</small></div>
        <button class="btn outline sm" onClick=${() => confirmDlg('ログアウトしますか？', 'この端末で、もう一度ログインが必要になります。', 'ログアウト', () => backend.signOut().then(() => location.reload()))}>ログアウト</button></div>
      <div class="set-row"><div class="set-text">テーマ<small>画面の明るさ</small></div>
        <div class="radios">${[['auto', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']].map(x => html`<button class=${p.theme === x[0] ? 'on' : ''} onClick=${() => setPref('theme', x[0])}>${x[1]}</button>`)}</div></div>
      <p class="muted" style="margin-top:12px;font-size:12px">ここの設定は、この端末（このブラウザ）だけに保存されます。</p>
    </div>`;
  }

  function MemberSettings() {
    const all = Object.values(CUR.members).sort((a, b) => (b.active - a.active) || (a.sortOrder - b.sortOrder));
    return html`<div>
      <p>担当者として選べる、本部のメンバーです。メンバーの追加・名前やメールの変更・アカウントの招待は、<b>管理画面</b>（管理者だけ）で行います。</p>
      ${isAdmin() && html`<p><a class="btn outline sm" href=${ADMIN_URL} target="_blank" rel="noopener">管理画面を開く</a></p>`}
      ${all.map(m => html`<div key=${m.id} class=${'mem-row' + (m.active ? '' : ' inactive')}>
        <${Avatar} id=${m.id} size=${32} />
        <div class="grow"><div>${m.name}</div><div class="muted" style="font-size:12px">${m.email || 'メールなし'}</div></div>
        <span class="muted" style="font-size:12px">${m.active ? '在籍' : '在籍していない'}</span>
      </div>`)}
    </div>`;
  }

  function GoogleSettings() {
    const [st, setSt] = useState(null); // 自分の連携の状態（データベース）
    const [cfg, setCfg] = useState(null); // 初期設定が済んでいるか（Edge Function）
    const [busy, setBusy] = useState('');
    const load = () => Promise.all([
      call('googleStatus', {}).then(setSt).catch(e => setSt({ error: errText(e) })),
      backend.google('config').then(setCfg).catch(() => setCfg({ configured: false })),
    ]);
    useEffect(() => { load(); }, []);
    // 反映を待っているあいだは、ときどき確かめる
    useEffect(() => {
      if (!st || !st.link || !st.link.pending) return undefined;
      const tm = setTimeout(load, 6000);
      return () => clearTimeout(tm);
    }, [st]);
    const run = (label, fn) => { setBusy(label); return fn().catch(e => snack(errText(e), { kind: 'error', ms: 8000 })).then(() => setBusy('')); };
    const connect = () => run('connect', () => backend.google('start').then(r => { location.href = r.url; }));
    const back = () => update(s => { s.dialog = { type: 'settings', tab: 'google' }; });
    const disconnect = () => confirmDlg('Google との連携をやめますか？', 'これから先の変更は Google に出なくなります。Google に出ているタスク・予定は、そのまま残ります（いらなければ Google 側で消してください）。', '連携をやめる',
      () => run('off', () => backend.google('disconnect').then(() => { snack('Google との連携をやめました'); back(); })), true);
    const setOpt = (k, v) => run('opt', () => call('googleSettings', { [k]: v }).then(setSt));
    const syncNow = () => run('sync', () => backend.google('syncme').then(r => { snack(r.result === 'error' ? '反映できませんでした。下の「うまくいかなかったこと」を見てください' : 'Google に反映しました', r.result === 'error' ? { kind: 'error' } : {}); return load(); }));
    if (!st) return html`<p class="muted">読み込み中…</p>`;
    if (st.error) return html`<p class="error-text">${st.error}</p>`;
    const intro = html`<p>このアプリのタスクと予定を、<b>自分の Google アカウント</b>の <b>Google ToDo リスト</b>と <b>Google カレンダー</b>に自動で出します。スマホの Google アプリからも見られます。</p>
      <ul class="muted" style="font-size:13px;line-height:1.8;padding-left:20px;margin:0 0 12px">
        <li>ToDo リスト: 自分が担当のタスクを、リスト「本部タスク」に出します（期限の日付・完了・メモ）</li>
        <li>カレンダー: 自分のカレンダーの予定と、ゲストに呼ばれた予定を出します（「いいえ」と答えた予定は出しません）</li>
        <li>こちら → Google の一方向です。Google 側で変えても、こちらには戻りません</li>
      </ul>`;
    if (!st.available) {
      return html`<div>${intro}<p class="error-text">Google 連携は、一人ずつのアカウント（個人のアカウント）で使えます。いまは共有のアカウントでログインしています。管理者に、自分のアカウントの招待を頼んでください。</p></div>`;
    }
    const l = st.link;
    if (!l) {
      if (cfg && !cfg.configured) {
        return html`<div>${intro}<p class="error-text">まだ使えません。管理者が管理画面の「Google 連携」で初期設定をすると、使えるようになります。</p>
          ${isAdmin() && html`<p><a class="btn outline sm" href=${ADMIN_URL} target="_blank" rel="noopener">管理画面を開く</a></p>`}</div>`;
      }
      return html`<div>${intro}
        <p><button class="btn primary" disabled=${!!busy || !cfg} onClick=${connect}>${busy === 'connect' ? 'お待ちください…' : 'Google と連携する'}</button></p>
        <p class="muted" style="font-size:12px;line-height:1.7">Google の画面で、自分の Google アカウントを選び、「ToDo リスト」と「カレンダー」の両方にチェックを入れて「続行」を押してください。
          「Google はこのアプリを確認していません」と出たときは、「詳細」→「（安全ではないページ）に移動」で進めます（本部だけで使うアプリのため、Google の審査を受けていません）。</p>
      </div>`;
    }
    const sw = (title, sub, k, can) => html`<div class="set-row"><div class="set-text">${title}<small>${can ? sub : 'Google で許可されていません。「つなぎ直す」で、チェックを入れて許可してください'}</small></div>
      <${Switch} checked=${!!l[k] && can} onChange=${v => can && setOpt(k, v)} /></div>`;
    return html`<div>
      <div class="set-row"><div class="set-text">つないでいる Google アカウント<small>${l.email || '（アドレス不明）'}${l.connectedAt ? '・' + fmtAt(l.connectedAt) + ' から' : ''}</small></div>
        <span class=${'chip ' + (l.status === 'active' ? 'ok' : 'bad')}>${l.status === 'active' ? '連携中' : 'つなぎ直しが必要'}</span></div>
      ${sw('Google ToDo リストに出す', '自分が担当のタスクを、リスト「本部タスク」に出します', 'tasksEnabled', l.canTasks)}
      ${sw('Google カレンダーに出す', '自分のカレンダーの予定と、ゲストに呼ばれた予定を出します', 'calendarEnabled', l.canCalendar)}
      <div class="set-row"><div class="set-text">最後に反映した時刻<small>${l.lastSyncedAt ? fmtRel(l.lastSyncedAt) : 'まだありません'}${l.pending ? '（反映待ちがあります。1分ほどで出ます）' : ''}</small></div>
        <button class="btn outline sm" disabled=${!!busy || l.status !== 'active'} onClick=${syncNow}>${busy === 'sync' ? '反映中…' : '今すぐ反映'}</button></div>
      ${l.lastError && html`<div class="set-row"><div class="set-text">うまくいかなかったこと<small class="error-text" style="white-space:pre-wrap">${l.lastError}</small></div></div>`}
      <div class="set-row"><div class="set-text">つなぎ直す・やめる<small>Google アカウントを変えたいとき・許可をやり直したいときは「つなぎ直す」</small></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn outline sm" disabled=${!!busy} onClick=${connect}>つなぎ直す</button>
        <button class="btn text sm danger-text" disabled=${!!busy} onClick=${disconnect}>連携をやめる</button></div></div>
    </div>`;
  }

  function MailSettings() {
    const cfg = S.config || {};
    const m0 = cfg.mail || {};
    const [m, setM] = useState({
      enabled: !!m0.enabled, recipients: (m0.recipients || []).join('\n'), days: (m0.days || [1, 2, 3, 4, 5]).slice(),
      startHour: m0.startHour === undefined ? 10 : m0.startHour, endHour: m0.endHour === undefined ? 17 : m0.endHour,
      summaryOn: m0.summaryTime === undefined ? true : !!m0.summaryTime, summaryTime: m0.summaryTime || '17:30',
      skipHolidays: m0.skipHolidays !== false, skipYearEnd: m0.skipYearEnd !== false, sendWhenNoChange: m0.sendWhenNoChange !== false,
      soonDays: cfg.soonDays || 3, staleDays: cfg.staleDays || 3,
    });
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState('');
    const setK = (k, v) => setM(Object.assign({}, m, { [k]: v }));
    const loadStatus = () => call('mailStatus', {}).then(setStatus).catch(() => {});
    useEffect(() => { loadStatus(); }, []);
    // テスト送信を待っている間は、数秒ごとに送信履歴を確かめる
    useEffect(() => {
      if (!status || !status.testPending) return undefined;
      const tm = setTimeout(loadStatus, 3000);
      return () => clearTimeout(tm);
    }, [status]);
    const toCfg = () => ({
      mail: {
        enabled: m.enabled, recipients: m.recipients.split(/[\s,、;]+/).map(s => s.trim()).filter(Boolean), days: m.days,
        startHour: Number(m.startHour), endHour: Number(m.endHour), summaryTime: m.summaryOn ? m.summaryTime : '', skipHolidays: m.skipHolidays, skipYearEnd: m.skipYearEnd, sendWhenNoChange: m.sendWhenNoChange,
      },
      soonDays: Number(m.soonDays), staleDays: Number(m.staleDays),
    });
    const run = (label, fn) => { setBusy(label); return fn().catch(e => snack(errText(e), { kind: 'error', ms: 8000 })).then(() => setBusy('')); };
    const save = () => run('save', () => call('saveConfig', { config: toCfg() }).then(res => { update(s => { applyResult(res); }); snack('メール通知の設定を保存しました'); }));
    const test = () => run('test', () => call('saveConfig', { config: Object.assign(toCfg(), {}) }).then(res => { update(s => { applyResult(res); }); return call('sendTestMail', {}); }).then(st => { setStatus(st); snack(st.trigger ? 'テスト送信を受け付けました。1分以内に届きます' : 'テスト送信を受け付けました。メール送信用の GAS を設置すると届きます', { ms: 8000 }); }));
    const preview = summary => run('preview', () => call('previewReport', { summary: !!summary }).then(r => update(s => { s.dialog = { type: 'preview', subject: r.subject, html: r.html }; })));
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const hourly = [];
    for (let h = Number(m.startHour); h <= Number(m.endHour); h++) hourly.push(p2(h) + ':00');
    const extra = m.summaryOn && m.summaryTime && hourly.indexOf(m.summaryTime) < 0 ? [m.summaryTime] : [];
    const times = hourly.concat(extra).sort();
    const perDay = m.enabled ? times.length : 0;
    const count = m.recipients.split(/[\s,、;]+/).filter(Boolean).length;
    const canEdit = isAdmin();
    return html`<div>
      ${!canEdit && html`<div class="notice">メール通知の設定を変えられるのは管理者だけです（プレビューは見られます）。</div>`}
      <div class="set-row"><div class="set-text"><b>1時間に1回、状況をメールで送る</b><small>送る時間帯の毎時ちょうど（1分ほど遅れることがあります）に、下の宛先へ本部全体のタスク状況を送ります</small></div><${Switch} checked=${m.enabled} onChange=${v => setK('enabled', v)} /></div>
      ${status && !status.trigger && html`<div class="notice bad">メール送信用の GAS が動いていないため、メールが送られません${status.relaySeenAt ? '（最後に動いたのは ' + fmtAt(status.relaySeenAt) + '）' : '（まだ設置されていません）'}。手順書の「メール送信用 GAS」を設置してください。</div>`}
      ${status && status.trigger && html`<div class="notice">メール送信用の GAS は動いています（最後の確認: ${fmtAt(status.relaySeenAt)}）${status.testPending ? '。テスト送信を待っています' : ''}</div>`}
      <div class="form-grid" style="margin-top:12px">
        <div><label class="lbl">送信先のメールアドレス（1行に1つ）</label>
          <textarea class="textarea" rows="3" placeholder="例: honbu@example.com" value=${m.recipients} onInput=${e => setK('recipients', e.target.value)}></textarea></div>
        <div><label class="lbl">送る曜日</label>
          <div class="dows">${DOW.map((d, i) => html`<button class=${m.days.indexOf(i) >= 0 ? 'on' : ''} onClick=${() => setK('days', m.days.indexOf(i) >= 0 ? m.days.filter(x => x !== i) : m.days.concat([i]).sort())}>${d}</button>`)}</div></div>
        <div><label class="lbl">送る時間帯</label>
          <div style="display:flex;align-items:center;gap:8px">
            <select class="input" style="width:auto" value=${m.startHour} onChange=${e => setK('startHour', Number(e.target.value))}>${hours.map(h => html`<option value=${h}>${h}時</option>`)}</select>から
            <select class="input" style="width:auto" value=${m.endHour} onChange=${e => setK('endHour', Number(e.target.value))}>${hours.map(h => html`<option value=${h}>${h}時</option>`)}</select>まで（毎時ちょうど）
          </div></div>
        <div class="set-row" style="padding:4px 0"><div class="set-text">1日の終わりに「今日のまとめ」を送る<small>今日の完了・期限切れ・今日まで・明日までをまとめて送ります</small></div>
          <input class="input" type="time" style="width:auto" value=${m.summaryTime} disabled=${!m.summaryOn} onInput=${e => setK('summaryTime', e.target.value)} />
          <${Switch} checked=${m.summaryOn} onChange=${v => setK('summaryOn', v)} /></div>
        <div class="notice" style="margin:0">送る時刻: ${times.map(t => Number(t.split(':')[0]) + ':' + t.split(':')[1]).join('・') || 'なし'}${extra.length ? '（' + Number(extra[0].split(':')[0]) + ':' + extra[0].split(':')[1] + ' は今日のまとめ）' : m.summaryOn && hourly.indexOf(m.summaryTime) >= 0 ? '（' + m.summaryTime + ' は今日のまとめ）' : ''}</div>
        <div class="set-row" style="padding:4px 0"><div class="set-text">祝日は送らない</div><${Switch} checked=${m.skipHolidays} onChange=${v => setK('skipHolidays', v)} /></div>
        <div class="set-row" style="padding:4px 0"><div class="set-text">年末年始（12/29〜1/3）は送らない</div><${Switch} checked=${m.skipYearEnd} onChange=${v => setK('skipYearEnd', v)} /></div>
        <div class="set-row" style="padding:4px 0"><div class="set-text">動きがなかった時間も送る<small>オフにすると、前回から何も変わっていないときは送りません</small></div><${Switch} checked=${m.sendWhenNoChange} onChange=${v => setK('sendWhenNoChange', v)} /></div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div><label class="lbl">「期限が近い」とする日数</label><select class="input" style="width:auto" value=${m.soonDays} onChange=${e => setK('soonDays', Number(e.target.value))}>${[1, 2, 3, 4, 5, 7, 10, 14].map(n => html`<option value=${n}>${n}日以内</option>`)}</select></div>
          <div><label class="lbl">「更新が止まっている」とする日数</label><select class="input" style="width:auto" value=${m.staleDays} onChange=${e => setK('staleDays', Number(e.target.value))}>${[1, 2, 3, 5, 7, 14].map(n => html`<option value=${n}>${n}日以上</option>`)}</select></div>
        </div>
      </div>
      <div class="notice">1日に送る数: ${perDay}回 × 宛先${count}件 ＝ <b>${perDay * count}通</b>。
        Gmail の無料アカウントは1日100通（宛先の数で数えます）までです。${status && status.quota !== null && status.quota !== undefined ? '今日あと ' + status.quota + ' 通送れます。' : ''}
        ${perDay * count > 90 ? html`<b style="color:var(--red)">上限に近いので、宛先か時間帯を減らしてください。</b>` : ''}</div>
      <div class="dlg-actions" style="justify-content:flex-start">
        <button class="btn primary" disabled=${!!busy || !canEdit} onClick=${save}>${busy === 'save' ? '保存中…' : '保存'}</button>
        <button class="btn outline" disabled=${!!busy} onClick=${() => preview(false)}><${Icon} n="mail" />${busy === 'preview' ? '作成中…' : '毎時メールのプレビュー'}</button>
        <button class="btn outline" disabled=${!!busy} onClick=${() => preview(true)}><${Icon} n="mail" />今日のまとめのプレビュー</button>
        <button class="btn outline" disabled=${!!busy || !count || !canEdit} onClick=${test}>${busy === 'test' ? '送信中…' : '保存してテスト送信'}</button>
      </div>
      <div class="sec-title"><${Icon} n="history" />送信履歴${status && status.lastSentAt ? '（最後の自動送信: ' + fmtAt(status.lastSentAt) + '）' : ''}</div>
      ${!status ? html`<div class="muted">読み込み中…</div>` : html`<div style="overflow-x:auto"><table class="log-table">
        <thead><tr><th>日時</th><th>結果</th><th>件名</th></tr></thead>
        <tbody>${status.log.map((r, i) => html`<tr key=${i}><td style="white-space:nowrap">${fmtAt(r.at)}</td><td style=${r.result === '送信済み' ? '' : 'color:var(--red)'}>${r.result}${r.error ? '：' + r.error : ''}</td><td>${r.subject}</td></tr>`)}
        ${!status.log.length && html`<tr><td colspan="3" class="muted">まだ送っていません</td></tr>`}</tbody></table></div>`}
    </div>`;
  }

  function Snack() {
    const s = S.snack;
    if (!s) return null;
    return html`<div class=${'snack' + (s.kind === 'error' ? ' error' : '')} role="status">
      <span class="s-text">${s.text}</span>
      ${s.action && html`<button class="s-act" onClick=${() => { const fn = s.action.fn; update(st => { st.snack = null; }); fn(); }}>${s.action.label}</button>`}
      <button class="icon-btn sm" style="color:inherit" aria-label="閉じる" onClick=${() => update(st => { st.snack = null; })}><${Icon} n="close" /></button>
    </div>`;
  }

  function PrintArea() {
    if (!S.printId || !CUR) return html`<div class="print-area"></div>`;
    const l = CUR.lists[S.printId];
    if (!l) return html`<div class="print-area"></div>`;
    const open = sortMy(openOf(l.id));
    return html`<div class="print-area">
      <h1>${l.name}</h1><div>印刷日時: ${new Date().toLocaleString('ja-JP')}　未完了 ${open.length}件</div>
      <table><thead><tr><th></th><th>タスク（何を）</th><th>担当（誰が）</th><th>いつやる</th><th>期限（いつまでに）</th><th>状況</th></tr></thead>
      <tbody>${open.map(t => html`<tr><td><span class="box"></span></td><td><b>${t.title}</b>${t.details ? html`<br/>${t.details}` : ''}
        ${(CUR.children[t.id] || []).map(c => html`<br/>　${c.status === 'done' ? '☑' : '☐'} ${c.title}`)}</td>
        <td>${memberName(t.assignee)}</td><td>${doLabel(t)}${t.repeat ? '（' + rrLabel(t.repeat, t.doDate || t.due) + '）' : ''}</td><td>${dueLabel(t)}${isOverdue(t) ? '（期限切れ）' : ''}</td><td>${STATUS_LABEL[t.status]}${t.noteText ? html`<br/>${t.noteText}` : ''}</td></tr>`)}</tbody></table>
    </div>`;
  }

  /* ---------- ログイン ---------- */
  function Login() {
    const [email, setEmail] = useState(local.get('email', ''));
    const [pw, setPw] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const submit = async () => {
      setErr('');
      setBusy(true);
      try {
        await backend.signIn(email.trim(), pw);
        local.set('email', email.trim());
        S.auth = 'ok';
        await boot();
      } catch (e) {
        setErr(errText(e));
        setBusy(false);
      }
    };
    return html`<div class="login-wrap"><div class="login-card">
      <div class="login-brand"><${Logo} /><span>本部タスク</span></div>
      <h1>ログイン</h1>
      <p class="muted">招待されたアカウントのメールアドレスとパスワードでログインしてください。一度ログインすれば、この端末ではログインしたままになります。</p>
      <form class="form-grid" onSubmit=${e => { e.preventDefault(); submit(); }}>
        <div><label class="lbl">メールアドレス</label>
          <input class="input" type="email" autocomplete="username" required value=${email} onInput=${e => setEmail(e.target.value)} /></div>
        <div><label class="lbl">パスワード</label>
          <input class="input" type="password" autocomplete="current-password" required value=${pw} onInput=${e => setPw(e.target.value)} /></div>
        ${err && html`<div class="af-err">${err}</div>`}
        <button class="btn primary" type="submit" disabled=${busy}>${busy ? 'お待ちください…' : 'ログイン'}</button>
      </form>
      <p class="muted" style="margin:16px 0 0;font-size:12px">アカウントは管理者からの招待でだけ作れます。パスワードを忘れたときは、管理者に「パスワード再設定のリンク」を頼んでください。</p>
    </div></div>`;
  }

  // 招待・パスワード再設定のリンクを開いたとき
  function LinkScreen() {
    const [info, setInfo] = useState(null);
    const [pw, setPw] = useState('');
    const [pw2, setPw2] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    useEffect(() => {
      backend.link('info', LINK.token).then(setInfo).catch(e => setInfo({ error: errText(e) }));
    }, []);
    const toLogin = () => { history.replaceState(null, '', location.pathname + location.search); S.auth = 'login'; update(); };
    const submit = async () => {
      setErr('');
      if (pw.length < 8) { setErr('パスワードは8文字以上にしてください'); return; }
      if (pw !== pw2) { setErr('確認のパスワードが一致しません'); return; }
      setBusy(true);
      try {
        await backend.link('accept', LINK.token, pw);
        try { await backend.signOut(); } catch (e) { /* ログインしていなければ何もしない */ }
        await backend.signIn(info.email, pw);
        local.set('email', info.email);
        history.replaceState(null, '', location.pathname + location.search);
        S.auth = 'ok';
        await boot();
      } catch (e) {
        setErr(errText(e));
        setBusy(false);
      }
    };
    const reset = (info && info.kind === 'reset') || LINK.kind === 'reset';
    return html`<div class="login-wrap"><div class="login-card">
      <div class="login-brand"><${Logo} /><span>本部タスク</span></div>
      <h1>${reset ? 'パスワードの再設定' : '招待を受けてはじめる'}</h1>
      ${!info ? html`<p class="muted">リンクを確かめています…</p>`
        : info.error ? html`<div class="af-err">${info.error}</div>
            <button class="btn text login-switch" onClick=${toLogin}>ログイン画面へ</button>`
        : html`<p class="muted">${info.name ? info.name + 'さん、' : ''}${reset ? '新しいパスワードを決めてください。' : 'ご自分のパスワードを決めてください。次からは、このメールアドレスとパスワードでログインします。'}</p>
          <form class="form-grid" onSubmit=${e => { e.preventDefault(); submit(); }}>
            <div><label class="lbl">メールアドレス（ログインに使います）</label>
              <input class="input" type="email" autocomplete="username" value=${info.email} readOnly /></div>
            <div><label class="lbl">パスワード（8文字以上）</label>
              <input class="input" type="password" autocomplete="new-password" required value=${pw} onInput=${e => setPw(e.target.value)} /></div>
            <div><label class="lbl">パスワード（確認）</label>
              <input class="input" type="password" autocomplete="new-password" required value=${pw2} onInput=${e => setPw2(e.target.value)} /></div>
            ${err && html`<div class="af-err">${err}</div>`}
            <button class="btn primary" type="submit" disabled=${busy}>${busy ? 'お待ちください…' : reset ? 'パスワードを変えてログイン' : 'パスワードを決めてはじめる'}</button>
          </form>
          <p class="muted" style="margin:16px 0 0;font-size:12px">このリンクは1回だけ使えます。ほかの人には教えないでください。</p>`}
    </div></div>`;
  }

  /* ================= 起動 ================= */
  async function boot() {
    S.ready = false;
    S.bootError = '';
    update();
    try {
      const res = await call('bootstrap', {});
      S.me = await call('me', {});
      replaceAll(res);
      S.rev = res.rev;
      S.ready = true;
      checkOperator();
      if (INITIAL_TASK && S.tasks[INITIAL_TASK]) S.selected = INITIAL_TASK;
      if (GOOGLE_BACK) {
        history.replaceState(null, '', location.pathname + location.search);
        S.dialog = { type: 'settings', tab: 'google' };
        setTimeout(() => snack(GOOGLE_BACK.ok ? 'Google と連携しました。1分ほどで Google に出はじめます' : (GOOGLE_BACK.msg || 'Google と連携できませんでした'),
          GOOGLE_BACK.ok ? { ms: 8000 } : { kind: 'error', ms: 10000 }), 300);
      }
      S.lastSync = Date.now();
      startRealtime();
    } catch (e) {
      S.bootError = errText(e);
    }
    update();
    scheduleSync();
  }
  async function start() {
    draw();
    backend.onSignedOut(() => { if (S.auth === 'ok') location.reload(); });
    if (LINK) {
      S.auth = 'link';
      update();
      return;
    }
    let session = null;
    try { session = await backend.session(); } catch (e) { session = null; }
    if (!session) {
      S.auth = 'login';
      update();
      return;
    }
    S.auth = 'ok';
    boot();
  }
  setInterval(() => { if (S.ready) update(); }, 60000); // 「○分前」などの表示を新しくする

  /* ================= カレンダー（calendar.js）に渡す道具 ================= */
  if (window.HONBU_CALENDAR) {
    CAL = window.HONBU_CALENDAR({
      html, useState, useEffect, useRef, useLayoutEffect, S, update, cur: () => CUR, Icon, Avatar, Switch, memberName, activeMembers, listName,
      enqueue, call, uid, nowIso, snack, local, errText, DOW, p2, ymd, todayYmd, parseYmd, addDays, mdLabel, dayWord, dateWord,
      rrParse, rrFormat, rrLabel, rrPresets, rrStep, rrNext, nthOf, isLastWeek, daysInMonth, openPop, openPopAt, closePop, confirmDlg,
      openTask, complete, uncomplete, act, newSortOrder, openRepeatDialog, setPref, setMode, doLabel, dueLabel, isOverdue,
    });
    setInterval(() => { if (S.ready) CAL.tick(); }, 20000);
  }
  start();
})();
