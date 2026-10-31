/**
 * Plain-Language Explanation Service
 * =====================================
 * Feature: LLM-generated plain-language explanations. An analyst
 * triaging an alert currently has to read a SHAP feature-contribution
 * list (feature name + signed number) or a bag of rule-engine strings
 * and mentally compose the story themselves. This turns that into ONE
 * sentence: "Flagged mainly due to an unusually large purchase from a
 * new device in a high-risk location."
 *
 * Two tiers, same "degrade gracefully" philosophy as the rest of this
 * app (ML service down -> rule-engine fallback; primary model down ->
 * nothing crashes):
 *
 *   1. TEMPLATE (default, always available) — a deterministic mapping
 *      from known SHAP feature names / hard-rule reason strings to
 *      natural-language phrases, stitched into one sentence. Free, has
 *      zero external dependency, and is what's used when no LLM key is
 *      configured or the LLM call fails/times out.
 *
 *   2. LLM (opt-in via ANTHROPIC_API_KEY) — hands the SAME structured
 *      signals (not raw PII, not the full transaction) to Claude with a
 *      strict "reply with exactly one sentence" system prompt, for a
 *      more natural, varied sentence than the template can produce.
 *      Never trusted blindly: the model is asked to explain signals we
 *      already computed, not to make its own fraud judgment, and a
 *      malformed/oversized/empty response falls back to the template
 *      rather than being shown as-is.
 *
 * Called on demand (routes/alerts.js's GET /:id/explanation), NOT at
 * scoring time for every transaction — see that route for why, and
 * transactions.plain_language_explanation for the cache this writes to
 * so the same alert never regenerates (or re-bills an LLM call) twice.
 */

const config = require('../config/env');
const logger = require('../config/logger');

// --- Tier 1: deterministic template -------------------------------------

// Known SHAP feature names (see ml_service/app.py's _humanize) mapped to
// a natural-language phrase. Anything not in this table falls back to a
// generic "elevated <feature name>" phrase rather than being dropped —
// an imperfect phrase beats silently ignoring a real signal.
const FEATURE_PHRASES = {
  amount: 'an unusually large purchase amount',
  'log amount': 'an unusually large purchase amount',
  'ratio to median purchase price': "a purchase far above this customer's typical spending",
  'spending zscore': "spending far outside this customer's normal pattern",
  'velocity last hour': 'an unusually high number of transactions in the last hour',
  'time since last transaction minutes': 'transactions happening in rapid succession',
  'is rapid succession': 'transactions happening in rapid succession',
  'is new device': 'a new, unrecognized device',
  'is high risk category': 'a high-risk purchase category',
  'is high risk location': 'a high-risk location',
  'is night txn': 'a purchase made late at night',
  'distance from home': "a purchase location far from the customer's home",
  'geo distance from last km': 'a large jump in location since the previous transaction',
  'repeat retailer': 'an unfamiliar, first-time retailer',
  hour: 'the time of day the purchase was made',
  'day of week': 'the day of the week the purchase was made',
};

function phraseForFeature(feature) {
  const key = feature.toLowerCase().trim();
  if (FEATURE_PHRASES[key]) return FEATURE_PHRASES[key];
  // Preserve the ORIGINAL casing of the value half (e.g. "Lagos, NG"),
  // only using the lowercased key to detect which prefix matched.
  const original = feature.trim();
  if (key.startsWith('category:')) return `a ${original.slice(original.indexOf(':') + 1).trim()}-category purchase`;
  if (key.startsWith('location:')) return `a purchase from ${original.slice(original.indexOf(':') + 1).trim()}`;
  if (key.startsWith('card type:')) return `a ${original.slice(original.indexOf(':') + 1).trim()} card`;
  if (key.startsWith('ip status:')) return `an IP address flagged as ${original.slice(original.indexOf(':') + 1).trim()}`;
  return `elevated ${key}`;
}

function joinPhrases(phrases) {
  if (phrases.length === 0) return '';
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`;
}

/**
 * @param {{fraud_score: number, risk_level: string, fraud_reasons: string[], shap_explanation: Array<{feature: string, shap_value: number, effect: string}>, hard_flag_triggered: string[]|null, scoring_method: string}} txn
 */
function templateExplanation(txn) {
  const shap = txn.shap_explanation || [];
  const hardFlags = txn.hard_flag_triggered || [];

  // A hard-rule/network override IS the real reason — explain that
  // directly rather than the model's SHAP factors, which weren't even
  // what decided this one (see fraudEngine.js's hard-override path).
  if (hardFlags.length > 0) {
    return `Blocked by a hard rule: ${hardFlags[0].charAt(0).toLowerCase()}${hardFlags[0].slice(1)}.`;
  }

  const topIncreasing = shap
    .filter((f) => f.effect === 'increased_risk')
    .slice(0, 3)
    .map((f) => phraseForFeature(f.feature));

  if (topIncreasing.length > 0) {
    return `Flagged mainly due to ${joinPhrases(topIncreasing)}.`;
  }

  // No SHAP available (rule-engine fallback, ML service was down) —
  // fall back to the rule-engine's own reason strings.
  if ((txn.fraud_reasons || []).length > 0) {
    const reason = txn.fraud_reasons[0];
    return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
  }

  if (txn.risk_level === 'low') {
    return 'No significant risk factors were identified for this transaction.';
  }
  return `Scored ${Math.round(txn.fraud_score)}/100 risk with no single dominant factor identified.`;
}

// --- Tier 2: optional LLM upgrade ---------------------------------------

const SYSTEM_PROMPT = [
  'You are helping a fraud analyst quickly understand why a transaction',
  'was scored the way it was. You will be given a JSON object of ALREADY',
  "-COMPUTED risk signals (a model's feature attributions and/or rule-engine",
  'reasons) for one transaction. Do not invent new signals, do not give a',
  'fraud verdict of your own, and do not add caveats or hedging. Reply with',
  'EXACTLY ONE short sentence (max ~30 words) in plain English summarizing',
  'why this transaction looks risky (or not), suitable to show directly in',
  'a fraud-review dashboard. No preamble, no quotes, no markdown — just the',
  'sentence.',
].join(' ');

async function llmExplanation(txn) {
  if (!config.anthropicApiKey) return null;

  const signals = {
    fraud_score: txn.fraud_score,
    risk_level: txn.risk_level,
    scoring_method: txn.scoring_method,
    hard_flags: txn.hard_flag_triggered || [],
    top_factors: (txn.shap_explanation || []).slice(0, 5),
    rule_reasons: txn.fraud_reasons || [],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 100,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(signals) }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn('LLM explanation request failed, falling back to template', { status: response.status });
      return null;
    }
    const data = await response.json();
    const text = (data.content || []).find((block) => block.type === 'text')?.text?.trim();
    // Sanity-check the response before trusting it: non-empty, roughly
    // sentence-shaped, and not absurdly long (a runaway/malformed
    // response is worse than falling back to the template).
    if (!text || text.length === 0 || text.length > 400) return null;
    return text;
  } catch (err) {
    logger.warn('LLM explanation call failed, falling back to template', { error: err.message });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generates the one-sentence explanation for a scored transaction. Tries
 * the LLM first (if configured), falls back to the deterministic
 * template on any failure/timeout/missing key — the caller never sees
 * an error from this, only ever a usable sentence.
 */
async function generateExplanation(txn) {
  const llmResult = await llmExplanation(txn);
  return { text: llmResult || templateExplanation(txn), source: llmResult ? 'llm' : 'template' };
}

module.exports = { generateExplanation, templateExplanation, phraseForFeature };
