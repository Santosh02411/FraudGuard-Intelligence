# Customer risk profiles, geo-velocity, feedback labels and controlled retraining

## 17. Customer risk profiles (`/customer-profiles`, admin only)
An explainable analyst aid. Six components, each 0-100 with a fixed weight and the evidence behind it: spending (20), velocity (20), account age (10), client/device changes (15), location (15), confirmed outcomes (20). Components without enough data are reported as `insufficient_data` and left out (weights renormalised) rather than guessed. With fewer than 5 transactions of history the band is capped at medium.
- It does **not** feed live scoring and never blocks or declines anything.
- A "device" is a hash of the User-Agent (a browser/app signature), so a new one is weak evidence (new phone, browser update). Account age is uncertainty, not misconduct.
- Shared devices/IPs between accounts are deliberately not used here (see relationship analysis, which treats shared infrastructure with care). Raw IPs and fingerprints are never returned.
- Viewing a profile is audited (`customer_profile.view`). The list scans at most 200 recently active accounts and says when it truncated.

## 18. Geo-velocity (`GEO_VELOCITY_MODE=off|advisory|flag`, default `flag`)
Compares the previous located transaction with the current one: distance minus a 50 km-per-end city uncertainty, against 900 km/h plus 2 h of airport overhead for trips over 300 km. Result: `plausible`, `implausible` or `indeterminate`.
- `Unknown`, `Anonymous Proxy`, unmapped locations, bad timestamps and out-of-order clocks are **indeterminate**, never "far away". Gaps over 48 h are plausible by construction.
- `flag` may lift a LOW transaction to MEDIUM (score floored at the policy's medium threshold). It never creates HIGH, never lowers a level and never blocks. `advisory` records only.
- Stored on the transaction (`geo_velocity_status`, `geo_distance_km`, `geo_required_kmh`) and returned as `geo_velocity`.
- Limits: locations are city-level labels from a small table; card-not-present purchases often carry the merchant's location; VPNs move IP locations. The response and the reason text say this is a prompt to review, not proof.

## 19. Feedback labels and controlled retraining (`/feedback`, admin only)
1. **Labels.** An investigator proposes `fraud`/`legitimate` for a transaction (or imports existing analyst verdicts as *proposed* labels). A **different** investigator must verify it (`FEEDBACK_ALLOW_SELF_VERIFY` is dev-only and refused in production). One live label per transaction; withdraw/reject frees the slot; every step is an append-only event. Simulator transactions are refused.
2. **Dataset.** Once `FEEDBACK_MIN_VERIFIED_PER_CLASS` (20) verified labels of each class exist, an admin freezes them into an immutable, sha256-hashed CSV built from the **decision-time feature snapshots** (no later history, no IPs or fingerprints). Optional *presumed-legitimate* rows (mature, never alerted, never disputed) reduce selection bias but are marked `label_source=presumed` and counted separately; they are not verified labels.
3. **Run.** A run needs approval from a second administrator, then `start` sends the dataset (hash re-checked by the ML service) to `POST /model/retrain`, which trains a **candidate only**. One open run at a time.
4. **Promotion is unchanged.** A `candidate_ready` version is not served; it still goes through `POST /api/admin/ml/change-requests` (gates, same-dataset comparison, second-person approval).

Limits: labels come from alerts the earlier model surfaced, so they are selection-biased and metrics describe agreement with those labels, not accuracy on all traffic (this is written into the version's metadata). Training runs in-process in the ML service and is single-instance. Retraining never happens automatically.
