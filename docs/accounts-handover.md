# アカウント・招待・会社（所属）— 共通基盤へ移すときのメモ

管理システムのホーム（共通基盤）から頼まれたメモです。本部タスク（W14）で作った「招待制のアカウント」と「会社ごとの所属」を、共通基盤のユーザー管理に移すときに使います。
データベースは Supabase の nekorobo.app（ホームと共有）です。実在の人のメールアドレスなどは、ここには書きません。

## 1. 表（public スキーマ）

| 表 | 役目 | 主な列 |
|---|---|---|
| `app_access` | ログインできるアカウントの名簿（招待制）。ここにないメールアドレスはアプリを使えない | `email`（主キー・小文字）・`member_id`（人のアカウントなら members.id。空なら共有のアカウント）・`is_admin`・`is_owner`（全権限）・`status`（invited／active／stopped／cancelled）・`company_id`（共有のアカウントの会社）・`activated_at` |
| `invitations` | 招待・パスワード再設定のリンク | `email`・`kind`（invite／reset）・`token_hash`（合言葉はハッシュだけ保存）・`pending_token`（メールを送るまでだけ持つ）・`expires_at`（招待7日・再設定24時間）・`used_at`・`revoked_at`・`mail_status`・`mail_at`・`mail_error` |
| `members` | 担当者として選べる人（アカウントがなくてもよい） | `id`・`name`・`email`・`active`・`color`（人ごとの色）・`company_id` |
| `companies` | 会社（所属）。今は「株式会社ネコロボマン」「セレクトエールグループ株式会社」 | `id`・`name`・`sort_order`・`deleted_at` |
| `company_admins` | 会社の管理者（その会社のタスクも見られる人） | `email`（app_access）・`company_id` |

すべての表で RLS（行ごとの読み書きの決まり）が有効です。`app_access`・`invitations`・`company_admins` は画面から直接読めません（関数だけ）。

## 2. 入り口と関数

- 画面からの呼び出しは、すべて `api_call(p_fn, p)` を通します。ログインしている人を確かめ、操作した人（actor）を正しく記録し、`api_admin_*` は管理者だけ・パスワードでログインしてから8時間以内だけに絞ります。
- ログインしている人: `_account()`（使用中のアカウント。なければエラー）・`_me_access()`（なければ空）・`has_access()`（RLS で使う）
- 管理者か: `_is_admin(a)`（全権限も含む）。全権限のアカウントへの操作は `_owner_guard()` で本人だけ
- 管理画面: `api_admin_accounts`（一覧）・`api_admin_invite`（招待。名前だけのメンバーにも招待できる）・`api_admin_reinvite`・`api_admin_reset`（パスワード再設定のリンク）・`api_admin_cancel`・`api_admin_update`（管理者にする／外す・停止／再開）
- 会社: `api_admin_save_company`（作る・名前を変える。新しい会社にはリスト「マイタスク」を作る）・`api_admin_set_company`（人・共有のアカウントの会社）・`api_admin_set_company_admin`（会社の管理者にする／外す）
- リンクの処理（Edge Function「account」だけが使う。service_role）: `_invite_lookup(token)`・`_invite_complete(token)`
- 招待した人以外はログインそのものを作れない: `auth.users` のトリガー `honbu_invite_only` → `_auth_user_guard()`（ホームの `is_invited_email()` も通すように、ホームの migration で作り直す予定）

## 3. 招待メールの送り方（今）

1. 管理画面で招待すると、`invitations` に行ができる（合言葉は `pending_token` に一時的に入る。画面にはリンクとして返す）
2. 送信用の Google Apps Script（GAS）が毎分、Edge Function「mail」に「送るものはある？」とたずねる（合言葉つき）。mail は `pending_token` から招待リンクを作って宛先・件名・本文を返し、送ったら `pending_token` を消す
3. 本人がリンクを開くと、アプリ（`#invite=...`）が Edge Function「account」を呼び、パスワードを決めて `auth.users` を作る（`auth.admin.createUser`）→ `app_access.status` が active になる
4. GAS が動いていないときは、管理画面に出るリンクをコピーして本人に届ける

ホームの決定（通知メールは共通の送信の仕組みから送る）に合わせて、移すときは手順 2 を共通の仕組みに置き換えます。Supabase 標準の招待メール・再設定メールは使っていません。

## 4. 会社（所属）の決まり（2026-10-19）

- 人・リスト・カレンダーは、どれかの会社に入る。タスクはリストの会社、予定はカレンダーの会社（トリガー `_company_fill` が自動で決める）
- 見える範囲: ふつうの人は自分の会社の分だけ。`company_admins` に入った人はその会社の分も。全権限は全部（`_my_companies()`）
  - 読み込み（`api_sync`・`_changes`・`api_task_detail`・ごみ箱）と、直接読むとき・リアルタイムの通知（RLS）の両方で絞る
  - 見える会社が変わると、画面は全部読み直す（`api_sync` の `scope`）
- 書き込み: ログインした人の操作は、見られる会社のデータだけ（トリガー `_company_guard`）。管理画面の操作と、自動の処理（ログインなし）は通す
- 担当者は、そのタスクと同じ会社の人だけ（`_company_assignee`）
- リストは会社ごとに最低1つ
- メールの報告（毎日の進み具合）は、会社に関係なく、管理者が決めた宛先に全部を送る（今のまま）

## 5. 共通基盤に寄せるとき

- `companies` → ホームの `organizations`、`company_admins` → ホームの権限（例: 会社ごとの管理者）に寄せる
- `app_access` → `profiles`＋`account_invites`。全権限（`is_owner`）は、ホームの「本部の全権限」に対応させる
- 本部のログインは「会社のメールアドレス＋パスワード＋認証アプリ（必須）」に変わる予定（ホームの決定）。招待のリンクでパスワードを決めたあと、認証アプリの登録に進む流れにする
- 本部タスクの migration は、関数の権限を名指しで外す（スキーマ全体にはかけない）。ホームの表・関数には触らない
