# Model performance, cases, and relationship analysis

Three admin-only features that sit on top of alerts, disputes and the decision audit. They add no new
scoring authority: they measure it, organise human work around it, and show how accounts connect.

## 1. Model performance & outcome feedback (`/model-performance`, `GET /admin/model-performance`)

Compares what was predicted with what was later learned.

| Label | Source |
|---|---|
| TP / FP | flagged transaction (has an alert) with analyst verdict `confirmed_fraud` / `false_positive` |
| unreviewed | flagged, no verdict yet: excluded from precision and counted as backlog |
| FN* | NOT flagged but disputed by the customer: a missed-fraud *candidate* (unverified) |
| TN* | not flagged, not disputed, older than `maturity_days` (default 30): *presumed* legitimate |

- **Precision** is analyst-verified. **Recall** and **false-positive rate** are estimates that depend on the presumptions above; every figure ships with its counts and a Wilson 95% interval, and rates under 10 reviewed cases are marked `low_sample`.
- **PR-AUC** is computed on all labelled rows (with prevalence as the baseline) and on reviewed alerts only, which removes the presumption but only ranks flagged cases.
- Views: weekly series, risk band, category, merchant, customer cohort (account age at the time of the transaction), and per model version with current-vs-previous comparison. The comparison states whether the precision gap is statistically distinguishable, and warns that versions saw different traffic.
- **Backlog**: unreviewed predictions (older than 24h / 7d, oldest age), confirmed outcomes, review coverage, unflagged disputes.
- **Export**: `?format=csv` (audited, formula-injection safe) or the JSON report.
- Synthetic/demo transactions are excluded.

Limits: only flagged transactions are reviewed, so labels are biased toward the model's own view. Fraud nobody notices or reports is invisible. For a like-for-like challenger comparison use the shadow-score outcome evaluation (`/admin/ml/outcome-evaluation/:version`).

## 2. Cases (`/cases`, `/api/v1/investigations`)

A case groups related alerts and transactions into one unit of work. (Distinct from the per-alert workflow in
`CASE_MANAGEMENT.md`: claims, SLAs and evidence stay on the alert; the case adds grouping, a timeline and an outcome.)

- Created from alerts and/or transactions. An alert and its transaction always travel together. A transaction without an alert (e.g. a customer-reported miss) can anchor a case.
- **An alert or transaction belongs to at most one case** (unique index; a race resolves to one winner and a clear 409 naming the other case).
- Status `open / investigating / pending_info / closed`, priority, assignee (investigators only), optimistic `version` on every edit.
- **Timeline** (chronological, read-only): case events and notes, plus the comments, evidence, resolutions and transactions of its alerts, and the disputes on its transactions.
- **Links**: accounts, devices, IPs, disputes, other cases touching the same account/device/IP, and *suggestions* (unassigned alerts sharing an account/device/IP). Suggestions are leads, never auto-added.
- **Outcome**: `confirmed_fraud / legitimate / inconclusive` with a required explanation. Optionally resolves the open alerts (`confirmed_fraud` → confirmed fraud, `legitimate` → false positive), which is how outcomes feed model performance and the dynamic blacklist. Alerts claimed by another investigator are skipped and reported, never overridden. Inconclusive cannot resolve alerts.
- Closed cases are frozen; reopening needs a reason and keeps the earlier outcome in the timeline. Every mutation is audited; note text lives on the timeline, not in the audit log.

Limits: no case-level file attachments (use alert evidence, which appears on the timeline); no realtime push for case changes; case ids are stable but a case is not auto-closed when all alerts are resolved elsewhere.

## 3. Relationship & fraud-ring analysis (`/relationships`, `/api/v1/relationships/*`)

Shared identifiers are weak evidence: public/NAT/carrier IPs are shared by strangers, `device_fingerprint` is a hash of the User-Agent only, and households share both innocently. So:

1. Private, loopback and CGNAT addresses are ignored.
2. An IP/device used by more than `RELATIONSHIP_COMMON_MAX_ACCOUNTS` (6) accounts is *shared infrastructure*: shown, never expanded, never a link.
3. Evidence is discounted by how many accounts share it. Two accounts are **clustered only when independent kinds of evidence agree** (IP + device, or IP + two rare shared merchants). A single shared identifier is a *weak lead*: drawn dashed, never clustered. IP + device alone stays strong for up to 4 accounts; larger groups need a third kind of evidence.
4. Cluster **risk score (0-100)** is itemised: analyst-confirmed fraud, size, link strength, coordinated burst (6+ transactions from 2+ accounts in 10 minutes), repeated small transactions (5+ of ≤ $5 in an hour), accounts created within 48h, unresolved alerts. A cluster with no behavioural corroboration is capped at 44 (never "high") and says so.
5. Output is a *review priority*, never a verdict.

- `GET /relationships/clusters`, `/clusters/:id`, `/signals` (repeated small transactions across all accounts), `/graph?transactionId=|userId=&depth=1|2` (node cap 120, `truncated` flag; viewing a graph is audited).
- UI: cluster list → evidence + SVG graph; from a transaction → "Explore related accounts"; "Open case from cluster" seeds a case with its open alerts.

**Live scoring changed.** The previous check treated *any* shared device/IP chain to a confirmed-fraud account as a hard override (score 100). It now uses only strong, hub-suppressed links, and by default adds risk and a reason without auto-deciding (`RELATIONSHIP_HARD_OVERRIDE=true` restores strict behaviour). The old single-hop `/admin/fraud-rings` listing is kept for compatibility.

Known gaps: the separate *dynamic device/IP blacklist* (`transactionRepository.fraudDeviceAndIpBlacklist`) still matches a single confirmed-fraud IP/device directly and has the same shared-IP weakness; it should get the same hygiene. The index is cached for 30 s, so a new confirmation can take that long to influence live scoring. Cluster ids (`c<lowest user id>`) can change when clusters merge or split. Clustering is recomputed on request (fast at the tested scale; precompute for very large deployments).
