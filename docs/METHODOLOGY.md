# Fraud Detection Methodology & Trade-offs

*The short version of this document is the answer to "walk me through how
your fraud detection actually works" in an interview. For full technical
detail (SHAP internals, model registry file layout, retraining CLI flags),
see `ml_service/README.md` — this doc is deliberately the condensed,
narrative version of that one, organized around decisions and trade-offs
rather than implementation.*

## The problem, framed

Fraud detection is a **binary classification problem with brutal class
imbalance** (fraud is rare — typically <1-5% of transactions) and an
**asymmetric cost function**: a false negative (missed fraud) costs real
money and trust; a false positive (blocking a legitimate purchase) costs
a customer's patience and, at scale, their business. Optimizing pure
accuracy is close to useless here — a model that predicts "not fraud"
for everything scores >95% accuracy and catches nothing. Every design
decision below traces back to that asymmetry.

## Why hybrid, not "just ML"

FraudGuard uses three layers, in order of precedence, mirroring how
Stripe Radar / PayPal-style systems are actually built — not because a
pure ML approach is deprecated, but because a probabilistic model and a
deterministic policy are answering different questions:

1. **Hard rules** (`fraudEngine.js` → `checkHardRules()`) — a static
   blacklist, an absolute amount cap, and a dynamic blacklist (any
   device/IP seen on a *confirmed* fraud transaction, from any user, is
   auto-flagged going forward). **These override the ML score entirely.**
2. **ML model** — the primary probabilistic score for everything that
   isn't a clear-cut policy violation.
3. **Rule-engine fallback** — a threshold scorer used only if the ML
   service is unreachable, so the app degrades gracefully instead of
   failing the request.

**The trade-off this encodes:** a model trained on historical patterns
will never assign 100% probability to something it's never seen, and it
*shouldn't* — that's honest uncertainty. But "this exact card number is
on a sanctions list" isn't a pattern to be learned probabilistically,
it's a policy to be enforced absolutely. Mixing the two into one score
would either mute the policy (a $50,000 wire transfer from a blacklisted
account scoring 40% because the model's never seen anything like it) or
force the model to memorize rules it should never have discretion over.
Separating them means each layer does the thing it's actually good at —
and it also means the *fraud reasons a human reads* clearly distinguish
"we have an explicit policy against this" from "the model's pattern-
matching flagged this," which matters when someone disputes a block.

**Cost of this choice:** more moving parts, two systems to keep in sync
(e.g. the location/category vocabulary between `mlClient.js` and
`generate_dataset.py`), and a real question of *where* a given rule
belongs — too many hard rules and you're back to a brittle rules engine
wearing an ML costume; too few and obvious cases go through unnecessary
probabilistic uncertainty.

## Feature engineering: behavioral, not just transactional

The features aren't just "amount, category, location" — most of the
signal comes from **behavior relative to the user's own history**,
computed server-side (never trusted from the client):

| Feature | What it captures |
|---|---|
| `velocity_last_hour` | Card-testing / burst-fraud pattern |
| `spending_zscore` | Deviation from *this user's* normal spend, not a global average |
| `ratio_to_median_purchase_price` | Same idea, robust to one user just being a big spender |
| `geo_distance_from_last_km` (haversine) | "Two transactions, two continents, one hour" |
| `distance_from_home` | Deviation from the user's usual location |
| `is_new_device` / `ip_status` | Account-takeover signal |

**Trade-off:** relative/behavioral features generalize better across
users than absolute thresholds ("$500 is nothing for one user and
alarming for another") but need enough history per user to be
meaningful — a brand-new account has no baseline to deviate from, which
is itself a signal worth handling explicitly rather than silently
producing noisy z-scores from n=1.

**Honest caveat on device/IP fingerprinting:** this uses a hashed
User-Agent + raw IP as a lightweight fingerprint, not a real
fingerprinting library (FingerprintJS-style canvas/WebGL/font signals,
or a commercial IP intelligence service). It's a legitimate simplified
version of the same *signal* — worth saying plainly in an interview
rather than overselling it.

## Model selection & class imbalance

Three candidates — Logistic Regression, Random Forest, XGBoost — trained
and compared on the same data/splits, with **SMOTE + class weighting**
to address the imbalance rather than naive oversampling or ignoring it.
XGBoost currently wins on **PR-AUC**, not ROC-AUC or accuracy — deliberately:
ROC-AUC is misleadingly optimistic under heavy class imbalance (the
large true-negative count dominates it), and accuracy rewards the
"always predict not-fraud" model mentioned above. PR-AUC (precision-
recall) stays honest about performance on the minority class, which is
the class that actually matters here.

**Why not a neural net / deep learning?** Tabular, moderate-dimensional,
behaviorally-engineered features are exactly where gradient-boosted
trees tend to beat deep learning in practice, with far less data and
compute, and — critically for this domain — with interpretability tools
(SHAP) that are mature and fast for tree models. A deep net might close
a small performance gap at the cost of explainability that a fraud
system genuinely needs (see below) and a much larger training-data
requirement this synthetic dataset doesn't really have.

## Explainability isn't optional here

Every prediction ships with a **real SHAP explanation**, not a
heuristic weight×value approximation — `top_factors` showing exactly
which features pushed the score up or down, per transaction. This
isn't a nice-to-have UI feature; it's a requirement in most real fraud
systems for the same reasons SHAP matters in credit/lending: a blocked
transaction is a decision made *about* someone, and "the model said so"
is not an acceptable answer to a disputed charge, a support ticket, or
(in regulated contexts) a compliance audit. The frontend's Transaction
Simulator surfaces this as a feature-contribution chart specifically so
the "why" is never buried behind a single score.

## Thresholds and the precision/recall trade-off

Score → risk level (updated): the score is now a calibrated probability × 100 and the
thresholds are an admin-configurable, versioned risk policy (default review ≥ 10,
fraud ≥ 50; see `docs/MODEL_VALIDATION.md`). The rule-engine fallback still uses
the fixed bands `0–39` low, `40–69` medium (review), `70–100` high
(alert). These aren't arbitrary — they encode a **three-way decision**
(auto-approve / human review / auto-flag) instead of a binary cutoff,
because forcing a binary threshold on an inherently uncertain score
either over-blocks (threshold too low → too many false positives, angry
customers) or under-catches (threshold too high → missed fraud). The
medium band is where a probabilistic model is honest about not being
sure — routing that band to human review instead of an automated
decision is the correct response to that uncertainty, not a cop-out.

**This is a business decision as much as a modeling one.** Moving these
thresholds trades false positives for false negatives directly, and the
"right" thresholds depend on numbers this project doesn't have — cost
per fraudulent transaction vs. cost per lost legitimate customer for a
*specific* business. Worth saying explicitly in an interview: the
thresholds here are reasonable defaults, not a number derived from a
real cost-benefit model, because that model doesn't exist without real
business data.

## A real bug worth discussing: feature leakage from constants

The most interview-worthy thing about this project isn't a feature, it's
a bug that was caught and fixed. An earlier version derived
`repeat_retailer` from whether the transaction's *category* matched the
user's declared preferences — true for almost all legitimate
transactions by construction, false for almost all fraud. That's
spurious, near-perfect signal, and the model gladly exploited it.
Separately, `online_order`/`used_chip`/`used_pin_number` varied in
training data but are **hardcoded constants at serving time** (this app
is card-not-present only) — the model still learned "signal" from them
in training, and since they never vary in production, that signal
silently biased every live prediction in the same direction.

It surfaced because a completely benign first-ever transaction scored
**99.97% fraud probability** — a number that should make anyone suspicious
of their own model, not proud of it. The fix: compute `repeat_retailer`
genuinely (same merchant in the user's actual recent history), and drop
the constant-at-serving-time features from the feature set entirely.
**PR-AUC dropped from ~0.99 to ~0.94 after the fix** — and that's the
correct outcome to report, not a regression: 0.99 was measuring how well
the model exploited a leak, not how well it detects fraud. A metric that
gets worse after fixing a real bug is the model finally being evaluated
honestly.

**The general lesson:** a feature can only be genuinely predictive in
production if it's actually free to vary in production. If a field is
constant at serving time, either exclude it from training or verify it
varies identically in both — this class of bug doesn't show up in a
train/test split done carelessly, because the leak is consistent across
both.

## A second gap worth discussing: the feedback loop that didn't close

The hard-rule dynamic blacklist (see "Why hybrid" above) is supposed to
be how analyst review actually improves the system over time — a
device/IP seen on confirmed fraud gets blocked going forward. The first
version of alert resolution didn't support that: `resolve` just flipped
a `resolved` boolean, with no way to record *whether* the alert was
actually fraud. The blacklist query had to fall back to the model's own
`is_fraud` flag at scoring time — which meant the "feedback loop" wasn't
actually reading analyst feedback at all, just the model's original
guess, resolved or not. Worse, a false alarm that got queued for
blacklisting stayed blacklisted forever, since nothing in the system
could ever un-flag it: an analyst clearing a false positive had no way
to tell the blacklist it had been wrong.

The fix was `alerts.resolve` requiring a `verdict` —
`confirmed_fraud` or `false_positive`, not a boolean — and rewriting the
blacklist query to read it: `confirmed_fraud` adds a device/IP to the
blacklist regardless of what the model originally scored (catching
medium-risk transactions a human later confirms as fraud, not just ones
the model already flagged high), and `false_positive` explicitly removes
it even if the model's original score said otherwise. That second half
is the one that matters most in practice — without it, one bad model
call permanently poisons a legitimate customer's device, and there's no
path back.

**The general lesson, again:** a feedback loop only closes if the
"feedback" is actually captured somewhere queryable, not implied by the
absence of an open case. "Resolved" and "confirmed correct" are two
different facts, and conflating them means the system can never learn
it was wrong — only that someone stopped looking at it.

## What's synthetic here, and why that matters

The training data (`generate_dataset.py`) is **synthetically generated**
— ~3,000 simulated users over 90 days — not the real ULB Kaggle credit
card fraud dataset, because this build environment has no Kaggle access.
It's built to deliberately include overlap between fraud and legitimate
patterns (some "fraud" uses a previously-seen device, simulating account
takeover; some legitimate transactions are large or rapid) specifically
so the model doesn't hit a suspiciously clean 100%. As covered above,
the honest current number (after the feature-leakage fix) is **PR-AUC
~0.94** — the pre-fix ~0.99 was measuring the leak, not fraud detection.

**Say this plainly in an interview:** real fraud data is messier —
concept drift, adversarial actors actively probing for the model's
blind spots, far more subtle behavioral patterns than a generator can
simulate, and a genuinely harder precision/recall trade-off than
synthetic data with known ground truth produces. This project's
retraining pipeline, versioning, and rollback machinery are built to be
data-source-agnostic — swapping in real data is a `feature_engineering.py`
change, not an architecture change — but the current numbers describe
how well the pipeline works, not a claim about real-world fraud-catch
rates.

## Retraining, versioning, and production trade-offs

`train_model.py` never overwrites a model in place — every run creates a
new versioned entry (`models/registry/vN/`) and only **promotes** it
(updates what the API actually serves) if it beats the current version
on PR-AUC. `retrain_pipeline.py` chains regenerate → train → compare →
promote → hot-reload the live service with zero downtime, and
`POST /model/rollback` can revert instantly if a promotion turns out
bad in practice despite looking better offline (a real and common
failure mode — offline metrics and production behavior diverge).

**Latency trade-off worth naming:** every transaction pays the cost of
an HTTP call to a separate FastAPI service (`scoreWithML()`) plus SHAP
computation, instead of an in-process model call. That's the right
trade for this project (language/tooling fit — Python's ML ecosystem vs.
Node's API ecosystem — and independent scaling of the two services) but
it's a real latency and availability cost, which is exactly why the
rule-engine fallback exists: a fraud check that fails closed (blocks
everything when the ML service is down) or blocks the whole checkout
flow on a network hiccup would be worse than briefly degrading to a
simpler deterministic scorer.

## If I had more time / real data

- Swap in the real ULB dataset (or real production data) — the pipeline
  is built for this, see `ml_service/README.md`.
- Derive the risk thresholds from an actual cost model (cost of a missed
  fraud vs. cost of a false decline) instead of round numbers.
- Add drift detection so `retrain_pipeline.py --simulate-drift` isn't
  the only way this gets exercised — a real system needs to *notice* its
  own degradation, not just have a manual retrain button.
- A proper device-fingerprinting library and IP-intelligence service
  instead of the hashed-UA/raw-IP stand-in.
- Calibrate `fraud_score` as a true probability (Platt scaling /
  isotonic regression) rather than treating the raw model output as
  one — useful once thresholds are being set from a real cost model.
