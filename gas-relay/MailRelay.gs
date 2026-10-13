/**
 * 本部タスク: メール送信用（共有 Gmail から、毎時のメールと今日のまとめを送る）
 *
 * 使い方（最初に1回だけ）
 * 1. https://script.google.com で「新しいプロジェクト」を作り、このファイルの中身を全部貼り付けて保存
 * 2. 下の RELAY_TOKEN に合言葉を入れる（貼り付け用のファイルには最初から入っています）
 * 3. 関数「setup」を選んで「実行」→ 許可する
 *
 * あとは1分ごとに本部タスクに「送る時刻ですか？」とたずね、送る時刻ならメールを送る。
 * 送る時刻・宛先・中身は、本部タスクの画面（設定 → メール通知）で決める。このファイルを直す必要はない。
 */

const MAIL_URL = 'https://kfgkagsfvstexunxelij.supabase.co/functions/v1/mail';
const RELAY_TOKEN = 'ここに合言葉';

function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'relayTick')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('relayTick').timeBased().everyMinutes(1).create();
  relayTick();
  console.log('準備ができました。1分ごとに確認し、送る時刻になったらメールを送ります。');
}

function relayTick() {
  const res = post_({ action: 'poll', quota: MailApp.getRemainingDailyQuota() });
  if (!res || !res.send) return;
  let ok = true;
  let error = '';
  try {
    MailApp.sendEmail({
      to: res.to.join(','),
      subject: res.subject,
      body: res.text,
      htmlBody: res.html,
      name: '本部タスク（自動送信）',
    });
  } catch (e) {
    ok = false;
    error = String((e && e.message) || e);
  }
  post_({ action: 'result', kind: res.kind, key: res.key, rev: res.rev, ok: ok, error: error, subject: res.subject, to: res.to });
}

function post_(body) {
  const r = UrlFetchApp.fetch(MAIL_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: { 'x-relay-token': RELAY_TOKEN },
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) {
    throw new Error('本部タスクにつながりません（' + r.getResponseCode() + '）: ' + r.getContentText().slice(0, 200));
  }
  return JSON.parse(r.getContentText());
}
