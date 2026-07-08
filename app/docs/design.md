# 詳細設計: ワンタップ実データ診断 MVP

本書は [one-pager.md](../one-pager.md)（事業ブリーフ）を入力とした **MVP の詳細設計**。実装に着手できる技術仕様へ落とす。

事業側の背景・制度的裏付け・ユニットエコノミクスは one-pager を正とし、本書は繰り返さない。本書が決めるのは「何を・どう作るか」であり、各判断の前提は [壁打ちで確定した設計前提](#付録-a-確定した設計前提grilling-の結論) に集約する。

---

## 1. スコープ

MVP のゴールは **「デモ画面がそのまま事業提案の説得材料になる」フルスタックの動く体験**（one-pager の MVP スコープ）。制度・API・料金は実在するため、実データ形状を忠実に模した mock の上で体験フローを完成させる。

### 1.1 MVP で作るもの（in scope）

- **体験フロー全画面**: 電話番号入力 → SMS 認証 → データ提供同意 → 診断結果 → 申込プレフィル（所要 1 分程度）
- **診断エンジン**: 30 分値 × 市場価格の料金計算と、現行契約との料金差・市場連動プラン過去 12 ヶ月バックテスト（高騰月を隠さない月次グラフ）
- **外部連携の mock**: 協会 power-data / SMS / JEPX の 3 連携を、実 API の形状を模した独立 mock service として実装
- **AWS 構成の IaC**: target 構成（ECS Fargate / ALB / S3 / CloudFront）を CDK コードで表現（実 deploy は任意）

### 1.2 設計だけして MVP では作らないもの（design only）

- 協会への実加入・実 API 接続（本番フェーズ）。本書では adapter interface と本番差し替え方針だけ定義する
- 旧型計器・定額電灯向けの **CSV / スクショアップロード fallback**（対象外判定と導線だけ設計、実装しない）
- 同意ログ・診断結果の DB 永続化（本番の target 構成としてのみ記述。MVP はステートレス）

### 1.3 非目標（out of scope）

課金・請求、実際の契約締結、CRM 連携、多言語化、ネイティブアプリ。

---

## 2. システム全体構成

MVP は 3 つの deployable（web / api / mock）と 1 つの共有ライブラリ（core）、および IaC（infra）で構成する。**mock は本番には出さない**（本番は api の adapter が実 API を叩く）。

```
                 ┌──────────── CloudFront (単一ドメイン) ────────────┐
   ブラウザ ──▶  │  default behavior ──▶ S3 (web: 静的 SPA)          │
                 │  /api/* behavior   ──▶ ALB ──▶ ECS Fargate (api)  │
                 └───────────────────────────────────────────────────┘
                                                    │ adapter (HTTP)
                              MVP/demo のみ          ▼
                                          ┌───────────────────────┐
                                          │ ECS Fargate (mock)     │
                                          │  協会 / SMS / JEPX 模倣 │
                                          └───────────────────────┘

   本番 (target): api の adapter の base URL を実 API に差し替え、mock service は消える
                  協会 power-data API / SMS gateway / JEPX 価格ソース へ直接接続
```

- **単一ドメイン**: web と api を CloudFront の 1 ドメインに集約し、`/api/*` だけ ALB へルーティング。CORS 不要、Cookie/認可も同一オリジンで完結。SPA の deep link は CloudFront の 403/404 → `index.html` フォールバックで解決
- **api ↔ mock は HTTP**: api の外部連携 adapter は「HTTP で外部 API を叩く」実装を MVP から持ち、mock service を叩く。本番は **同一 port に対する provider 別 adapter を DI で差し替える**（diagnosis flow のコードは不変）。これが「デモがそのまま本番に地続き」の技術的裏付け。ただし本番 adapter は base URL だけの差し替えでは済まない（認証方式・同意/申込 ID・非同期性・エラー形・レート制限・冪等/リトライが provider 毎に異なる）ため、port はこれらを吸収できる契約にする（[§5](#5-外部連携アダプタ境界)）

---

## 3. monorepo 構成

`app/` を product repo の root 相当とし、pnpm workspaces で管理する。

```
app/
├─ package.json            # workspace root（pnpm-workspace.yaml で apps/* packages/* infra を宣言）
├─ pnpm-workspace.yaml
├─ tsconfig.base.json      # 全 workspace 共通の strict TS 設定を継承元に
├─ apps/
│  ├─ web/                 # React + Vite SPA（S3+CloudFront に静的 deploy）
│  ├─ api/                 # Hono の API サーバ（ECS Fargate）。診断オーケストレーション + adapter 実装
│  └─ mock/                # Hono の mock サーバ（協会/SMS/JEPX を模倣。dev/demo のみ）
├─ packages/
│  └─ core/                # 純 TS。domain 型・Zod schema・診断エンジン（純関数）・adapter interface
├─ infra/                  # AWS CDK app（独立 workspace）
└─ docs/
   └─ design.md            # 本書
```

### 3.1 各 workspace の責務

| workspace | 責務 | 依存 |
|---|---|---|
| `apps/web` | 画面・体験フロー。api を `/api/*` で叩く。診断ロジックは持たない | `core`（型・Zod のみ） |
| `apps/api` | HTTP 入口、JWT 発行/検証、診断オーケストレーション、外部連携 adapter の実装 | `core` |
| `apps/mock` | 協会/SMS/JEPX の実 API 形状を模す。決定的サンプルデータを返す | `core`（型・Zod のみ） |
| `packages/core` | 純粋ドメイン: 型・Zod schema・**診断エンジン（純関数）**・adapter **interface** | なし（framework 非依存） |
| `infra` | CDK stack 定義（後述） | なし |

**依存の向きは常に `core` へ向かう**（web/api/mock → core）。core は他 workspace・framework・I/O に依存しない（純粋を保ちテスト容易性を担保）。

---

## 4. 型共有の方針

**single source of truth を `packages/core` に置く**。api の I/O 契約・domain モデル・外部連携のデータ形状を、core の TypeScript 型 + [Zod](https://zod.dev) schema として一度だけ定義し、web / api / mock が import する。

- **型と実行時検証を 1 箇所で**: Zod schema から `z.infer` で TS 型を導出。api は境界（リクエスト body・外部 API レスポンス）で `schema.parse()` し、web は fetch レスポンスを、mock は自身の出力を同じ schema で検証する。**型定義と runtime 検証が乖離しない**
- **OpenAPI コード生成を採らない理由**: MVP は TS 単一言語なので、schema を直接 import する方が生成ステップ・生成物レビューのコストがなく速い。将来 api を別言語化する / 外部公開 API を出す段になったら Zod → OpenAPI 変換（`zod-openapi` 等）で導出できる（本書ではやらない）
- **配置**: `core/src/schema/`（Zod）・`core/src/domain/`（型・値オブジェクト）・`core/src/diagnosis/`（診断エンジン）・`core/src/ports/`（adapter interface）

```ts
// packages/core/src/schema/diagnosis.ts（抜粋・イメージ）
export const HalfHourlyReading = z.object({
  timestamp: z.string().datetime(),   // 30分値の時刻（区間開始）
  kwh: z.number().nonnegative(),
});
export const DiagnosisResult = z.object({
  currentPlanMonthly: z.array(MonthlyCost),        // 現行契約の月次
  marketPlanMonthly: z.array(MonthlyCost),         // 市場連動の月次（バックテスト）
  totalDelta: z.number(),                          // 12ヶ月合計の差額（正=市場連動が安い）
  coveredMonths: z.number().int().positive(),      // 実際に診断できた月数（短期間対応）
});
export type DiagnosisResult = z.infer<typeof DiagnosisResult>;
```

---

## 5. 外部連携アダプタ境界

3 つの外部連携を **core の interface（port）** として抽象化し、実装（adapter）を api 側に置く。MVP は全て mock service を叩く HTTP adapter、本番は同一 interface の実 adapter に差し替える。

```
   apps/api                          packages/core (ports)          adapter 実装先
   ┌───────────────┐                 ┌──────────────────┐
   │ diagnosis flow │ ── 依存 ──▶     │ PowerDataPort     │  MVP: HTTP → mock /power-data/*
   │                │                 │ SmsPort           │  MVP: HTTP → mock /sms/*
   │                │                 │ MarketPricePort   │  MVP: HTTP → mock /jepx/*
   └───────────────┘                 └──────────────────┘  本番: 実 API を叩く adapter に差し替え
```

### 5.1 port 定義（core）

| port | 責務 | 主なメソッド（イメージ） |
|---|---|---|
| `PowerDataPort` | 協会 power-data 相当。30 分値・契約マスタ取得 | `fetchReadings(consentToken, range)` / `fetchContract(consentToken)` |
| `SmsPort` | SMS 認証。OTP 送信・検証 | `sendOtp(phone) → { requestId }` / `verifyOtp(requestId, code)` |
| `MarketPricePort` | JEPX スポット価格。過去価格取得 | `fetchSpotPrices(range)` |

`SmsPort` は `requestId` を返し、**試行回数・有効期限・送信頻度/レート制限**（電話番号・IP 単位）を契約に含める。MVP は mock が固定 OTP で常に検証成功（デモ用）だが、この制御責務は本番で SMS provider または api 側の小さな counter store（後述の target 状態）に委譲する前提を明記する（[§10](#10-セキュリティ--プライバシー)。ステートレス方針は診断本体に閉じ、認証のレート制御は例外）。

### 5.2 adapter 実装（api）

- **MVP adapter**: `MOCK_BASE_URL`（env）を base に mock service を HTTP で叩く。レスポンスは core の Zod schema で `parse`
- **本番 adapter（design only）**: 協会 API は会員認証・data provision の作法に従う実装、SMS は実 gateway（例: Amazon SNS / 外部 SMS provider）、JEPX は公開価格ソースの取得実装。**切り替えは DI（環境で adapter 実装を注入）で行い、diagnosis flow のコードは触らない**
- **port が吸収すべき provider 差分**: 各 provider は認証（会員鍵 / OAuth / API key）、**同意/申込 ID の受け渡し**、同期/非同期（協会は取得が非同期になり得る）、エラー分類、レート制限、冪等キー・リトライが異なる。port の signature はこれらを引数/戻り値に含められる形にし（例: `fetchReadings(consent: ConsentRef, range)`、`ConsentRef` は MVP では JWT 内の参照、本番では協会申込 ID）、adapter 差し替えで吸収する。「URL 差し替えのみ」ではないことを前提に設計する

### 5.3 mock service（apps/mock）の設計

実 API の**形状（エンドポイント・レスポンス構造・エラー形）を忠実に模す**ことで、本番差し替え時の乖離を最小化する。

- `POST /sms/send` `{ phone }` → `{ requestId }`（常に成功）
- `POST /sms/verify` `{ phone, code }` → 固定 OTP（例 `123456`）のみ成功、他は 4xx（レート・失敗の分岐をデモできる）
- `GET /power-data/contract` → 契約マスタ（契約電力・契約名義・現行プラン種別）のサンプル
- `GET /power-data/readings?from=&to=` → 30 分値のサンプル（**決定的生成**: 季節・平日/休日・時間帯の負荷カーブを持つ現実的な波形）
- `GET /jepx/spot?from=&to=` → JEPX スポット価格のサンプル（**高騰月を必ず含む**: バックテストの説得力の肝）。過去実相場を模したシード済み系列

サンプルデータは決定的（seed 固定）で、デモの再現性を担保する。短期間ケース（スイッチング直後 = 12 ヶ月未満）用のプロファイルも用意し、`coveredMonths < 12` の UI を見せられるようにする。

---

## 6. 体験フローとシーケンス

ステートレスを貫くため、**SMS 検証成功時に api が署名付き短命 JWT を発行**し、以降のステップはこの JWT を `Authorization: Bearer` で持ち回る。サーバ側セッションストアは持たない。

```
web            api                         mock (協会/SMS/JEPX)
 │  電話番号入力                            │
 │─ POST /api/auth/sms/send ──▶ SmsPort ──▶ POST /sms/send
 │◀─ 200 ─────────────────────────────────│
 │  OTP 入力                                │
 │─ POST /api/auth/sms/verify ─▶ SmsPort ─▶ POST /sms/verify
 │◀─ 200 { token: JWT(verified) } ────────│   ← 電話hash・検証済 を claim 化
 │  同意画面（提供先/目的/期間を表示）       │
 │─ POST /api/consent (Bearer) ───────────│   ← 検証済 JWT を要求
 │◀─ 200 { token: JWT(verified+consent) }─│   ← 同意 scope を claim に追加し再発行
 │─ GET /api/diagnosis (Bearer) ──────────│
 │        api: PowerDataPort で契約+30分値取得 ─▶ /power-data/*
 │        api: MarketPricePort で JEPX価格取得 ─▶ /jepx/*
 │        api: core.diagnose(...) 純関数で算出   │
 │◀─ 200 { DiagnosisResult, contract } ───│
 │  診断結果表示（料金差 + 12ヶ月月次グラフ）│
 │─ 申込フォームへ遷移（contract をプレフィル）│
```

### 6.1 JWT 設計

- **claims**: `sub`=電話番号の **peppered pseudonymous ID**（生番号もソルト無し hash も入れない。下記）、`verified`=true、`consent`=付与済み scope（例 `["diagnosis"]`）＋ `consentRef`（同意の参照。本番は協会申込 ID、MVP は同意記録の相関 ID）、`iss`/`aud`（本 api 固有）、`iat`/`exp`（発行から 15 分）、`jti`（一意 ID）
- **`sub` の作り方**: 電話番号は探索空間が小さく素の SHA では辞書攻撃で復元されるため、**pepper 付き HMAC-SHA256**（pepper は Secrets Manager 管理）で pseudonymous 化する。分析・ログ用 ID と外部連携用 ID は分離する
- **署名鍵 / pepper**: MVP は env（`JWT_SECRET`）、本番は Secrets Manager から注入
- **段階的 claim**: SMS 検証で `verified` のみ、同意で `consent`＋`consentRef` を足して再発行。診断 API は `verified && consent.includes("diagnosis")` を要求。検証時は `iss`/`aud`/`exp` を必須チェック
- **リプレイ対策のトレードオフ**: 完全ステートレスでは `jti` の失効管理ができないため、**短 TTL（15 分）＋ TLS ＋ Bearer をログ/URL に出さない**で軽減する（許容リスクとして明記）。同意 JWT の一回性・盗難時の即時失効が要件化した段階で `jti` denylist 用の小さな state（ElastiCache/DynamoDB TTL）を導入する（本 MVP では持たない）
- 生の電話番号・契約名義などの PII は JWT に載せず、必要時に mock/協会から都度取得する

---

## 7. 診断エンジン（core）

診断は **core の純関数** `diagnose(input): DiagnosisResult`。I/O を持たず、30 分値・JEPX 価格・料金設定を入力に、月次コスト系列と差額を返す。純粋ゆえ unit テストの主対象。

### 7.1 料金モデル（2 プラン比較の現実的簡易モデル）

| プラン | 計算 |
|---|---|
| **現行契約**（従量電灯 B 相当） | 基本料金（契約アンペアに比例）＋ 3 段階従量単価（〜120 / 〜300 / 300kWh〜）×月間使用量 |
| **市場連動** | Σ<sub>30分区間</sub>( 区間 kWh × JEPX スポット単価[該当コマ] ) ＋ 小売マージン（従量 ¥/kWh）＋ 基本料金 |

- 30 分値と JEPX の 30 分コマを突き合わせて市場連動の従量を積み上げ、月次に集計 → 12 ヶ月（または `coveredMonths` ヶ月）並べてバックテスト
- **料金定数（基本料金・段階単価・マージン）は core に定数として集約**し、根拠（想定プラン・出典）をコード near のコメントと本書に明記。MVP はサンプル値で、実プランに差し替え可能な形にする
- **高騰月を隠さない**: 市場連動が現行より高くなる月も月次でそのまま提示（one-pager の「高騰月も隠さず」= 心理障壁を定量で潰す設計意図）
- **短期間対応**: 入力の 30 分値が 12 ヶ月に満たない場合は `coveredMonths` を実データ月数にし、「利用可能 N ヶ月分で診断」を返す（UI で明示）

### 7.2 エッジ / 対象外

- データ欠損コマは当該コマを除外し月次から按分（欠測フラグを結果に含める余地を残す）
- 旧型計器・定額電灯は **対象外判定**（本 MVP は判定と「CSV fallback へ」の導線設計のみ、実装しない）

---

## 8. API 設計（apps/api）

全て CloudFront 経由で `/api/*`。JSON。境界で Zod `parse`。

| method | path | 認可 | 概要 |
|---|---|---|---|
| POST | `/api/auth/sms/send` | なし | OTP 送信（SmsPort） |
| POST | `/api/auth/sms/verify` | なし | OTP 検証 → `verified` JWT 発行 |
| POST | `/api/consent` | `verified` JWT | 同意記録（MVP は非永続）→ `consent` 付き JWT 再発行 |
| GET | `/api/diagnosis` | `verified`+`consent` JWT | 契約+30分値+JEPX を取得し `diagnose` 実行 |
| GET | `/api/contract` | `verified`+`consent` JWT | 申込プレフィル用の契約マスタ |
| GET | `/api/healthz` | なし | ヘルスチェック（ALB target group 用） |

- **エラー形**: `{ error: { code, message } }` に統一（Zod 検証失敗は 400、認可失敗は 401/403、mock/上流失敗は 502）
- **ロギング**: 構造化 JSON（後続の運用保守フェーズで扱う。PII・OTP・生電話番号はログに出さない方針を本 MVP から徹底）

---

## 9. AWS 構成（infra）

CDK（TypeScript）で下記 stack を定義する。**実 deploy は任意**（コードとして target 構成を表現するのが MVP の狙い）。

```
┌─ NetworkStack ── VPC / subnets / SG（ALB↔ECS↔（demo時のみ mock））
├─ EdgeStack ──── S3 (web bucket, OAC) + CloudFront
│                   ├ default behavior → S3
│                   └ /api/* behavior  → ALB (origin)
├─ ApiStack ───── ALB + ECS Fargate service (api) + task def + autoscaling
│                   └ (demo 時のみ) ECS Fargate service (mock) を同 cluster に追加
└─ (target) DataStack ── 同意証跡ストア（追記専用 DynamoDB / S3 Object Lock、§10.1）+ OTP/jti 用 counter・denylist（design only、MVP では作らない）
```

- **web**: Vite build 成果物を S3 に配置、CloudFront + OAC で配信。SPA fallback は CloudFront function / custom error response で `index.html`
- **api**: ECS Fargate。ALB target group はヘルスチェックに `/api/healthz`。`JWT_SECRET` 等は Secrets Manager → task 環境変数注入
- **CloudFront の `/api/*` behavior**: **キャッシュ無効化**（`CachingDisabled`）、**`Authorization` ヘッダと必要 header を origin へ転送**、`GET/POST/OPTIONS` 等 API に必要な method を許可。ALB origin は CloudFront からのみ受ける（origin custom header の検証 / prefix list 等で ALB を直接叩かせない）
- **WAF / レート制限**: CloudFront に WAF を付け、**特に OTP エンドポイント（`/api/auth/sms/*`）はレート制限対象**にする（[§10](#10-セキュリティ--プライバシー) の OTP 濫用対策の入口）
- **mock**: **dev/demo でのみ** 起動。ローカルは pnpm で並走、AWS demo に出す場合のみ同 cluster に別 Fargate service として追加し、api の `MOCK_BASE_URL` を service discovery / internal ALB で指す。**本番構成には含めず、外部公開もしない**（demo でも internal only）
- **環境差**: `MOCK_BASE_URL` が設定されていれば mock adapter、実 API 資格情報が設定されていれば実 adapter を DI で選択（本番は後者）

---

## 10. セキュリティ / プライバシー

- **PII 最小化**: JWT に生電話番号・氏名を載せない。電話は **pepper 付き HMAC**（[§6.1](#61-jwt-設計)）で pseudonymous 化し、素の hash は使わない。診断に必要な契約情報は都度取得し、サーバに永続化しない（MVP）
- **同意の明示と証跡**: 同意画面で提供先・利用目的・期間を提示してから `consent` claim を付与。診断 API は consent scope を強制。**同意の証跡は下記データモデルで残す**（MVP は非永続だが本番の必須設計）
- **OTP 濫用対策**: `SmsPort` の `requestId`＋試行回数・有効期限・レート制限（電話/IP 単位）で総当たり・SMS 爆撃を防ぐ。入口は CloudFront WAF（[§9](#9-aws-構成infra)）、細粒度は SMS provider / api 側 counter store
- **秘密情報**: JWT 署名鍵・HMAC pepper・（本番の）外部 API 資格情報は Secrets Manager。リポジトリ・ログに出さない
- **ログ衛生**: OTP・生電話番号・`Authorization`/Bearer トークンをログに出さない（運用保守フェーズのログ設計の前提）
- **転送**: CloudFront/ALB とも TLS。単一オリジンで Cookie を使わない（Bearer）ため CSRF 面が小さい

### 10.1 同意記録のデータモデル（target・design only）

同意の完全性・監査性のため、本番は同意 1 件を改ざん耐性のある形で記録する（MVP は作らないが、`consentRef` はここへの参照）。最低限のフィールド:

| フィールド | 内容 |
|---|---|
| `consentId` | 一意 ID（JWT の `consentRef` が指す） |
| `subjectId` | pseudonymous ID（`sub` と同方式。生 PII は持たない） |
| `policyVersion` | 提示した同意文面のバージョン |
| `purpose` / `provider` / `period` | 利用目的・提供先・対象期間（提示内容そのもの） |
| `grantedAt` / `expiresAt` | 同意日時・失効 |
| `channel` / `ip` / `userAgent` | 操作証跡 |
| `providerRequestId` | 協会への提供リクエスト ID（外部連携との相関） |

改ざん耐性は、追記専用ストア（DynamoDB + 条件付き書込 / S3 Object Lock 等）＋レコードの署名/ハッシュチェーンで担保する（本番設計課題として明記）。

---

## 11. テスト戦略

**core の unit を中心**に、回帰防止価値のあるものだけ書く（「どの回帰を防ぐか / 既存カバレッジの穴か / 真陽性 == 実バグか」を説明できるものだけ）。framework は Vitest 統一。

| 層 | テスト | 主眼 |
|---|---|---|
| `core/diagnosis` | unit（厚め） | 料金式の正しさ、**高騰月で市場連動が高くなる**こと、短期間（`coveredMonths<12`）、欠測按分、境界（段階の閾値） |
| `apps/api` | 統合（少々） | mock を叩いて主要ハッピーパス（verify→consent→diagnosis）、認可失敗（consent なしで 403）、上流失敗で 502 |
| `apps/web` | 軽め | 診断結果の表示ロジック（月次グラフのデータ整形）程度 |
| 契約（api↔mock） | contract test | 共有 Zod schema を両側の境界で `parse` し、mock の出力と api の期待が乖離しないことを保証（本番 adapter 差し替え時の乖離検知の代替） |

E2E（Playwright 等）は MVP では持たず、後続フェーズで必要になれば追加する。API 契約の可視化が要る段になれば、Zod → OpenAPI 生成（`zod-openapi` 等）を **ドキュメント/レビュー用途に限って**任意で導出する（[§4](#4-型共有の方針)。ソースは Zod のまま）。

---

## 12. 実装順序（開発 1 日の想定）

1. `core`: 型・Zod schema・adapter interface・`diagnose` 純関数 + unit test
2. `mock`: 3 連携のエンドポイントと決定的サンプルデータ（高騰月・短期間プロファイル含む）
3. `api`: MVP adapter（mock 叩き）・JWT・エンドポイント + 統合テスト
4. `web`: 体験フロー 4 画面（SMS / 同意 / 診断結果グラフ / 申込プレフィル）
5. `infra`: CDK stack（コードのみ、deploy は任意）

---

## 付録 A. 確定した設計前提（grilling の結論）

| 論点 | 決定 |
|---|---|
| 外部連携（協会/SMS/JEPX） | core に adapter interface。MVP は 3 つとも mock service 経由。本番は同 interface の実 adapter へ差し替え |
| スタック | TS 統一 + pnpm workspaces + Zod。web=React+Vite / api・mock=Hono / core=純 TS |
| api↔mock | mock は独立 HTTP service（実 API 形状を模倣）。api の adapter が HTTP で叩く。本番は base URL 差し替えのみ |
| 永続化 | DB なし・ステートレス算出。同意ログ永続化は target 記述のみ |
| セッション | 署名付き短命 JWT（claims: 電話 hash・検証済・同意 scope）。鍵は MVP=env / 本番=Secrets Manager |
| infra | CDK コードあり・deploy 任意。target=CloudFront(S3 + /api/*→ALB→ECS)。mock は dev/demo のみ |
| edge 経路 | CloudFront 単一ドメイン、default→S3 / `/api/*`→ALB。CORS 不要 |
| 診断モデル | 2 プラン比較の現実的簡易モデル（現行=従量電灯 B 相当、市場連動=Σ(30分 kWh×JEPX)+マージン）。月次 12 ヶ月 |
| スコープ端 | 短期間バックテストは扱う。CSV fallback / 旧型計器は設計のみ |
| テスト | core unit 中心 + api 統合少々。Vitest 統一 |
