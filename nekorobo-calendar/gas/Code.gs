/**
 * ネコロボ 年間スケジュール API（Google Apps Script）
 *
 * 2つのスプレッドシートを読み、サイト版・PDF版が使う JSON を返す。
 *   ・ウェルビーラーニング研修計画 … 全シートを見て「研修項目①」「研修項目②」の見出しがある表を年度ごとに読む
 *                                   （年度を追加するときはシートを足すだけでよい）
 *   ・委員会議事録キット          … 「委員会マスタ」シート（年度・委員会名・開催予定月）
 *
 * 設定：プロジェクトの設定 → スクリプト プロパティ に登録する
 *   WELLBE_SPREADSHEET_ID     ウェルビー研修計画のスプレッドシートID
 *   COMMITTEE_SPREADSHEET_ID  委員会議事録キットのスプレッドシートID
 * デプロイ：デプロイ → 新しいデプロイ → 種類「ウェブアプリ」、次のユーザーとして実行「自分」、アクセス「全員」
 *   発行された URL（…/exec）を nekorobo-calendar/config.js の apiUrl に貼る
 * 確認：URL の末尾に ?debug=1 を付けて開くと、どのシートをどう読んだかが log に出る
 */

var COMMITTEE_SHEET_NAME = '委員会マスタ';
var CACHE_KEY = 'calendar-v1';
var CACHE_SECONDS = 300; // スプレッドシートを直してからサイトに出るまで最大5分

function doGet(e) {
  var debug = e && e.parameter && e.parameter.debug === '1';
  var cache = CacheService.getScriptCache();
  if (!debug) {
    var hit = cache.get(CACHE_KEY);
    if (hit) return json_(hit);
  }

  var props = PropertiesService.getScriptProperties();
  var log = [];
  var errors = 0;
  var result = { generatedAt: new Date().toISOString(), wellbe: [], committees: [] };
  try {
    result.wellbe = readWellbe_(props.getProperty('WELLBE_SPREADSHEET_ID'), log);
  } catch (err) {
    errors++;
    log.push('ウェルビー研修計画: ' + err.message);
  }
  try {
    result.committees = readCommittees_(props.getProperty('COMMITTEE_SPREADSHEET_ID'), log);
  } catch (err) {
    errors++;
    log.push('委員会: ' + err.message);
  }

  if (debug) {
    result.log = log;
    return json_(JSON.stringify(result, null, 2));
  }
  var body = JSON.stringify(result);
  if (!errors) cache.put(CACHE_KEY, body, CACHE_SECONDS); // 失敗した結果はキャッシュしない
  return json_(body);
}

/** スプレッドシートを直したあと、すぐサイトに出したいときにエディタから実行する */
function clearCache() {
  CacheService.getScriptCache().remove(CACHE_KEY);
}

function json_(body) {
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

// ---------- ウェルビーラーニング研修計画 ----------

function readWellbe_(id, log) {
  if (!id) throw new Error('スクリプト プロパティ WELLBE_SPREADSHEET_ID が未設定です');
  var byYear = {};
  SpreadsheetApp.openById(id).getSheets().forEach(function (sheet) {
    var blocks = parseWellbeSheet_(sheet.getName(), sheet.getDataRange().getDisplayValues());
    log.push(sheet.getName() + ': ' + (blocks.length
      ? blocks.map(function (b) { return b.fiscalYear + '年度 ' + b.months.length + 'か月分'; }).join('、')
      : '研修項目①・②の見出しがないため対象外'));
    // 同じ年度が複数シートにあるときは、後ろのシートを優先する
    blocks.forEach(function (b) { byYear[b.fiscalYear] = b; });
  });
  return Object.keys(byYear).sort().map(function (k) { return byYear[k]; });
}

/**
 * 1シート分の表を年度ごとのブロックに分けて読む。
 * 見出し行（研修項目①・研修項目②を含む行）から次の見出し行までを1年度とし、
 * 年度は見出し行 → その上3行 → シート名 の順に「令和8年度」「2026年度」「R8」などを探す。
 */
function parseWellbeSheet_(sheetName, rows) {
  var blocks = [];
  var current = null;
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var cols = headerColumns_(row);
    if (cols) {
      var fy = fiscalYearIn_(row) || fiscalYearIn_([].concat.apply([], rows.slice(Math.max(0, r - 3), r))) || fiscalYearIn_([sheetName]);
      current = fy ? { fiscalYear: fy, cols: cols, months: [] } : null;
      if (current) blocks.push(current);
      continue;
    }
    if (!current) continue;
    var month = monthOf_(row[current.cols.month]);
    if (!month) continue;
    var items = [
      item_(row, current.cols.theme1, current.cols.video1),
      item_(row, current.cols.theme2, current.cols.video2),
    ];
    if (items[0] || items[1]) current.months.push({ month: month, items: items });
  }
  return blocks
    .filter(function (b) { return b.months.length; })
    .map(function (b) { return { fiscalYear: b.fiscalYear, months: b.months }; });
}

function headerColumns_(row) {
  var find = function (re) {
    for (var i = 0; i < row.length; i++) if (re.test(norm_(row[i]))) return i;
    return -1;
  };
  // NFKC で ① は 1 になるので、どちらの書き方でも拾える
  var theme1 = find(/研修項目\s*1/);
  var theme2 = find(/研修項目\s*2/);
  if (theme1 < 0 || theme2 < 0) return null;
  var month = find(/^月/);
  return {
    month: month >= 0 ? month : Math.max(0, theme1 - 1),
    theme1: theme1,
    theme2: theme2,
    video1: find(/視聴内容\s*1/),
    video2: find(/視聴内容\s*2/),
  };
}

function item_(row, themeCol, videoCol) {
  var theme = themeCol >= 0 ? String(row[themeCol] || '').trim() : '';
  var video = videoCol >= 0 ? String(row[videoCol] || '').trim() : '';
  return theme || video ? { theme: theme, video: video } : null;
}

// ---------- 委員会 ----------

function readCommittees_(id, log) {
  if (!id) throw new Error('スクリプト プロパティ COMMITTEE_SPREADSHEET_ID が未設定です');
  var sheet = SpreadsheetApp.openById(id).getSheetByName(COMMITTEE_SHEET_NAME);
  if (!sheet) throw new Error('「' + COMMITTEE_SHEET_NAME + '」シートが見つかりません');
  var list = parseCommitteeRows_(sheet.getDataRange().getDisplayValues());
  log.push(COMMITTEE_SHEET_NAME + ': ' + list.length + '件');
  return list;
}

/** 見出し行（「年度」と「委員会」を含む行）から下を、年度・委員会名・開催月として読む */
function parseCommitteeRows_(rows) {
  var hi = -1;
  for (var r = 0; r < rows.length && hi < 0; r++) {
    var cells = rows[r].map(norm_);
    if (cells.some(function (c) { return /年度/.test(c); }) && cells.some(function (c) { return /委員会/.test(c); })) hi = r;
  }
  if (hi < 0) return [];
  var head = rows[hi].map(norm_);
  var idx = function (re) {
    for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i;
    return -1;
  };
  var iYear = idx(/年度/);
  var iName = idx(/委員会/);
  var iMonth = idx(/月/);
  if (iMonth < 0) return [];
  var list = [];
  rows.slice(hi + 1).forEach(function (row) {
    var fy = fiscalYearIn_([row[iYear]]) || Number((norm_(row[iYear]).match(/20\d{2}/) || [])[0]);
    var month = monthOf_(row[iMonth]);
    var name = String(row[iName] || '').trim();
    if (fy && month && name) list.push({ fiscalYear: fy, month: month, name: name });
  });
  return list;
}

// ---------- 共通 ----------

function norm_(s) {
  return String(s == null ? '' : s).normalize('NFKC').trim();
}

/** 「4月」「4」「2026/04/01」などから月を取り出す */
function monthOf_(s) {
  var t = norm_(s);
  var m = t.match(/^(\d{1,2})\s*月/) || t.match(/^(\d{1,2})$/) || t.match(/^\d{4}[\/.\-](\d{1,2})/);
  var n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 12 ? n : 0;
}

/** セルの中から年度（西暦）を探す。「令和8年度」「R8」→ 2026、「2026年度」→ 2026 */
function fiscalYearIn_(cells) {
  for (var i = 0; i < cells.length; i++) {
    var t = norm_(cells[i]);
    var m = t.match(/令和\s*(\d{1,2})\s*年/) || t.match(/^R\s*(\d{1,2})(?:\s*年度)?$/i);
    if (m) return 2018 + Number(m[1]);
    m = t.match(/(20\d{2})\s*年度/);
    if (m) return Number(m[1]);
  }
  return 0;
}
