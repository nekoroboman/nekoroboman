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
