# 🛡️ FraudGuard

Fraud detection app: React frontend + Node/Express backend (SQLite) + Python ML service.
Optional: AI Memory (Cognee). Includes a **Try demo** button that needs no setup.

**You need:** Node 18+, npm 9+, Python 3.10+.

> Run **one command per line** and press Enter after each. Open a **new terminal** for each numbered step.

### ✅ Make sure you are running THIS version (build v3)

Open http://localhost:3100. The sign-in page must show **a "Try demo" button** under _Sign In_, and a footer saying
**"FraudGuard build v3"** plus **"Backend connected"** (green). After signing in you get a **left sidebar** with grouped menus.
If you don't see these, you are running an older copy: unzip the v3 ZIP into a **new** folder and start again from step 1.

---

## Quick start

### 1) ML service (optional — without it the app uses the rule engine)

A trained model is already included. No training needed.

**Windows (PowerShell)**

```powershell
cd ml_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:ML_AUTH_DISABLED = "true"
python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

**macOS / Linux**

```bash
cd ml_service
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
ML_AUTH_DISABLED=true 
python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

Check: http://127.0.0.1:8001/health → `{"status":"ok"}`. Leave it running.
(When it is up, the top bar of the app shows a green **ML service ok**.)

### 2) Backend

**Windows (PowerShell)**

```powershell
cd backend
npm install
copy .env.example .env
npm start
```

**macOS / Linux**

```bash
cd backend
npm install
cp .env.example .env
npm start
```

Success looks like: `FraudGuard backend started {"port":5000}`.
Check: http://localhost:5000/api/v1/health → `"status":"ok"`. Leave it running.
(`.env.example` works as it is; you only edit `.env` to change settings.)

### 3) Sample data (optional, recommended)

```bash
cd backend
npm run seed
```

Start the ML service (step 1) **before** seeding, otherwise few transactions get flagged and the dashboard looks quiet.
More data: `npm run seed -- --users=20 --days=90`.

### 4) Frontend

```bash
cd frontend
npm install
npm start
```

Opens http://localhost:3100 (first install takes 2–5 min).

---

## Logins

| Who                           | Username                 | Password   |
| ----------------------------- | ------------------------ | ---------- |
| Admin (created automatically) | `admin`                  | `admin123` |
| Seeded demo users             | shown in the seed output | `demo1234` |

Or click **Try demo** on the sign-in page (or open http://localhost:3100/demo/): runs in the browser on sample data,
needs no backend/account, saves nothing.

## Reset everything

Stop the backend (Ctrl+C), delete the database, start again:

```powershell
Remove-Item backend\fraudguard.db
```

```bash
rm backend/fraudguard.db
```

If the browser still thinks you are signed in, nothing breaks: the app checks the saved login with the server, signs you
out once and shows "Your session expired".

## Run the tests

```bash
cd backend && npm test
cd frontend && npm run test:ci
cd cognee_service && pip install -r requirements-dev.txt && pytest
```

---

## Optional: AI Memory (Cognee)

Needs its own service. In a new terminal:

**Windows (PowerShell)**

```powershell
cd cognee_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:COGNEE_SERVICE_API_KEY = "put-a-random-32-or-more-characters-here"
$env:LLM_API_KEY = "your-llm-key"
python -m uvicorn app.main:app_factory --factory --host 127.0.0.1 --port 8002 --workers 1
```

**macOS / Linux**

```bash
cd cognee_service
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export COGNEE_SERVICE_API_KEY="put-a-random-32-or-more-characters-here"
export LLM_API_KEY="your-llm-key"
python -m uvicorn app.main:app_factory --factory --host 127.0.0.1 --port 8002 --workers 1
```

Then add to `backend/.env` and restart the backend:

```
COGNEE_SERVICE_URL=http://127.0.0.1:8002
COGNEE_SERVICE_API_KEY=<same value as above>
COGNEE_PSEUDONYM_SECRET=<another random value, 16+ characters>
```

Log in as admin → **AI Memory** → **Sync now**.

- The first start loads an embedding model in the background; until ready you may see "still starting". Wait a minute.
- With no `LLM_API_KEY` the graph and search still work; the AI suggestions are off.

---

## Troubleshooting

| Problem                                                                                     | Fix                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in page says **"Backend not reachable"**, or sign-in says "Cannot reach the server"    | The backend isn't running. Open a terminal in `backend/` and run `npm start` (step 2). Check http://localhost:5000/api/v1/health                                                                                                                            |
| Page blinks / reloads, or you can't sign in after resetting the database or changing `.env` | Fixed in v3 (stale saved logins used to cause a burst of page reloads). Make sure the footer says **build v3**. If it does not, you are on an old copy. One-time cleanup: browser DevTools (F12) → Application → Storage → **Clear site data**, then reload |
| No **Try demo** button, no sidebar                                                          | You are running an older copy. Use the v3 ZIP in a new folder (see the box at the top)                                                                                                                                                                      |
| `can't open file '...train_model.pyc:\...\activate'`                                        | Two commands were pasted on one line. Run each on its own line                                                                                                                                                                                              |
| `ModuleNotFoundError` (pandas, shap, fastapi…)                                              | Activate the venv and use `python -m pip install -r requirements.txt` and `python -m uvicorn ...`                                                                                                                                                           |
| PowerShell blocks `Activate.ps1`                                                            | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`                                                                                                                                                                                                |
| Frontend: `allowedHosts[0] should be a non-empty string`                                    | v3 includes `frontend/.env.development` that prevents it. If you still see it: PowerShell `$env:DANGEROUSLY_DISABLE_HOST_CHECK="true"` then `npm start`                                                                                                     |
| Port 5000/3100 already in use                                                               | Windows: `netstat -ano \| findstr :5000` then `taskkill /PID <PID> /F`. Mac/Linux: `lsof -ti:5000 \| xargs kill`. If the frontend moves to another port, add that origin to `CORS_ALLOWED_ORIGINS` in `backend/.env`                                        |
| `npm run seed:reset` → `FOREIGN KEY constraint failed`                                      | Happens after a seeded user has logged in. Use "Reset everything" above, then `npm run seed`                                                                                                                                                                |
| "Invalid credentials"                                                                       | Use `admin` / `admin123`, or reset the database                                                                                                                                                                                                             |
| Dashboard empty                                                                             | Run step 3, or use **Try demo**                                                                                                                                                                                                                             |
| Top bar says **ML service down**                                                            | Optional. Start step 1, or ignore it: the app scores with the rule engine                                                                                                                                                                                   |

---

## More detail

The original long README (architecture, API reference, security, deployment) is kept in `docs/FULL_README.md`;
other notes are in `docs/` (`openapi.yaml`, `METHODOLOGY.md`, `TESTING.md`, ...).
#   F r a u d G u a r d - I n t e l l i g e n c e  
 #   F r a u d G u a r d - I n t e l l i g e n c e  
 