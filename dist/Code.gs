/* 本部タスク（このファイルは gas/ から自動で作っています。直すときは gas/ を直して node dev/build.js） */

/* ===== Code.gs ===== */
/**
 * ネコロボマン 本部タスク
 * Google ToDo リストと同じ操作感のタスク管理に、
 * 「誰が・いつまでに・何を」の必須入力・進捗管理・毎時のメール通知を足したもの。
 *
 * このファイル: 画面の表示、画面からの呼び出しの窓口、最初の設定
 */

const APP_TITLE = '本部タスク';

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  t.initialTask = String((e && e.parameter && e.parameter.task) || '').replace(/[^A-Za-z0-9_-]/g, '');
  return t.evaluate()
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * 画面からの呼び出しは、すべてここを通す。
 * 戻り値は JSON の文字列（日付などの変換で崩れないようにするため）。
 */
const API = {
  bootstrap: p => api_bootstrap(p),
  sync: p => api_sync(p),
  createList: p => api_createList(p),
  updateList: p => api_updateList(p),
  deleteList: p => api_deleteList(p),
  reorderLists: p => api_reorderLists(p),
  createTask: p => api_createTask(p),
  updateTask: p => api_updateTask(p),
  deleteTask: p => api_deleteTask(p),
  restoreTask: p => api_restoreTask(p),
  clearCompleted: p => api_clearCompleted(p),
  addNote: p => api_addNote(p),
  taskDetail: p => api_taskDetail(p),
  trash: p => api_trash(p),
  saveMember: p => api_saveMember(p),
  saveConfig: p => api_saveConfig(p),
  mailStatus: p => api_mailStatus(p),
  previewReport: p => api_previewReport(p),
  sendTestMail: p => api_sendTestMail(p),
  installTriggers: p => api_installTriggers(p),
};

function rpc(name, payload) {
  const fn = API[name];
  if (!fn) throw new Error('不明な操作です: ' + name);
  const result = fn(payload || {});
  return JSON.stringify(result === undefined ? null : result);
}

const SETUP_VER = '2';
const TRIGGER_VER = '2';

/**
 * 最初の設定。Apps Script のエディタから実行する（忘れても、公開したアプリを最初に開いたときに自動で実行される）。
 * - データ用のシートを作る（なければ）
 * - 最初のリスト「マイタスク」を作る
 * - 1分ごとの自動実行（毎時メール・ごみ箱の片付け）を設定する
 * 何回実行しても大丈夫。
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss && props.getProperty('SHEET_ID')) ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  if (!ss) ss = SpreadsheetApp.create('本部タスク（データ）');
  props.setProperty('SHEET_ID', ss.getId());
  ss_.cache = ss;

  Object.keys(SHEET_DEFS).forEach(key => ensureSheet_(ss, key));
  ['シート1', 'Sheet1'].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });

  if (!props.getProperty('REV')) props.setProperty('REV', '1');

  tx_('', ctx => {
    const lists = ctx.table('lists');
    if (lists.all().some(l => !l.deletedAt)) return;
    const list = { id: newId_(), name: 'マイタスク', sortMode: 'my', sortOrder: 1, createdAt: ctx.now, createdBy: '', updatedAt: ctx.now, updatedBy: '', deletedAt: '', rev: ctx.rev };
    lists.insert(list);
  });

  installTriggers_();
  props.setProperty('SETUP_VER', SETUP_VER);
  console.log('準備ができました。データ: ' + ss.getUrl());
  console.log('次に「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」で公開してください。');
}

function installTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'tick')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
  PropertiesService.getScriptProperties().setProperty('TRIGGER_VER', TRIGGER_VER);
}

/** 公開したアプリを開いたときに、最初の設定や自動実行の入れ替えが済んでいなければ行う */
function ensureSetup_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SETUP_VER') !== SETUP_VER) setup();
  else if (props.getProperty('TRIGGER_VER') !== TRIGGER_VER) installTriggers_();
}

function api_installTriggers() {
  installTriggers_();
  return api_mailStatus({});
}

/** メールに載せるアプリのURL（公開URLで開かれたときに覚えておく） */
function appUrl_() {
  const props = PropertiesService.getScriptProperties();
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  if (/\/exec$/.test(url)) {
    if (props.getProperty('APP_URL') !== url) props.setProperty('APP_URL', url);
    return url;
  }
  return props.getProperty('APP_URL') || url;
}

/* ===== Db.gs ===== */
/**
 * データの保存（スプレッドシート）と「最新情報を反映するしくみ」
 *
 * 同じアカウントを何人かで同時に使うため、次のようにしている。
 * 1. 書き込みは1件ずつ順番に行う（ロック）。同時に押しても、データが壊れない
 * 2. 書き込むたびに「同期番号」を1つ進め、変えた行にその番号を付ける
 * 3. 画面は数秒ごとに「前に見た番号より新しい行」だけを取りに来る
 *    （番号が変わっていなければ、シートを読まずにすぐ返す）
 * 4. 画面からは「変えた項目だけ」を送る。別の人が同じタスクの別の項目を
 *    変えていても、上書きせずに合わせて保存する
 */

const SHEET_DEFS = {
  lists: {
    name: 'リスト',
    cols: [['id', 'ID'], ['name', 'リスト名'], ['sortMode', '並べ替え'], ['sortOrder', '並び順'],
      ['createdAt', '作成日時'], ['createdBy', '作成者'], ['updatedAt', '更新日時'], ['updatedBy', '更新者'],
      ['deletedAt', '削除日時'], ['rev', '同期番号']],
  },
  tasks: {
    name: 'タスク',
    cols: [['id', 'ID'], ['listId', 'リストID'], ['parentId', '親タスクID'], ['title', 'タスク名（何を）'],
      ['details', '詳細（どのように）'], ['assignee', '担当者（誰が）'], ['due', '期限日（いつまでに）'],
      ['dueTime', '期限時刻'], ['repeat', '繰り返し'], ['starred', 'スター'], ['starredAt', 'スター日時'],
      ['status', 'ステータス'], ['sortOrder', '並び順'], ['createdAt', '作成日時'], ['createdBy', '作成者'],
      ['updatedAt', '更新日時'], ['updatedBy', '更新者'], ['completedAt', '完了日時'], ['completedBy', '完了者'],
      ['onTime', '期限内に完了'], ['noteText', '最新状況'], ['noteAt', '最新状況の日時'], ['noteBy', '最新状況の入力者'],
      ['nextId', '次回のタスクID'], ['deletedAt', '削除日時'], ['deletedBy', '削除者'], ['version', '版'], ['rev', '同期番号']],
  },
  members: {
    name: 'メンバー',
    cols: [['id', 'ID'], ['name', '名前'], ['email', 'メール'], ['active', '在籍'], ['sortOrder', '並び順'],
      ['createdAt', '作成日時'], ['updatedAt', '更新日時'], ['rev', '同期番号']],
  },
  notes: {
    name: '最新状況',
    cols: [['id', 'ID'], ['taskId', 'タスクID'], ['text', '内容'], ['by', '入力者'], ['at', '日時']],
  },
  history: {
    name: '変更履歴',
    cols: [['id', 'ID'], ['taskId', 'タスクID'], ['action', '操作'], ['field', '項目'], ['before', '変更前'],
      ['after', '変更後'], ['by', '操作した人'], ['at', '日時']],
  },
  config: {
    name: '設定',
    cols: [['key', '項目'], ['value', '値'], ['updatedAt', '更新日時'], ['rev', '同期番号']],
  },
  maillog: {
    name: 'メール送信履歴',
    cols: [['at', '日時'], ['to', '宛先'], ['subject', '件名'], ['result', '結果'], ['error', 'エラー']],
  },
};

const NUM_COLS = { sortOrder: 1, rev: 1, version: 1 };
const BOOL_COLS = { starred: 1, active: 1, onTime: 1 };

function ss_() {
  if (ss_.cache) return ss_.cache;
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  ss_.cache = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss_.cache) throw new Error('データのスプレッドシートが見つかりません。最初に setup を実行してください');
  return ss_.cache;
}

function ensureSheet_(ss, key) {
  const def = SHEET_DEFS[key];
  let sh = ss.getSheetByName(def.name);
  if (!sh) sh = ss.insertSheet(def.name);
  const n = def.cols.length;
  if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
  sh.getRange(1, 1, sh.getMaxRows(), n).setNumberFormat('@');
  sh.getRange(1, 1, 1, n).setValues([def.cols.map(c => c[1])]).setFontWeight('bold').setBackground('#e8f0fe');
  sh.setFrozenRows(1);
  return sh;
}

function sheet_(key) {
  const ss = ss_();
  return ss.getSheetByName(SHEET_DEFS[key].name) || ensureSheet_(ss, key);
}

/** シート1枚を、行の配列として扱うための入れ物 */
function Table(key) {
  this.key = key;
  this.cols = SHEET_DEFS[key].cols.map(c => c[0]);
  this.sheet = sheet_(key);
  const n = this.sheet.getLastRow() - 1;
  this.rows = n > 0 ? this.sheet.getRange(2, 1, n, this.cols.length).getValues() : [];
  this._index = null;
}

Table.prototype.toObj = function (row) {
  const o = {};
  for (let i = 0; i < this.cols.length; i++) o[this.cols[i]] = normCell_(this.cols[i], row[i]);
  return o;
};

Table.prototype.toRow = function (obj) {
  return this.cols.map(c => {
    const v = obj[c];
    if (v === undefined || v === null) return '';
    if (BOOL_COLS[c]) return v === true || v === 'TRUE' || v === 'true';
    return v;
  });
};

Table.prototype.all = function () {
  return this.rows.map(r => this.toObj(r));
};

Table.prototype.index = function () {
  if (!this._index) {
    this._index = {};
    for (let i = 0; i < this.rows.length; i++) this._index[String(this.rows[i][0])] = i;
  }
  return this._index;
};

Table.prototype.get = function (id) {
  const i = this.index()[String(id)];
  return i === undefined ? null : this.toObj(this.rows[i]);
};

Table.prototype.insert = function (obj) {
  const row = this.toRow(obj);
  const r = this.rows.length + 2;
  if (r > this.sheet.getMaxRows()) {
    this.sheet.insertRowsAfter(this.sheet.getMaxRows(), 500);
    this.sheet.getRange(r, 1, this.sheet.getMaxRows() - r + 1, this.cols.length).setNumberFormat('@');
  }
  this.sheet.getRange(r, 1, 1, this.cols.length).setValues([row]);
  this.rows.push(row);
  if (this._index) this._index[String(row[0])] = this.rows.length - 1;
};

Table.prototype.update = function (obj) {
  const i = this.index()[String(obj.id)];
  if (i === undefined) throw new Error('データが見つかりません');
  const row = this.toRow(obj);
  this.sheet.getRange(i + 2, 1, 1, this.cols.length).setValues([row]);
  this.rows[i] = row;
};

/** 残す行だけで書き直す（ごみ箱の片付け用） */
Table.prototype.rewrite = function (keepObjs) {
  const n = this.rows.length;
  if (n > 0) this.sheet.getRange(2, 1, n, this.cols.length).clearContent();
  const rows = keepObjs.map(o => this.toRow(o));
  if (rows.length) this.sheet.getRange(2, 1, rows.length, this.cols.length).setValues(rows);
  this.rows = rows;
  this._index = null;
};

function normCell_(col, v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const j = jst_(v);
    if (col === 'due') return ymdStr_(j.y, j.mo, j.d);
    if (col === 'dueTime') return pad2_(j.h) + ':' + pad2_(j.mi);
    return v.toISOString();
  }
  if (NUM_COLS[col]) return Number(v) || 0;
  if (BOOL_COLS[col]) return v === true || v === 'TRUE' || v === 'true';
  return v === null || v === undefined ? '' : String(v);
}

/**
 * 書き込みの入口。ロックを取り、同期番号を1つ進めて fn を実行する。
 * fn の中では ctx.table(key) でシートを読み書きし、変えたものを ctx.mark で知らせる。
 */
function tx_(actor, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('BUSY: 混み合っています。少し待ってからもう一度お試しください');
  try {
    const props = PropertiesService.getScriptProperties();
    const rev = Number(props.getProperty('REV') || 0) + 1;
    const tables = {};
    const changed = { lists: {}, tasks: {}, members: {} };
    const ctx = {
      rev: rev,
      now: new Date().toISOString(),
      actor: String(actor || ''),
      config: null,
      table: key => tables[key] || (tables[key] = new Table(key)),
      mark: (kind, obj) => { changed[kind][obj.id] = obj; },
    };
    const extra = fn(ctx) || {};
    SpreadsheetApp.flush();
    // 書き終わってから番号を公開する（読み途中の画面が取りこぼさないように）
    props.setProperty('REV', String(rev));
    CacheService.getScriptCache().put('REV', String(rev), 21600);
    const out = {
      rev: rev,
      lists: values_(changed.lists),
      tasks: values_(changed.tasks),
      members: values_(changed.members),
    };
    if (ctx.config) out.config = ctx.config;
    return Object.assign(out, extra);
  } finally {
    lock.releaseLock();
  }
}

function publishedRev_() {
  const cache = CacheService.getScriptCache();
  const c = cache.get('REV');
  if (c !== null && c !== undefined) return Number(c);
  const r = Number(PropertiesService.getScriptProperties().getProperty('REV') || 0);
  cache.put('REV', String(r), 21600);
  return r;
}

/** 画面が数秒ごとに呼ぶ。前回の番号より新しいものだけ返す */
function api_sync(p) {
  const since = Number(p.rev || 0);
  const rev = publishedRev_();
  if (since && since === rev) return { rev: rev, unchanged: true };

  const purgeRev = Number(PropertiesService.getScriptProperties().getProperty('PURGE_REV') || 0);
  const full = !since || since < purgeRev || since > rev;
  const out = { rev: rev, full: full };
  const oldDone = new Date(Date.now() - 90 * 86400000).toISOString();

  out.lists = new Table('lists').all().filter(l => full ? !l.deletedAt : l.rev > since);
  out.tasks = new Table('tasks').all().filter(t => {
    if (!full) return t.rev > since;
    if (t.deletedAt) return false;
    return t.status !== 'done' || !t.completedAt || t.completedAt >= oldDone;
  });
  out.members = new Table('members').all().filter(m => full || m.rev > since);
  const cfgRow = new Table('config').get('app');
  if (full || (cfgRow && cfgRow.rev > since)) out.config = getConfig_();
  return out;
}

function api_bootstrap() {
  ensureSetup_();
  const out = api_sync({ rev: 0 });
  out.appUrl = appUrl_();
  out.serverTime = new Date().toISOString();
  return out;
}

/* ---------- 設定 ---------- */

const DEFAULT_CONFIG = {
  mail: {
    enabled: false,
    recipients: [],
    days: [1, 2, 3, 4, 5],
    startHour: 10,
    endHour: 17,
    summaryTime: '17:30',
    skipHolidays: true,
    skipYearEnd: true,
    sendWhenNoChange: true,
  },
  soonDays: 3,
  staleDays: 3,
};

function getConfig_() {
  // 1分ごとの自動実行で毎回シートを読まないよう、しばらく覚えておく（保存すると更新）
  const cache = CacheService.getScriptCache();
  let raw = cache.get('CONFIG');
  if (raw === null || raw === undefined) {
    const row = new Table('config').get('app');
    raw = row && row.value ? row.value : '{}';
    cache.put('CONFIG', raw, 3600);
  }
  let saved = {};
  try { saved = JSON.parse(raw); } catch (e) { saved = {}; }
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.keys(saved).forEach(k => {
    if (k === 'mail' && saved.mail) Object.assign(cfg.mail, saved.mail);
    else cfg[k] = saved[k];
  });
  return cfg;
}

function api_saveConfig(p) {
  const c = p.config || {};
  const m = c.mail || {};
  const emails = (Array.isArray(m.recipients) ? m.recipients : [])
    .map(s => String(s).trim()).filter(Boolean);
  emails.forEach(e => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('メールアドレスの形が正しくありません: ' + e);
  });
  if (emails.length > 50) throw new Error('送信先は50件までです');
  const hour = (v, d) => { const n = Number(v); return n >= 0 && n <= 23 ? Math.floor(n) : d; };
  const cfg = {
    mail: {
      enabled: !!m.enabled,
      recipients: emails.filter((e, i) => emails.indexOf(e) === i),
      days: (Array.isArray(m.days) ? m.days : []).map(Number).filter(d => d >= 0 && d <= 6),
      startHour: hour(m.startHour, 10),
      endHour: hour(m.endHour, 17),
      summaryTime: m.summaryTime ? String(m.summaryTime) : '',
      skipHolidays: !!m.skipHolidays,
      skipYearEnd: !!m.skipYearEnd,
      sendWhenNoChange: !!m.sendWhenNoChange,
    },
    soonDays: Math.min(14, Math.max(1, Math.floor(Number(c.soonDays) || 3))),
    staleDays: Math.min(30, Math.max(1, Math.floor(Number(c.staleDays) || 3))),
  };
  if (cfg.mail.endHour < cfg.mail.startHour) throw new Error('送る時間帯の「まで」は「から」より後にしてください');
  if (cfg.mail.summaryTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.mail.summaryTime)) throw new Error('「今日のまとめ」の時刻が正しくありません');
  if (cfg.mail.enabled && !cfg.mail.recipients.length) throw new Error('メールを送るには、送信先を1件以上入れてください');
  return tx_(p.actor, ctx => {
    const t = ctx.table('config');
    const row = { id: 'app', key: 'app', value: JSON.stringify(cfg), updatedAt: ctx.now, rev: ctx.rev };
    if (t.get('app')) t.update(row); else t.insert(row);
    CacheService.getScriptCache().put('CONFIG', row.value, 3600);
    ctx.config = cfg;
  });
}

/* ---------- 小さな道具 ---------- */

function values_(obj) {
  return Object.keys(obj).map(k => obj[k]);
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 20);
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function ymdStr_(y, m, d) {
  return y + '-' + pad2_(m) + '-' + pad2_(d);
}

/** 日本時間での年月日・時刻 */
function jst_(date) {
  const d = new Date(date.getTime() + 9 * 3600000);
  const o = {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay(),
  };
  o.ymd = ymdStr_(o.y, o.mo, o.d);
  return o;
}

function addDaysYmd_(ymd, n) {
  const p = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return ymdStr_(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function dowYmd_(ymd) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

/** 期限の日時（時刻なしは、その日の 23:59 まで） */
function dueAt_(task) {
  if (!task.due) return Infinity;
  return new Date(task.due + 'T' + (task.dueTime || '23:59') + ':59+09:00').getTime();
}

/* ===== Api.gs ===== */
/**
 * 画面から呼ばれる操作（リスト・タスク・最新状況・メンバー）
 */

const TASK_FIELDS = ['listId', 'title', 'details', 'assignee', 'due', 'dueTime', 'repeat', 'starred', 'status', 'sortOrder'];
const HISTORY_FIELDS = { title: 1, assignee: 1, due: 1, dueTime: 1, status: 1, listId: 1, repeat: 1 };
const SORT_MODES = ['my', 'date', 'starred', 'title', 'assignee'];
const STATUSES = ['todo', 'doing', 'done'];

/* ---------- 入力チェック ---------- */

function str_(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max);
}

function checkId_(id) {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(id || ''))) throw new Error('IDが正しくありません');
  return String(id);
}

function checkDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('期限の日付が正しくありません');
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  if (d.getUTCMonth() !== p[1] - 1) throw new Error('期限の日付が正しくありません');
  return s;
}

function checkTime_(s) {
  if (s && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error('期限の時刻が正しくありません');
  return s;
}

function checkRepeat_(s) {
  if (!s) return '';
  if (/^(daily|weekdays|weekly|monthly|yearly)$/.test(s)) return s;
  if (/^every:\d{1,3}:(day|week|month|year)(:[0-6](,[0-6]){0,6})?$/.test(s) && Number(s.split(':')[1]) > 0) return s;
  throw new Error('繰り返しの設定が正しくありません');
}

function checkMember_(ctx, id) {
  const m = ctx.table('members').get(id);
  if (!m) throw new Error('担当者が見つかりません。メンバーに登録してください');
  return id;
}

function activeList_(ctx, id) {
  const l = ctx.table('lists').get(id);
  if (!l || l.deletedAt) throw new Error('リストが見つかりません。画面を読み込み直してください');
  return l;
}

function liveTask_(ctx, id) {
  const t = ctx.table('tasks').get(id);
  if (!t || t.deletedAt) throw new Error('このタスクは削除されています');
  return t;
}

function addHistory_(ctx, taskId, action, field, before, after) {
  ctx.table('history').insert({
    id: newId_(), taskId: taskId, action: action, field: field || '',
    before: before === undefined ? '' : String(before), after: after === undefined ? '' : String(after),
    by: ctx.actor, at: ctx.now,
  });
}

function saveTask_(ctx, task) {
  task.version = (Number(task.version) || 0) + 1;
  task.rev = ctx.rev;
  task.updatedAt = ctx.now;
  task.updatedBy = ctx.actor;
  ctx.table('tasks').update(task);
  ctx.mark('tasks', task);
}

/* ---------- リスト ---------- */

function api_createList(p) {
  return tx_(p.actor, ctx => {
    const id = checkId_(p.id);
    const name = str_(p.name, 100);
    if (!name) throw new Error('リスト名を入れてください');
    const lists = ctx.table('lists');
    if (lists.get(id)) { ctx.mark('lists', lists.get(id)); return; }
    const max = lists.all().reduce((a, l) => Math.max(a, l.sortOrder), 0);
    const list = { id: id, name: name, sortMode: 'my', sortOrder: max + 1, createdAt: ctx.now, createdBy: ctx.actor, updatedAt: ctx.now, updatedBy: ctx.actor, deletedAt: '', rev: ctx.rev };
    lists.insert(list);
    ctx.mark('lists', list);
  });
}

function api_updateList(p) {
  return tx_(p.actor, ctx => {
    const list = activeList_(ctx, p.id);
    const patch = p.patch || {};
    if ('name' in patch) {
      const name = str_(patch.name, 100);
      if (!name) throw new Error('リスト名を入れてください');
      list.name = name;
    }
    if ('sortMode' in patch) {
      if (SORT_MODES.indexOf(patch.sortMode) < 0) throw new Error('並べ替えの指定が正しくありません');
      list.sortMode = patch.sortMode;
    }
    list.updatedAt = ctx.now;
    list.updatedBy = ctx.actor;
    list.rev = ctx.rev;
    ctx.table('lists').update(list);
    ctx.mark('lists', list);
  });
}

function api_deleteList(p) {
  return tx_(p.actor, ctx => {
    const list = activeList_(ctx, p.id);
    const lists = ctx.table('lists');
    if (lists.all().filter(l => !l.deletedAt).length <= 1) throw new Error('リストは最低1つ必要です');
    list.deletedAt = ctx.now;
    list.updatedBy = ctx.actor;
    list.rev = ctx.rev;
    lists.update(list);
    ctx.mark('lists', list);
    ctx.table('tasks').all()
      .filter(t => t.listId === list.id && !t.deletedAt)
      .forEach(t => {
        t.deletedAt = ctx.now;
        t.deletedBy = ctx.actor;
        saveTask_(ctx, t);
      });
  });
}

function api_reorderLists(p) {
  return tx_(p.actor, ctx => {
    const lists = ctx.table('lists');
    (p.ids || []).forEach((id, i) => {
      const l = lists.get(id);
      if (!l || l.deletedAt || l.sortOrder === i + 1) return;
      l.sortOrder = i + 1;
      l.rev = ctx.rev;
      l.updatedAt = ctx.now;
      lists.update(l);
      ctx.mark('lists', l);
    });
  });
}

/* ---------- タスク ---------- */

function api_createTask(p) {
  return tx_(p.actor, ctx => {
    const t = p.task || {};
    const id = checkId_(t.id);
    const tasks = ctx.table('tasks');
    const existing = tasks.get(id);
    if (existing) { ctx.mark('tasks', existing); return; } // 通信のやり直しで2回届いたとき
    const task = buildTask_(ctx, t);
    task.id = id;
    tasks.insert(task);
    ctx.mark('tasks', task);
    addHistory_(ctx, id, 'create', '', '', task.title);
  });
}

function buildTask_(ctx, t) {
  const tasks = ctx.table('tasks');
  let parent = null;
  if (t.parentId) {
    parent = liveTask_(ctx, t.parentId);
    if (parent.parentId) throw new Error('サブタスクの中にはサブタスクを作れません');
  }
  const list = activeList_(ctx, parent ? parent.listId : t.listId);
  const title = str_(t.title, 500);
  if (!title) throw new Error('タスク名（何を）を入れてください');
  const assignee = str_(t.assignee, 64);
  const due = str_(t.due, 10);
  if (!parent) {
    if (!assignee) throw new Error('担当者（誰が）を選んでください');
    if (!due) throw new Error('期限（いつまでに）を選んでください');
  }
  if (assignee) checkMember_(ctx, assignee);
  if (due) checkDate_(due);
  const dueTime = due ? checkTime_(str_(t.dueTime, 5)) : '';
  const starred = t.starred === true;
  return {
    id: '', listId: list.id, parentId: parent ? parent.id : '',
    title: title, details: str_(t.details, 5000), assignee: assignee, due: due, dueTime: dueTime,
    repeat: parent ? '' : checkRepeat_(str_(t.repeat, 40)),
    starred: starred, starredAt: starred ? ctx.now : '', status: 'todo',
    sortOrder: isFinite(Number(t.sortOrder)) ? Number(t.sortOrder) : 0,
    createdAt: ctx.now, createdBy: ctx.actor, updatedAt: ctx.now, updatedBy: ctx.actor,
    completedAt: '', completedBy: '', onTime: '', noteText: '', noteAt: '', noteBy: '',
    nextId: '', deletedAt: '', deletedBy: '', version: 1, rev: ctx.rev,
  };
}

function api_updateTask(p) {
  return tx_(p.actor, ctx => {
    const task = liveTask_(ctx, p.id);
    const before = Object.assign({}, task);
    const patch = p.patch || {};
    const merged = !!p.baseVersion && Number(p.baseVersion) !== task.version;
    // ほかの人の変更と重ねて保存したときは、その人を画面に知らせる
    const mergedBy = merged && before.updatedBy && before.updatedBy !== ctx.actor ? before.updatedBy : '';
    const top = !task.parentId;

    TASK_FIELDS.forEach(k => {
      if (!(k in patch)) return;
      const v = patch[k];
      switch (k) {
        case 'title': {
          const s = str_(v, 500);
          if (!s) throw new Error('タスク名（何を）は空にできません');
          task.title = s;
          break;
        }
        case 'details': task.details = str_(v, 5000); break;
        case 'assignee': {
          const s = str_(v, 64);
          if (!s && top) throw new Error('担当者（誰が）は空にできません');
          if (s) checkMember_(ctx, s);
          task.assignee = s;
          break;
        }
        case 'due': {
          const s = str_(v, 10);
          if (!s && top) throw new Error('期限（いつまでに）は空にできません');
          task.due = s ? checkDate_(s) : '';
          if (!s) task.dueTime = '';
          break;
        }
        case 'dueTime': task.dueTime = task.due ? checkTime_(str_(v, 5)) : ''; break;
        case 'repeat': task.repeat = top ? checkRepeat_(str_(v, 40)) : ''; break;
        case 'starred':
          task.starred = v === true;
          task.starredAt = task.starred ? (before.starred ? before.starredAt : ctx.now) : '';
          break;
        case 'status':
          if (STATUSES.indexOf(v) < 0) throw new Error('ステータスが正しくありません');
          task.status = v;
          break;
        case 'sortOrder':
          if (isFinite(Number(v))) task.sortOrder = Number(v);
          break;
        case 'listId':
          if (top && v !== task.listId) task.listId = activeList_(ctx, v).id;
          break;
      }
    });

    const changedKeys = Object.keys(HISTORY_FIELDS).filter(k => String(before[k]) !== String(task[k]));
    const anyChange = TASK_FIELDS.some(k => String(before[k]) !== String(task[k]));
    if (!anyChange) { ctx.mark('tasks', task); return { merged: merged, mergedBy: mergedBy }; }

    if (before.status !== task.status) applyStatus_(ctx, task, before.status);
    saveTask_(ctx, task);
    changedKeys.forEach(k => addHistory_(ctx, task.id, 'update', k, before[k], task[k]));

    if (top && before.listId !== task.listId) {
      childrenOf_(ctx, task.id).forEach(c => { c.listId = task.listId; saveTask_(ctx, c); });
    }
    return { merged: merged, mergedBy: mergedBy };
  });
}

function childrenOf_(ctx, id) {
  return ctx.table('tasks').all().filter(t => t.parentId === id && !t.deletedAt);
}

/** 完了にしたとき・戻したときの後始末（完了日時・サブタスク・繰り返し） */
function applyStatus_(ctx, task, oldStatus) {
  if (task.status === 'done' && oldStatus !== 'done') {
    task.completedAt = ctx.now;
    task.completedBy = ctx.actor;
    task.onTime = task.due ? Date.now() <= dueAt_(task) : '';
    childrenOf_(ctx, task.id).filter(c => c.status !== 'done').forEach(c => {
      c.status = 'done';
      c.completedAt = ctx.now;
      c.completedBy = ctx.actor;
      saveTask_(ctx, c);
    });
    if (task.repeat && !task.parentId && !task.nextId && task.due) {
      const next = Object.assign({}, task, {
        id: newId_(), due: nextDue_(task.due, task.repeat), status: 'todo',
        createdAt: ctx.now, createdBy: ctx.actor, completedAt: '', completedBy: '', onTime: '',
        noteText: '', noteAt: '', noteBy: '', nextId: '', version: 1, rev: ctx.rev,
        updatedAt: ctx.now, updatedBy: ctx.actor, starredAt: task.starred ? ctx.now : '',
      });
      ctx.table('tasks').insert(next);
      ctx.mark('tasks', next);
      addHistory_(ctx, next.id, 'create', 'repeat', task.id, next.title);
      childrenOf_(ctx, task.id).forEach(c => {
        const sub = Object.assign({}, c, {
          id: newId_(), parentId: next.id, status: 'todo', completedAt: '', completedBy: '', onTime: '',
          createdAt: ctx.now, createdBy: ctx.actor, updatedAt: ctx.now, updatedBy: ctx.actor,
          noteText: '', noteAt: '', noteBy: '', version: 1, rev: ctx.rev,
          due: c.due ? nextDue_(c.due, task.repeat) : '',
        });
        ctx.table('tasks').insert(sub);
        ctx.mark('tasks', sub);
      });
      task.nextId = next.id;
    }
  } else if (task.status !== 'done' && oldStatus === 'done') {
    task.completedAt = '';
    task.completedBy = '';
    task.onTime = '';
  }
}

/** 繰り返しの次の期限 */
function nextDue_(due, repeat) {
  const p = due.split('-').map(Number);
  const y = p[0], m = p[1] - 1, d = p[2];
  const fmt = t => ymdStr_(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  const addMonths = n => {
    const last = new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate();
    return fmt(new Date(Date.UTC(y, m + n, Math.min(d, last))));
  };
  switch (repeat) {
    case 'daily': return addDaysYmd_(due, 1);
    case 'weekdays': {
      let n = addDaysYmd_(due, 1);
      while (dowYmd_(n) === 0 || dowYmd_(n) === 6) n = addDaysYmd_(n, 1);
      return n;
    }
    case 'weekly': return addDaysYmd_(due, 7);
    case 'monthly': return addMonths(1);
    case 'yearly': return addMonths(12);
  }
  const parts = repeat.split(':');
  const every = Number(parts[1]);
  const unit = parts[2];
  if (unit === 'day') return addDaysYmd_(due, every);
  if (unit === 'month') return addMonths(every);
  if (unit === 'year') return addMonths(12 * every);
  // week
  const days = parts[3] ? parts[3].split(',').map(Number) : [];
  if (!days.length) return addDaysYmd_(due, 7 * every);
  const weekNo = ymd => Math.floor((Date.UTC.apply(null, ymd.split('-').map((v, i) => i === 1 ? v - 1 : Number(v))) / 86400000 + 3) / 7);
  const base = weekNo(due);
  for (let i = 1; i <= 7 * every + 7; i++) {
    const n = addDaysYmd_(due, i);
    if (days.indexOf(dowYmd_(n)) >= 0 && (weekNo(n) - base) % every === 0) return n;
  }
  return addDaysYmd_(due, 7 * every);
}

function api_deleteTask(p) {
  return tx_(p.actor, ctx => {
    const task = liveTask_(ctx, p.id);
    task.deletedAt = ctx.now;
    task.deletedBy = ctx.actor;
    saveTask_(ctx, task);
    childrenOf_(ctx, task.id).forEach(c => {
      c.deletedAt = ctx.now;
      c.deletedBy = ctx.actor;
      saveTask_(ctx, c);
    });
    addHistory_(ctx, task.id, 'delete', '', '', '');
  });
}

function api_restoreTask(p) {
  return tx_(p.actor, ctx => {
    const tasks = ctx.table('tasks');
    const task = tasks.get(p.id);
    if (!task) throw new Error('このタスクは見つかりません（30日たって完全に削除された可能性があります）');
    if (!task.deletedAt) { ctx.mark('tasks', task); return; }
    if (task.parentId) {
      const parent = tasks.get(task.parentId);
      if (!parent || parent.deletedAt) throw new Error('親タスクが削除されているため戻せません。先に親タスクを戻してください');
    }
    const deletedAt = task.deletedAt;
    const list = ctx.table('lists').get(task.listId);
    let listId = task.listId;
    if (!list || list.deletedAt) {
      const alive = ctx.table('lists').all().filter(l => !l.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder);
      listId = alive[0].id;
    }
    task.deletedAt = '';
    task.deletedBy = '';
    task.listId = listId;
    saveTask_(ctx, task);
    tasks.all().filter(c => c.parentId === task.id && c.deletedAt === deletedAt).forEach(c => {
      c.deletedAt = '';
      c.deletedBy = '';
      c.listId = listId;
      saveTask_(ctx, c);
    });
    addHistory_(ctx, task.id, 'restore', '', '', '');
  });
}

function api_clearCompleted(p) {
  return tx_(p.actor, ctx => {
    const list = activeList_(ctx, p.listId);
    const all = ctx.table('tasks').all().filter(t => t.listId === list.id && !t.deletedAt);
    const doneTop = {};
    all.forEach(t => { if (!t.parentId && t.status === 'done') doneTop[t.id] = true; });
    all.filter(t => t.status === 'done' || doneTop[t.parentId]).forEach(t => {
      t.deletedAt = ctx.now;
      t.deletedBy = ctx.actor;
      saveTask_(ctx, t);
    });
  });
}

function api_trash() {
  const limit = new Date(Date.now() - 30 * 86400000).toISOString();
  const tasks = new Table('tasks').all();
  const byId = {};
  tasks.forEach(t => { byId[t.id] = t; });
  const lists = {};
  new Table('lists').all().forEach(l => { lists[l.id] = l; });
  const items = tasks.filter(t => {
    if (!t.deletedAt || t.deletedAt < limit) return false;
    if (!t.parentId) return true;
    const parent = byId[t.parentId];
    return parent && !parent.deletedAt;
  }).map(t => ({
    id: t.id, title: t.title, parentTitle: t.parentId ? byId[t.parentId].title : '',
    listName: lists[t.listId] ? lists[t.listId].name : '', listDeleted: !lists[t.listId] || !!lists[t.listId].deletedAt,
    assignee: t.assignee, due: t.due, status: t.status, deletedAt: t.deletedAt, deletedBy: t.deletedBy,
  }));
  items.sort((a, b) => a.deletedAt < b.deletedAt ? 1 : -1);
  return { items: items };
}

/* ---------- 最新状況 ---------- */

function api_addNote(p) {
  return tx_(p.actor, ctx => {
    const task = liveTask_(ctx, p.taskId);
    const text = str_(p.text, 2000);
    if (!text) throw new Error('最新状況を入れてください');
    const id = p.id ? checkId_(p.id) : newId_();
    const notes = ctx.table('notes');
    if (notes.get(id)) { ctx.mark('tasks', task); return; }
    notes.insert({ id: id, taskId: task.id, text: text, by: ctx.actor, at: ctx.now });
    task.noteText = text;
    task.noteAt = ctx.now;
    task.noteBy = ctx.actor;
    if (task.status === 'todo') {
      task.status = 'doing';
      addHistory_(ctx, task.id, 'update', 'status', 'todo', 'doing');
    }
    saveTask_(ctx, task);
  });
}

function api_taskDetail(p) {
  const id = String(p.id || '');
  const notes = new Table('notes').all().filter(n => n.taskId === id);
  const history = new Table('history').all().filter(h => h.taskId === id);
  notes.sort((a, b) => a.at < b.at ? 1 : -1);
  history.sort((a, b) => a.at < b.at ? 1 : -1);
  return { id: id, notes: notes.slice(0, 200), history: history.slice(0, 200) };
}

/* ---------- メンバー ---------- */

function api_saveMember(p) {
  return tx_(p.actor, ctx => {
    const m = p.member || {};
    const id = checkId_(m.id);
    const name = str_(m.name, 50);
    if (!name) throw new Error('名前を入れてください');
    const email = str_(m.email, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('メールアドレスの形が正しくありません');
    const members = ctx.table('members');
    const all = members.all();
    if (all.some(x => x.id !== id && x.active && x.name === name)) throw new Error('同じ名前のメンバーがいます');
    const cur = members.get(id);
    const row = {
      id: id, name: name, email: email, active: m.active !== false,
      sortOrder: cur ? cur.sortOrder : all.reduce((a, x) => Math.max(a, x.sortOrder), 0) + 1,
      createdAt: cur ? cur.createdAt : ctx.now, updatedAt: ctx.now, rev: ctx.rev,
    };
    if (cur) members.update(row); else members.insert(row);
    ctx.mark('members', row);
  });
}

/* ===== Mail.gs ===== */
/**
 * 毎時のメール通知と、夜中の片付け
 * 1分ごとに tick が動き、送る時刻（毎時ちょうど・まとめの時刻）になったら1回だけ送る。
 */

function tick() {
  const now = new Date();
  try {
    maybeSendReport_(now);
  } catch (e) {
    logMail_('', '', 'エラー', e && e.message);
  }
  try {
    dailyCleanup_(now);
  } catch (e) {
    console.error(e);
  }
}

/** その日にメールを送る時刻。毎時ちょうど（startHour〜endHour）と「今日のまとめ」の時刻 */
function mailSlots_(m) {
  const slots = [];
  for (let h = m.startHour; h <= m.endHour; h++) slots.push({ time: pad2_(h) + ':00', summary: false });
  if (m.summaryTime) {
    const same = slots.filter(s => s.time === m.summaryTime)[0];
    if (same) same.summary = true;
    else slots.push({ time: m.summaryTime, summary: true });
  }
  return slots.sort((a, b) => (a.time < b.time ? -1 : 1));
}

function toMin_(hhmm) {
  const p = hhmm.split(':').map(Number);
  return p[0] * 60 + p[1];
}

function maybeSendReport_(now) {
  const m = getConfig_().mail;
  if (!m.enabled || !m.recipients.length) return false;
  const j = jst_(now);
  if (m.days.indexOf(j.dow) < 0) return false;
  // 今の時刻までに来た送信時刻のうち一番新しいもの（20分以上遅れた回は送らない）
  const nowMin = j.h * 60 + j.mi;
  const due = mailSlots_(m).filter(s => toMin_(s.time) <= nowMin && nowMin - toMin_(s.time) < 20).pop();
  if (!due) return false;
  const props = PropertiesService.getScriptProperties();
  const key = j.ymd + ' ' + due.time;
  if (props.getProperty('MAIL_SLOT') === key) return false;
  props.setProperty('MAIL_SLOT', key); // 先に印を付けて二重送信を防ぐ
  if (isOffDay_(j.ymd, m)) return false;
  const rev = publishedRev_();
  if (!due.summary && !m.sendWhenNoChange && String(rev) === props.getProperty('MAIL_REV')) return false;
  try {
    const report = buildReport_(now, props.getProperty('MAIL_AT'), { slot: due.time, summary: due.summary });
    sendReport_(m.recipients, report);
    props.setProperties({ MAIL_REV: String(rev), MAIL_AT: now.toISOString() });
    return true;
  } catch (e) {
    props.deleteProperty('MAIL_SLOT'); // 1分後にやり直す
    throw e;
  }
}

function sendReport_(to, report) {
  try {
    MailApp.sendEmail({
      to: to.join(','),
      subject: report.subject,
      body: report.text,
      htmlBody: report.html,
      name: '本部タスク（自動送信）',
    });
    logMail_(to.join(', '), report.subject, '送信済み', '');
  } catch (e) {
    logMail_(to.join(', '), report.subject, '失敗', e && e.message);
    throw e;
  }
}

function logMail_(to, subject, result, error) {
  const t = new Table('maillog');
  t.insert({ id: newId_(), at: new Date().toISOString(), to: to, subject: subject, result: result, error: error || '' });
}

/* ---------- 祝日・会社の休み ---------- */

function isOffDay_(ymd, mailCfg) {
  if (mailCfg.skipYearEnd) {
    const md = ymd.slice(5);
    if (md >= '12-29' || md <= '01-03') return true;
  }
  if (mailCfg.skipHolidays && jpHolidays_(Number(ymd.slice(0, 4)))[ymd]) return true;
  return false;
}

/** 日本の祝日（振替休日・国民の休日を含む） */
function jpHolidays_(year) {
  jpHolidays_.cache = jpHolidays_.cache || {};
  if (jpHolidays_.cache[year]) return jpHolidays_.cache[year];
  const set = {};
  const add = (m, d) => { set[ymdStr_(year, m, d)] = true; };
  const nthMonday = (m, n) => {
    const first = new Date(Date.UTC(year, m - 1, 1)).getUTCDay();
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  };
  const shift = Math.floor((year - 1980) / 4);
  add(1, 1);
  add(1, nthMonday(1, 2));
  add(2, 11);
  add(2, 23);
  add(3, Math.floor(20.8431 + 0.242194 * (year - 1980) - shift));
  add(4, 29);
  add(5, 3);
  add(5, 4);
  add(5, 5);
  add(7, nthMonday(7, 3));
  add(8, 11);
  add(9, nthMonday(9, 3));
  add(9, Math.floor(23.2488 + 0.242194 * (year - 1980) - shift));
  add(10, nthMonday(10, 2));
  add(11, 3);
  add(11, 23);
  const base = Object.keys(set).sort();
  // 国民の休日（祝日にはさまれた平日）
  base.forEach(h => {
    const mid = addDaysYmd_(h, 1);
    if (!set[mid] && set[addDaysYmd_(h, 2)] && dowYmd_(mid) !== 0) set[mid] = true;
  });
  // 振替休日（日曜の祝日 → 次の祝日でない日）
  base.forEach(h => {
    if (dowYmd_(h) !== 0) return;
    let n = addDaysYmd_(h, 1);
    while (set[n]) n = addDaysYmd_(n, 1);
    set[n] = true;
  });
  jpHolidays_.cache[year] = set;
  return set;
}

/* ---------- メールの中身 ---------- */

const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

function fmtMd_(ymd) {
  const p = ymd.split('-').map(Number);
  return p[1] + '/' + p[2] + '(' + DOW_JA[dowYmd_(ymd)] + ')';
}

function fmtAt_(iso) {
  if (!iso) return '';
  const j = jst_(new Date(iso));
  return j.mo + '/' + j.d + ' ' + j.h + ':' + pad2_(j.mi);
}

function esc_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 今の状況をまとめる（メールと「進捗ボード」で同じ考え方） */
function collectStatus_(now, sinceIso, summary) {
  const cfg = getConfig_();
  const j = jst_(now);
  const today = j.ymd;
  const tomorrow = addDaysYmd_(today, 1);
  const soonLimit = addDaysYmd_(today, cfg.soonDays);
  const staleLimit = now.getTime() - cfg.staleDays * 86400000;
  const members = {};
  new Table('members').all().forEach(m => { members[m.id] = m; });
  const lists = {};
  new Table('lists').all().filter(l => !l.deletedAt).forEach(l => { lists[l.id] = l; });
  const all = new Table('tasks').all().filter(t => !t.deletedAt && lists[t.listId]);
  const top = all.filter(t => !t.parentId);
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;
  const hasPrev = !summary && !!sinceMs && now.getTime() - sinceMs < 24 * 3600000;
  const startOfDay = new Date(today + 'T00:00:00+09:00').toISOString();
  const since = summary ? startOfDay : hasPrev ? sinceIso : new Date(now.getTime() - 3600000).toISOString();

  const open = top.filter(t => t.status !== 'done');
  const s = { overdue: [], today: [], soon: [], stale: [], tomorrow: [] };
  open.forEach(t => {
    const at = dueAt_(t);
    if (at < now.getTime()) s.overdue.push(t);
    else if (t.due === today) s.today.push(t);
    else if (t.due && t.due <= soonLimit) s.soon.push(t);
    if (at >= now.getTime() && t.due === tomorrow) s.tomorrow.push(t);
    const last = Math.max(new Date(t.updatedAt || 0).getTime(), new Date(t.noteAt || 0).getTime(), new Date(t.createdAt || 0).getTime());
    if (last < staleLimit) s.stale.push(t);
  });
  const byDue = (a, b) => dueAt_(a) - dueAt_(b);
  s.overdue.sort(byDue);
  s.today.sort(byDue);
  s.soon.sort(byDue);
  s.stale.sort(byDue);
  s.tomorrow.sort(byDue);

  const created = top.filter(t => t.createdAt >= since);
  const completed = top.filter(t => t.status === 'done' && t.completedAt >= since);
  const noteTasks = {};
  new Table('notes').all().forEach(n => { if (n.at >= since) noteTasks[n.taskId] = true; });
  const noted = top.filter(t => noteTasks[t.id]);

  const weekStart = addDaysYmd_(today, -((j.dow + 6) % 7));
  const rows = {};
  const row = id => rows[id] || (rows[id] = { id: id, overdue: 0, today: 0, soon: 0, doing: 0, todo: 0, doneWeek: 0 });
  s.overdue.forEach(t => row(t.assignee).overdue++);
  s.today.forEach(t => row(t.assignee).today++);
  s.soon.forEach(t => row(t.assignee).soon++);
  open.forEach(t => row(t.assignee)[t.status === 'doing' ? 'doing' : 'todo']++);
  top.filter(t => t.status === 'done' && t.completedAt && jst_(new Date(t.completedAt)).ymd >= weekStart)
    .forEach(t => row(t.assignee).doneWeek++);
  const byAssignee = Object.keys(rows).map(k => rows[k]).sort((a, b) => {
    const ma = members[a.id], mb = members[b.id];
    return (ma ? ma.sortOrder : 9999) - (mb ? mb.sortOrder : 9999);
  });

  return {
    now: now, today: today, cfg: cfg, since: since, hasPrev: hasPrev, members: members, lists: lists,
    openCount: open.length, overdue: s.overdue, todayDue: s.today, soon: s.soon, stale: s.stale, tomorrowDue: s.tomorrow, summary: !!summary,
    created: created, completed: completed, noted: noted, byAssignee: byAssignee,
  };
}

/**
 * メールの中身を作る。opts.slot は送る時刻（"14:00" など）、opts.summary は「今日のまとめ」
 */
function buildReport_(now, sinceIso, opts) {
  opts = opts || {};
  const st = collectStatus_(now, sinceIso, opts.summary);
  const sum = st.summary;
  const j = jst_(now);
  const url = appUrl_();
  const name = id => (st.members[id] ? st.members[id].name : '（未設定）');
  const dueText = t => fmtMd_(t.due) + (t.dueTime ? ' ' + t.dueTime : '');
  const overDays = t => Math.max(1, Math.floor((now.getTime() - dueAt_(t)) / 86400000) + 1);
  const statusText = t => (t.status === 'doing' ? '進行中' : t.status === 'done' ? '完了' : '未着手');
  const clock = opts.slot ? String(Number(opts.slot.split(':')[0])) + ':' + opts.slot.split(':')[1] : j.h + ':' + pad2_(j.mi);
  const timeLabel = j.mo + '/' + j.d + '(' + DOW_JA[j.dow] + ') ' + clock;
  const sinceLabel = sum ? '今日の動き' : st.hasPrev ? '前回のメール（' + fmtAt_(st.since) + '）以降の動き' : 'この1時間の動き';
  const subject = sum
    ? '【本部タスク】' + timeLabel + ' 今日のまとめ　完了' + st.completed.length + '件・期限切れ' + st.overdue.length + '件・明日まで' + st.tomorrowDue.length + '件'
    : '【本部タスク】' + timeLabel + '時点　期限切れ' + st.overdue.length + '件・今日まで' + st.todayDue.length + '件';
  const link = t => url ? url + '?task=' + encodeURIComponent(t.id) : '';

  /* ----- 文字だけのメール ----- */
  const lines = [];
  lines.push(sum ? '本部タスク 今日のまとめ（' + timeLabel + '）' : '本部タスクの状況（' + timeLabel + ' 時点）', '');
  lines.push('■ まとめ');
  lines.push('未完了 ' + st.openCount + '件（期限切れ ' + st.overdue.length + '件／今日まで ' + st.todayDue.length +
    '件／' + st.cfg.soonDays + '日以内 ' + st.soon.length + '件）');
  lines.push(sinceLabel + ': 新規 ' + st.created.length + '件・完了 ' + st.completed.length + '件・最新状況の更新 ' + st.noted.length + '件', '');
  const textBlock = (title, arr, withOver) => {
    lines.push('■ ' + title + '（' + arr.length + '件）');
    if (!arr.length) lines.push('なし');
    arr.forEach(t => {
      lines.push('・' + (withOver ? '[' + overDays(t) + '日超過] ' : '') + t.title + '　担当: ' + name(t.assignee) +
        '　期限: ' + dueText(t) + '　' + statusText(t));
      lines.push('　最新状況: ' + (t.noteText ? '（' + fmtAt_(t.noteAt) + '）' + t.noteText : 'まだ入力がありません'));
    });
    lines.push('');
  };
  textBlock('期限切れ', st.overdue, true);
  textBlock(sum ? '今日まで（残り）' : '今日まで', st.todayDue, false);
  if (sum) textBlock('明日まで', st.tomorrowDue, false);
  else textBlock(st.cfg.soonDays + '日以内', st.soon, false);
  lines.push('■ ' + sinceLabel);
  st.completed.forEach(t => lines.push('・完了: ' + t.title + '（' + name(t.completedBy || t.assignee) + '）'));
  st.created.forEach(t => lines.push('・新規: ' + t.title + '（担当: ' + name(t.assignee) + '、期限: ' + dueText(t) + '）'));
  st.noted.forEach(t => lines.push('・最新状況: ' + t.title + ' → ' + t.noteText));
  if (!st.completed.length && !st.created.length && !st.noted.length) lines.push('動きはありませんでした');
  lines.push('');
  lines.push('■ 担当者別（期限切れ／今日まで／' + st.cfg.soonDays + '日以内／進行中／未着手）');
  st.byAssignee.forEach(r => lines.push('・' + name(r.id) + '　' + r.overdue + '／' + r.today + '／' + r.soon + '／' + r.doing + '／' + r.todo));
  if (st.stale.length) {
    lines.push('');
    lines.push('■ ' + st.cfg.staleDays + '日以上更新が止まっているタスク（' + st.stale.length + '件）');
    st.stale.forEach(t => lines.push('・' + t.title + '　担当: ' + name(t.assignee) + '　期限: ' + dueText(t)));
  }
  if (url) lines.push('', '▶ アプリで開く: ' + url);

  /* ----- 見やすいメール（HTML） ----- */
  const C = { red: '#b3261e', orange: '#b25e00', blue: '#0b57d0', gray: '#5f6368', line: '#e0e3e7' };
  const h = [];
  h.push('<div style="font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',\'Yu Gothic UI\',Meiryo,sans-serif;color:#1f1f1f;max-width:680px;margin:0 auto;line-height:1.6">');
  h.push('<div style="padding:16px 20px;background:#0b57d0;color:#fff;border-radius:12px 12px 0 0">' +
    '<div style="font-size:13px;opacity:.85">本部タスク</div>' +
    '<div style="font-size:20px;font-weight:bold">' + esc_(sum ? '今日のまとめ（' + timeLabel + '）' : timeLabel + ' 時点の状況') + '</div></div>');
  h.push('<div style="border:1px solid ' + C.line + ';border-top:0;border-radius:0 0 12px 12px;padding:16px 20px">');
  const tile = (label, n, color) => '<td style="padding:4px"><div style="border:1px solid ' + C.line + ';border-radius:10px;padding:10px;text-align:center">' +
    '<div style="font-size:12px;color:' + C.gray + '">' + label + '</div><div style="font-size:24px;font-weight:bold;color:' + color + '">' + n + '</div></div></td>';
  h.push('<table role="presentation" style="width:100%;border-collapse:collapse"><tr>' +
    (sum ? tile('今日の完了', st.completed.length, '#146c2e') : tile('未完了', st.openCount, '#1f1f1f')) +
    tile('期限切れ', st.overdue.length, st.overdue.length ? C.red : '#1f1f1f') +
    tile(sum ? '今日まで（残り）' : '今日まで', st.todayDue.length, st.todayDue.length ? C.orange : '#1f1f1f') +
    (sum ? tile('明日まで', st.tomorrowDue.length, '#1f1f1f') : tile(st.cfg.soonDays + '日以内', st.soon.length, '#1f1f1f')) +
    '</tr></table>');
  h.push('<p style="margin:8px 0 0;font-size:13px;color:' + C.gray + '">' + esc_(sinceLabel) + ': 新規 ' + st.created.length +
    '件・完了 ' + st.completed.length + '件・最新状況の更新 ' + st.noted.length + '件</p>');

  const section = (title, color, arr, withOver) => {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + color + ';padding-left:8px">' + esc_(title) + '（' + arr.length + '件）</h3>');
    if (!arr.length) { h.push('<div style="color:' + C.gray + ';font-size:14px">なし</div>'); return; }
    arr.forEach(t => {
      const titleHtml = link(t) ? '<a href="' + esc_(link(t)) + '" style="color:#1f1f1f;font-weight:bold;text-decoration:none">' + esc_(t.title) + '</a>' : '<b>' + esc_(t.title) + '</b>';
      h.push('<div style="padding:8px 0;border-bottom:1px solid ' + C.line + '">' +
        (withOver ? '<span style="color:' + C.red + ';font-weight:bold;font-size:13px">[' + overDays(t) + '日超過] </span>' : '') + titleHtml +
        '<div style="font-size:13px;color:' + C.gray + '">担当: ' + esc_(name(t.assignee)) + '　期限: <span style="color:' + (withOver ? C.red : C.gray) + '">' +
        esc_(dueText(t)) + '</span>　' + statusText(t) + '</div>' +
        '<div style="font-size:13px;color:#444">最新状況: ' + (t.noteText ? esc_(t.noteText) + ' <span style="color:' + C.gray + '">（' + fmtAt_(t.noteAt) + '）</span>' : '<span style="color:' + C.gray + '">まだ入力がありません</span>') + '</div></div>');
    });
  };
  const moves = () => {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + (sum ? '#146c2e' : C.gray) + ';padding-left:8px">' + esc_(sinceLabel) + '</h3><div style="font-size:14px">');
    st.completed.forEach(t => h.push('<div>✅ 完了: ' + esc_(t.title) + '（' + esc_(name(t.completedBy || t.assignee)) + '）</div>'));
    st.created.forEach(t => h.push('<div>🆕 新規: ' + esc_(t.title) + '（担当: ' + esc_(name(t.assignee)) + '、期限: ' + esc_(dueText(t)) + '）</div>'));
    st.noted.forEach(t => h.push('<div>💬 ' + esc_(t.title) + ' → ' + esc_(t.noteText) + '</div>'));
    if (!st.completed.length && !st.created.length && !st.noted.length) h.push('<div style="color:' + C.gray + '">動きはありませんでした</div>');
    h.push('</div>');
  };
  if (sum) moves();
  section('期限切れ', C.red, st.overdue, true);
  section(sum ? '今日まで（残り）' : '今日まで', C.orange, st.todayDue, false);
  if (sum) section('明日まで', C.blue, st.tomorrowDue, false);
  else section(st.cfg.soonDays + '日以内', C.blue, st.soon, false);
  if (!sum) moves();

  h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + C.gray + ';padding-left:8px">担当者別</h3>');
  const th = s => '<th style="padding:6px 8px;border-bottom:2px solid ' + C.line + ';font-size:12px;color:' + C.gray + ';text-align:center">' + s + '</th>';
  const td = (n, color) => '<td style="padding:6px 8px;border-bottom:1px solid ' + C.line + ';text-align:center;' + (n && color ? 'color:' + color + ';font-weight:bold' : '') + '">' + n + '</td>';
  h.push('<table style="width:100%;border-collapse:collapse;font-size:14px"><tr>' + th('担当') + th('期限切れ') + th('今日まで') +
    th(st.cfg.soonDays + '日以内') + th('進行中') + th('未着手') + th('今週の完了') + '</tr>');
  st.byAssignee.forEach(r => {
    h.push('<tr><td style="padding:6px 8px;border-bottom:1px solid ' + C.line + '">' + esc_(name(r.id)) + '</td>' + td(r.overdue, C.red) + td(r.today, C.orange) +
      td(r.soon) + td(r.doing) + td(r.todo) + td(r.doneWeek) + '</tr>');
  });
  if (!st.byAssignee.length) h.push('<tr><td colspan="7" style="padding:8px;color:' + C.gray + '">タスクはありません</td></tr>');
  h.push('</table>');

  if (st.stale.length) {
    h.push('<h3 style="margin:20px 0 8px;font-size:16px;border-left:4px solid ' + C.gray + ';padding-left:8px">' + st.cfg.staleDays + '日以上更新が止まっているタスク（' + st.stale.length + '件）</h3><div style="font-size:14px">');
    st.stale.forEach(t => h.push('<div>・' + esc_(t.title) + '　<span style="color:' + C.gray + '">担当: ' + esc_(name(t.assignee)) + '　期限: ' + esc_(dueText(t)) + '</span></div>'));
    h.push('</div>');
  }
  if (url) {
    h.push('<p style="margin:24px 0 4px;text-align:center"><a href="' + esc_(url) + '" style="display:inline-block;background:#0b57d0;color:#fff;padding:10px 24px;border-radius:20px;text-decoration:none;font-weight:bold">アプリで開く</a></p>');
  }
  h.push('<p style="font-size:12px;color:' + C.gray + ';margin-top:16px">このメールは本部タスクから自動で送っています。タスク名や最新状況に、利用者さんの個人情報は書かないでください。</p>');
  h.push('</div></div>');

  return { subject: subject, text: lines.join('\n'), html: h.join('') };
}

/* ---------- 設定画面から呼ばれるもの ---------- */

function api_previewReport(p) {
  const r = buildReport_(new Date(), PropertiesService.getScriptProperties().getProperty('MAIL_AT'), { summary: !!(p && p.summary) });
  return { subject: r.subject, html: r.html };
}

function api_sendTestMail() {
  const cfg = getConfig_();
  if (!cfg.mail.recipients.length) throw new Error('送信先を入れて保存してから、テスト送信してください');
  const r = buildReport_(new Date(), PropertiesService.getScriptProperties().getProperty('MAIL_AT'));
  r.subject = '[テスト] ' + r.subject;
  sendReport_(cfg.mail.recipients, r);
  return api_mailStatus({});
}

function api_mailStatus() {
  const log = new Table('maillog').all().slice(-30).reverse();
  let quota = null;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = null; }
  let trigger = false;
  try { trigger = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'tick'); } catch (e) { trigger = false; }
  return {
    log: log,
    quota: quota,
    trigger: trigger,
    lastSentAt: PropertiesService.getScriptProperties().getProperty('MAIL_AT') || '',
  };
}

/* ---------- 夜中の片付け（ごみ箱で30日たったものを消す） ---------- */

function dailyCleanup_(now) {
  const j = jst_(now);
  if (j.h !== 3) return;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('CLEAN_DAY') === j.ymd) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const limit = new Date(now.getTime() - 30 * 86400000).toISOString();
    let purgeRev = Number(props.getProperty('PURGE_REV') || 0);
    ['tasks', 'lists'].forEach(key => {
      const t = new Table(key);
      const all = t.all();
      const keep = all.filter(o => !o.deletedAt || o.deletedAt >= limit);
      if (keep.length === all.length) return;
      all.filter(o => o.deletedAt && o.deletedAt < limit).forEach(o => { purgeRev = Math.max(purgeRev, o.rev); });
      t.rewrite(keep);
    });
    const log = new Table('maillog');
    if (log.rows.length > 2000) log.rewrite(log.all().slice(-1000));
    SpreadsheetApp.flush();
    props.setProperties({ PURGE_REV: String(purgeRev), CLEAN_DAY: j.ymd });
  } finally {
    lock.releaseLock();
  }
}
