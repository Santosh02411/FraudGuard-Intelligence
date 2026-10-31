# FraudGuard interactive demo (`fraudguard-demo.html`)

Two ways to use it: open `fraudguard-demo.html` directly, or click **Try demo** on the app's sign-in screen (the app serves the same
file at `/demo/`, with an _Exit demo_ link back to sign-in).

A single self-contained HTML file: open it in a browser, no server or install. Everything runs on synthetic data in
the page. It is the original demo plus an **AI Memory** page (admin only, under _Investigate_).

## AI Memory in the demo

Two modes, same screens:

| Mode                  | What runs                                                                                                                                                                                  | What is _not_ the real thing                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Offline (default)** | An in-browser engine with the same record projection, pseudonymisation (HMAC-SHA256), SHA-256 content-hash dedup, cursor, typed graph and "suspicious device" rule as the real integration | Retrieval is TF-IDF cosine instead of Cognee embeddings; there is **no LLM**, so the assistant's third section is derived by deterministic rules from the graph and is labelled **COMPUTED (NO LLM)**, never "AI-generated" |
| **Live (optional)**   | The same screens call a real backend's `/api/v1/cognee-memory/*` (real Cognee, real LLM if configured)                                                                                     | Nothing - this is the real product                                                                                                                                                                                          |

Things to try offline: **Sync now** → resolve an alert or submit a transaction in the Simulator → **Sync now** again
(only the changed record is re-sent) → tick _Simulate a Cognee outage_, sync (fails; nothing is lost) → untick and
sync (it catches up) → _Search history_ → _Assistant_ on a high-risk transaction → _Entities & graph_ → Devices →
_Suspicious only_.

### Connecting the live mode

_Connect live backend (optional)_ asks for the API URL and a short-lived **admin** access token. The token is held in
memory only (never stored) and sent only to that URL. The backend must allow the page's origin in
`CORS_ALLOWED_ORIGINS`, so serve the file over http (`python -m http.server 3100` in this folder, then open
`http://localhost:3100/fraudguard-demo.html`) rather than `file://`. When connected, a banner says so and the
"nothing leaves your browser" statement no longer applies.

## Layout and tests

```
fraudguard-demo.html        built file (what you open)
fraudguard-demo.base.html   the original demo, unchanged
src/memory_engine.js        offline engine + API facade (offline OR live)
src/memory_ui.js            AI Memory screens and actions
build_demo.py               python build_demo.py  ->  base + src/*  =>  fraudguard-demo.html (idempotent)
test/                       jsdom tests (jsdom comes from ../frontend: run `npm ci` there first)
```

```bash
python build_demo.py        # writes demo/fraudguard-demo.html AND ../frontend/public/demo/index.html
node test/demo.test.js      # 18 checks: SHA-256/HMAC vs Node crypto, sync/dedup/outage, privacy, search, graph, assistant, RBAC, UI
node test/regress.js        # every original page still renders; exactly one nav item was added
# optional, needs a running backend with Cognee configured:
FG_LIVE_API=http://localhost:5000/api/v1 FG_LIVE_USER=admin FG_LIVE_PASS=... node test/live.test.js
```

These tests drive the page's real scripts in jsdom (DOM + behaviour). They do not check visual layout - open the file in
a browser to judge that.
