# W14 本部タスク — セッションの引き継ぎ（2026-11-05）

前のセッション「【nekoroboapp】W14 本部タスク（ネコロボマン従業員タスクリスト）」から、ホーム（「管理側 画面 機能設計」）のサブセッションへ引き継ぐためのメモです。
**新しいセッションは、まずこのメモ・[CLAUDE.md](../CLAUDE.md)・[README.md](../README.md) を読んで、ユーザーの指示を待ってください（自分から作業を始めない）。**

## 1. どこで・何を

| もの | 場所 |
|---|---|
| リポジトリ・ブランチ | `nekoroboman/nekoroboman` の `claude/sharp-rubin-aspw3s`（ここで作業して push。PR は頼まれたときだけ） |
| 画面（公開中） | https://app.nekorobogroup.com/honbu-task/ （管理画面は `admin.html`）。今の版: `app.js?v=12`・`calendar.js?v=5`・`styles.css?v=10`・`admin.js?v=6` |
| データベース | Supabase「nekorobo.app」（ホームと共有）。migration は `supabase/migrations/` の `20261031000100_hq_admin_sync.sql` まで本番に反映済み |
| Edge Functions | `mail`（メールの中身）・`google`（Google 連携）・`account`（招待のリンク）。`mail`・`google` は 2026-10-30 に版2を反映済み |
| 公開のしかた | スキル [xserver-publish](../.claude/skills/xserver-publish/SKILL.md)。PC の公開用セッション「本部タスク画面をエックスサーバーで公開」に直接頼む。公開URLで確かめるまで「公開した」と言わない |
| テスト | `node dev/db-test.js`（41件）・`node dev/google-test.js`（9件）・画面は `node dev/web-server.js 8095` を立てて `WEB=1 BASE=http://localhost:8095/ node dev/e2e.js` |

## 2. 守ること（CLAUDE.md より）

- 共有のデータベース: 関数の権限は名指しで外す（スキーマ全体の revoke はしない）。画面の入り口は `api_call` だけ。本番に migration を流す前にホームへ知らせ、できたら返事をする。ホームの表・関数には書き込まない（`profiles`・`organizations` は読むだけ）
- 実在の人の名前・メールアドレスなどの個人情報を、コード・テストデータ・設計書・コミットに書かない。パスワード・鍵・トークンもリポジトリに入れない（公開リポジトリ）
- ユーザーへの説明は日本語で、専門用語を避けて短く。本番への反映は、ユーザーの OK をもらってから

## 3. 最近できたもの（すべて本番に反映済み）

| いつ | もの |
|---|---|
| 10/19 | 優先度（低・中・高、必須）・人ごとの色・完了は2回押しとスタンプ・リストの並べ替え・詳細の改行・会社（所属）と会社の切り替え |
| 10/22 | Google 連携の公開に使うプライバシーポリシー（`web/privacy.html`） |
| 10/30 | 共有タスク（担当者を2人以上。`tasks.assignees`・`tasks.unacked`、誰か1人が完了で完了）・右の「今日のタスク」サイドバー（PC） |
| 10/31 | 本部の人を管理システムのアカウント管理に一本化（`task_sync_hq_member`・`companies.organization_id`・`members.profile_id`）。本部タスクの管理者は管理システムの「アカウント管理ができる」にそろえる。全権限は本部タスクで持つ。詳しくは [accounts-handover.md](accounts-handover.md) 6章 |

## 4. 残っていること・気になること

- **Google 連携**: Google Cloud の OAuth 同意画面を「本番環境に公開」にしたかは未確認（ユーザーがブランディングを入力中だった）。公開していないと、テストユーザー以外はつなげない
- **毎日のメール**: 送信用の GAS が Edge Function `mail` をたずねてきていない（2026-10-30 時点で `relay_seen_at` が空）。メールの報告は届いていない見込み。README の「メール通知」の手順でつなぎ直す必要がある
- **W19 本部業務のダッシュボード**: 別のセッションで設計メモ（nekoroboapp の `docs/modules/W19-hq-workflow.md`）まで。本部タスクの右の「今日のタスク」は、その「遅れ・今日まで」に近い。W19 から W14 への依頼が来たら、ここで受ける
- 本部タスクを nekoroboapp の本部用アプリへ移す話（[w14-handoff.md](w14-handoff.md)）は、ホームが決める
