// 外部連携アダプタ（docs/design.md §7, §12）。base URL を env で切替し、
// dev/demo は mock サーバ、本番は実 API を叩く。レスポンスは core の Zod で検証。

import {
  zReadingsResponse,
  zMarketSpotResponse,
  zContractResponse,
  zExternalConsentResponse,
  type ConsumptionReading,
  type MarketPrice,
  type ContractInfo,
} from '@diag/core';

const baseUrl = () => process.env.EXTERNAL_BASE_URL ?? 'http://localhost:8787';

// 上流が stall してもリクエストを無限滞留させない application-level deadline
const TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS ?? 8000);

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(baseUrl() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(baseUrl() + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`external GET ${path} failed: ${res.status}`);
  return res.json();
}

export const external = {
  async smsSend(phone: string): Promise<boolean> {
    const res = await postJson('/sms/send', { phone });
    return res.ok;
  },

  async smsVerify(phone: string, code: string): Promise<boolean> {
    const res = await postJson('/sms/verify', { phone, code });
    if (!res.ok) return false;
    const json = (await res.json()) as { verified?: boolean };
    return json.verified === true;
  },

  // subject（ハッシュ済み）を渡して同意を作成。mock は無視するが、実 API では
  // 「このユーザーの同意」として upstream に紐付けるための seam。
  async consent(subject: string): Promise<{ consentId: string }> {
    const res = await postJson('/power-data/consent', { subject });
    if (!res.ok) throw new Error(`external consent failed: ${res.status}`);
    // 他の power-data 同様 Zod 検証（consentId が非空であること）
    return zExternalConsentResponse.parse(await res.json());
  },

  // 個データ取得には consent 文脈（consentId）を渡す。mock は無視するが、
  // 実 API 切替時に「対象ユーザーの認可済みデータ」を要求できる seam（README §本番境界）。
  async readings(consentId: string): Promise<ConsumptionReading[]> {
    const q = `?consentId=${encodeURIComponent(consentId)}`;
    return zReadingsResponse.parse(await getJson('/power-data/readings' + q)).readings;
  },

  // 市場価格は公開データ（JEPX）でユーザー固有でないため consent 文脈は不要
  async marketSpot(): Promise<MarketPrice[]> {
    return zMarketSpotResponse.parse(await getJson('/market/spot')).prices;
  },

  async contract(consentId: string): Promise<ContractInfo> {
    const q = `?consentId=${encodeURIComponent(consentId)}`;
    return zContractResponse.parse(await getJson('/power-data/contract' + q));
  },
};
