import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer, ReferenceLine } from 'recharts';
import { BrainCircuit, AlertTriangle, Info } from 'lucide-react';

const RISK_COLOR = '#ef4444';   // pushed score toward fraud
const SAFE_COLOR = '#10b981';   // pushed score toward safe

function ContributionTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-[#0a0f14] border border-white/20 rounded-lg px-3 py-2 text-xs">
      <p className="text-white font-medium mb-0.5">{d.feature}</p>
      <p className={d.shap_value > 0 ? 'text-red-400' : 'text-green-400'}>
        {d.shap_value > 0 ? 'Increased' : 'Decreased'} fraud score &middot; {d.shap_value > 0 ? '+' : ''}{d.shap_value.toFixed(3)}
      </p>
    </div>
  );
}

/**
 * Shows *why* the model scored a transaction the way it did: a per-feature
 * SHAP contribution chart (how much each signal pushed the score toward or
 * away from fraud), not just the flattened text reason list.
 *
 * Falls back to the rule-engine's plain-text reasons when no model
 * explanation is available (rule_engine_fallback / hard_rule_override with
 * no ML call), so the panel never renders empty.
 */
export default function FraudScoreExplanation({ analysis }) {
  const shap = analysis?.shap_explanation || [];
  const method = analysis?.scoring_method || '';
  const usedModel = method.startsWith('ml_model') || method.endsWith('+ml');

  if (!usedModel || shap.length === 0) {
    return (
      <div className="bg-black/20 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2 text-gray-300 text-sm font-semibold">
          <Info size={14} className="text-gray-400" /> Model explanation unavailable
        </div>
        <p className="text-gray-500 text-xs">
          {analysis?.scoring_method === 'rule_engine_fallback'
            ? 'The ML service was unreachable for this transaction, so it was scored by the deterministic rule engine instead. See the risk factors below.'
            : 'No feature contributions were returned for this transaction.'}
        </p>
      </div>
    );
  }

  // Sort so the chart reads top-to-bottom by magnitude of effect, biggest
  // risk driver first, matching how an analyst would scan it.
  const data = [...shap].sort((a, b) => Math.abs(b.shap_value) - Math.abs(a.shap_value));
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.shap_value)), 0.01);

  return (
    <div className="bg-black/20 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1 text-gray-200 text-sm font-semibold">
        <BrainCircuit size={15} className="text-purple-400" /> Fraud Score Explanation
      </div>
      <p className="text-gray-500 text-xs mb-3">
        SHAP contribution of each signal to this transaction's model score. Red pushes toward fraud, green pushes toward safe.
      </p>
      <ResponsiveContainer width="100%" height={Math.max(data.length * 34, 90)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" horizontal={false} />
          <XAxis
            type="number"
            domain={[-maxAbs, maxAbs]}
            tick={{ fill: '#9ca3af', fontSize: 11 }}
          />
          <YAxis
            dataKey="feature"
            type="category"
            width={150}
            tick={{ fill: '#d1d5db', fontSize: 11 }}
          />
          <ReferenceLine x={0} stroke="#ffffff30" />
          <Tooltip content={<ContributionTooltip />} cursor={{ fill: '#ffffff08' }} />
          <Bar dataKey="shap_value" radius={[3, 3, 3, 3]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.shap_value > 0 ? RISK_COLOR : SAFE_COLOR} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {analysis.model_used && (
        <p className="text-gray-600 text-[11px] mt-2 flex items-center gap-1">
          <AlertTriangle size={11} /> Scored by {analysis.model_used} (model v{analysis.model_version})
        </p>
      )}
    </div>
  );
}
