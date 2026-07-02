import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, Cell, ResponsiveContainer } from 'recharts';
import type { DiagnosisResult } from '@diag/core';
import { yen, monthLabel } from '../format.ts';

const COLOR_CURRENT = '#94a3b8';
const COLOR_MARKET = '#22c55e';
const COLOR_SPIKE = '#ef4444';

// annualDiff が 0 ちょうどの境界では「安い／高い」どちらも事実に反するため、good/bad と並ぶ第三の判定を持たせる。
const VERDICT = {
  good: { headline: '安くなる見込み', rateLabel: '実効削減率' },
  bad: { headline: '高くなる見込み', rateLabel: '実効増加率' },
  even: { headline: 'ほぼ変わらない見込み', rateLabel: '実効差' },
} as const;

export function ResultStep({
  diagnosis,
  loading,
  onApply,
}: {
  diagnosis: DiagnosisResult;
  loading: boolean;
  onApply: () => void;
}) {
  const verdict =
    diagnosis.annualDiff > 0 ? 'good' : diagnosis.annualDiff < 0 ? 'bad' : 'even';
  const { headline, rateLabel } = VERDICT[verdict];
  // even は専用クラスを持たないので base の hero に中立色を inline で当てる（styles.css を増やさない）。
  const heroClass = verdict === 'even' ? 'hero' : `hero ${verdict}`;
  const heroStyle =
    verdict === 'even' ? { background: '#f8fafc', border: '1px solid #e2e8f0' } : undefined;
  const spikes = diagnosis.monthly.filter((m) => m.isSpike).map((m) => monthLabel(m.month));

  const data = diagnosis.monthly.map((m) => ({
    month: monthLabel(m.month),
    現行: Math.round(m.currentTotal),
    市場連動: Math.round(m.marketTotal),
    isSpike: m.isSpike,
  }));

  return (
    <div className="result">
      <div className={heroClass} style={heroStyle}>
        <span className="hero-label">市場連動プランなら年間</span>
        <span className="hero-amount">
          {yen(Math.abs(diagnosis.annualDiff))} {headline}
        </span>
        <span className="hero-sub">
          {rateLabel} {(Math.abs(diagnosis.annualDiffPct) * 100).toFixed(1)}%（現行 年間 {yen(diagnosis.annualCurrent)}）
        </span>
      </div>

      <h3>過去 12 ヶ月のバックテスト（月次料金）</h3>
      <div className="chart">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} tick={{ fontSize: 12 }} width={36} />
            <Tooltip formatter={(v) => yen(Number(v))} />
            <Legend />
            <Bar dataKey="現行" fill={COLOR_CURRENT} />
            <Bar dataKey="市場連動">
              {data.map((d, i) => (
                <Cell key={i} fill={d.isSpike ? COLOR_SPIKE : COLOR_MARKET} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {spikes.length > 0 && (
        <p className="spike-note">
          ⚠ 高騰月（{spikes.join('・')}）は市場連動が高くなります。高騰も隠さず、実データで正直に提示しています。
        </p>
      )}

      <button type="button" className="primary" onClick={onApply} disabled={loading}>
        {loading ? '準備中…' : 'この内容で申し込む'}
      </button>
    </div>
  );
}
