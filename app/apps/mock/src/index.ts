// Hono mock サーバ（docs/design.md §7）。外部連携（協会 power-data / SMS / JEPX）を擬似。
// backend(apps/api) の外部連携アダプタがこれを叩く（本番では実 API に差し替え）。

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { CONTRACT_INFO } from '@diag/core';
import { generateSampleData } from './generate.ts';

// データは起動時に1回だけ生成（決定的・メモリ保持）
const { readings, prices } = generateSampleData();

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

// --- SMS 認証（汎用・仕様非公開のため簡易 mock） ---
app.post('/sms/send', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.phone) return c.json({ error: 'phone required' }, 400);
  return c.json({ sent: true });
});

app.post('/sms/verify', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // 固定コードで通す（実 SMS 送信なし）
  if (body?.code === '123456') return c.json({ verified: true });
  return c.json({ verified: false }, 401);
});

// --- 協会 power-data（API 仕様非公開のため自前契約） ---
app.post('/power-data/consent', (c) => {
  return c.json({ consentId: `consent-${Math.floor(Date.now() / 1000)}` });
});

app.get('/power-data/readings', (c) => {
  // 12ヶ月分の30分値
  return c.json({ readings });
});

app.get('/power-data/contract', (c) => {
  return c.json(CONTRACT_INFO);
});

// --- JEPX 市場価格（公開CSV構造に値の意味論を準拠、wire は正規化 JSON） ---
app.get('/market/spot', (c) => {
  return c.json({ prices });
});

const port = Number(process.env.MOCK_PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[mock] listening on http://localhost:${info.port} (readings=${readings.length})`);
});
