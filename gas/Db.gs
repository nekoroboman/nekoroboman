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
