# このリポジトリで作業するセッションへ

本部タスク（Google ToDo・カレンダーのような本部用アプリ）のリポジトリです。全体の説明は [README.md](README.md) にあります。

## 公開（標準のやり方）

- 画面（`web/`・`web-root/`）を変えて push したら、**エックスサーバーへの公開を、スキル [xserver-publish](.claude/skills/xserver-publish/SKILL.md) の手順で、ユーザーの PC にある公開用セッションへ直接頼む。** ユーザーに聞いたり、カードを押させたりしない
- 公開先: https://app.nekorobogroup.com/honbu-task/（管理画面は `admin.html`）。トップは `web-root/` の転送ページ

## データベース（Supabase の nekorobo.app は管理システムのホームと共有）

- migration の最後で、関数の実行権限を**スキーマ全体にまとめて外さない**（`revoke all on all functions in schema public ...` は使わない。ホームの関数まで止まる）。新しく作った・作り直した本部タスクの関数だけを、名指しで `revoke all on function public.xxx(jsonb) from public, anon, authenticated;` する
- 画面から呼ぶ入り口は今までどおり `api_call` だけ（`api_*` 関数を authenticated に直接 grant しない）
- 本番に migration を流す前に、ホームのセッション（「管理サイトホーム」）に知らせる。ホームの表・関数（organizations・profiles・account_invites・is_hq() など）は触らない

## 守ること

- 実在の人の名前・メールアドレスなどの個人情報を、コード・テストデータ・設計書・コミットに書かない（例は架空のものだけ）
- パスワード・鍵・トークンをリポジトリに入れない（このリポジトリは公開されている）
- ユーザーへの説明は日本語で、専門用語を避けて短く
