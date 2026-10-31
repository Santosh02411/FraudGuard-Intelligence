# Alert case management

Alerts are investigation cases for admins (investigators). Customers never see case data or `alert:updated` realtime events.

- **Severity**: critical/high/medium/low from risk level, raised for amounts ≥ $5000. Changing it needs a reason, recomputes the deadline and is audited.
- **Status**: `open → in_review / pending_info / escalated → resolved`.
- **SLA & escalation**: `due_at` per severity (`ALERT_SLA_MINUTES_*`). A sweep (`ALERT_ESCALATION_INTERVAL_MS`, 0 disables) escalates overdue unresolved alerts via compare-and-set (max `ALERT_MAX_ESCALATION_LEVEL`), next deadline = half the SLA, audited as `system:escalation`. Overdue is flagged in the API and UI; the queue sorts by `sort=priority`.
- **No silent double work**: `POST /alerts/:id/claim` takes a lease (`ALERT_CLAIM_TTL_MINUTES`, default 15, heartbeat by re-claiming; UI does so every 4 min). Every mutating UPDATE embeds the lock check so check+write is atomic; other investigators get `ALERT_LOCKED`, stale edits get `VERSION_CONFLICT`. Bulk resolve skips locked alerts and reports them. Admin takeover requires `force` plus a reason and is audited.
- **Comments / evidence**: append-only. Evidence (PNG, JPEG, PDF, text; `EVIDENCE_MAX_BYTES`, `EVIDENCE_MAX_FILES_PER_ALERT`) is type-sniffed from content, filename-sanitised, stored with SHA-256 and verified on download (mismatch → 500 + audit); served as attachment with `nosniff`.
- **Resolution**: structured reason; verdict false_positive / confirmed_fraud; loss / recovered / prevented amounts validated against the transaction amount; outcomes editable only on confirmed fraud. `GET /alerts/metrics?days=` reports false-positive rate, confirmed fraud, amounts, overdue, time-to-resolve.

Limitations: realtime events are published after commit, best effort (clients re-fetch on reconnect); comments/evidence cannot be deleted; the reason is required in the UI but optional server-side.
