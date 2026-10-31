# 🛡️ FraudGuard

**An intelligent fraud detection platform** built with a React frontend, Node.js/Express backend, SQLite database, and Python-based machine learning service.

FraudGuard combines machine learning and rule-based fraud detection to identify suspicious transactions, investigate potential threats, and visualize fraud patterns.

It also includes an optional **AI Memory powered by Cognee** for contextual fraud intelligence and historical investigation.

> **Try it instantly:** Use the built-in **Try demo** button to explore FraudGuard without installing dependencies, creating an account, or starting the backend.

---

## ✨ Features

- **Fraud Detection:** Identify suspicious transactions using machine learning and rule-based scoring.
- **Interactive Dashboard:** Monitor transaction activity, fraud alerts, risk levels, and analytics.
- **User Authentication:** Role-based access with admin and demo-user accounts.
- **Transaction Management:** Review and investigate transaction records.
- **Machine Learning Service:** Python-based fraud prediction using the included trained model.
- **AI Memory (Optional):** Cognee-powered contextual search and fraud intelligence.
- **Demo Mode:** Explore the application instantly using browser-based sample data.
- **API Integration:** React frontend communicates with the Express backend and optional ML service.

---

## 🧰 Technology Stack

| Component | Technologies |
|---|---|
| Frontend | React, JavaScript, CSS |
| Backend | Node.js, Express.js |
| Database | SQLite |
| Machine Learning | Python, scikit-learn, XGBoost |
| ML API | FastAPI, Uvicorn |
| AI Memory (Optional) | Cognee |
| Development Tools | npm, Git, Python |

---

## 📋 Prerequisites

Install the following before running the application:

- Node.js 18 or later
- npm 9 or later
- Python 3.10 or later

**Optional:** An LLM API key is required for AI-generated suggestions in the Cognee service.

---

## 🚀 Quick Start

The following instructions assume you have extracted the FraudGuard project ZIP file and opened a terminal in the project root directory.

**Important:**
- Run each command separately and press Enter.
- Open a new terminal for each numbered step.
- Keep the backend and frontend terminals running while using the application.
- The ML service and Cognee service are optional.

### ✅ Verify You Are Running Build v3

Open:

`http://localhost:3100`

The sign-in page should display:

- A **Try demo** button below the Sign In section.
- A footer displaying **FraudGuard build v3**.
- A green **Backend connected** status.

After signing in, you should see a left sidebar with grouped navigation menus.

If these elements are missing, you may be running an older version. Extract the latest v3 ZIP into a new folder and follow the setup instructions again.

---

### 1. Start the ML Service (Optional)

FraudGuard includes a trained model, so you do not need to train one manually.

The application can use its built-in rule-based engine when the ML service is unavailable.

**Windows (PowerShell)**

Open a new terminal in the project root:

```powershell
cd ml_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:ML_AUTH_DISABLED = "true"
python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

If PowerShell blocks script execution, run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Then activate the virtual environment again.

**macOS / Linux**

Open a new terminal in the project root:

```bash
cd ml_service
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export ML_AUTH_DISABLED=true
python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

**Verify the service**

Open:

`http://127.0.0.1:8001/health`

Expected response:

```json
{
  "status": "ok"
}
```

Keep this terminal running.

When the service is available, the application should display a green **ML service ok** status.

---

### 2. Start the Backend

Open another terminal in the project root.

**Windows (PowerShell)**

```powershell
cd backend
npm install
```

Create your local environment file:

```powershell
Copy-Item .env.example .env
```

Start the backend:

```powershell
npm start
```

**macOS / Linux**

```bash
cd backend
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

Start the backend:

```bash
npm start
```

The provided `.env.example` contains the default development configuration. You can edit `.env` if you need to change settings.

**Expected startup message:**

```text
FraudGuard backend started {"port":5000}
```

**Verify the backend**

Open:

`http://localhost:5000/api/v1/health`

Expected response should indicate:

```json
{
  "status": "ok"
}
```

Keep this terminal running.

---

### 3. Load Sample Data (Optional, Recommended)

Sample data helps populate the dashboard with transactions, users, and fraud-related activity.

Open another terminal:

**Windows (PowerShell) and macOS/Linux**

```bash
cd backend
npm run seed
```

For a larger dataset:

```bash
npm run seed -- --users=20 --days=90
```

**Recommendation:** Start the ML service before running the seed command. This allows the sample transactions to be evaluated by the ML service when available.

The application can still run without the ML service.

---

### 4. Start the Frontend

Open another terminal in the project root.

**Windows (PowerShell), macOS, and Linux**

```bash
cd frontend
npm install
npm start
```

The application should open automatically at:

`http://localhost:3100`

The first installation may take approximately 2–5 minutes, depending on your internet connection and system.

---

## 🔐 Login Credentials

Use the following credentials for local development:

| Account | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Seeded demo users | Displayed in seed output | `demo1234` |

Alternatively, click **Try demo** on the sign-in page.

You can also open:

`http://localhost:3100/demo/`

The demo runs directly in the browser using sample data. It does not require a backend, account, or database and does not save changes.

> **Security:** These are development/demo credentials. Change the default admin password and configure secure secrets before using FraudGuard in any shared or production environment.

---

## 🧠 Optional: AI Memory with Cognee

FraudGuard supports an optional Cognee service for AI-powered fraud intelligence and contextual memory.

This service runs independently from the main backend.

### 1. Start the Cognee Service

Open a new terminal in the project root.

**Windows (PowerShell)**

```powershell
cd cognee_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Set the required environment variables:

```powershell
$env:COGNEE_SERVICE_API_KEY = "your-random-secret-key"
$env:LLM_API_KEY = "your-llm-api-key"
```

Start the service:

```powershell
python -m uvicorn app.main:app_factory --factory --host 127.0.0.1 --port 8002 --workers 1
```

**macOS / Linux**

```bash
cd cognee_service
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Set the required environment variables:

```bash
export COGNEE_SERVICE_API_KEY="your-random-secret-key"
export LLM_API_KEY="your-llm-api-key"
```

Start the service:

```bash
python -m uvicorn app.main:app_factory --factory --host 127.0.0.1 --port 8002 --workers 1
```

### 2. Configure the Backend

Open `backend/.env` and add:

```env
COGNEE_SERVICE_URL=http://127.0.0.1:8002
COGNEE_SERVICE_API_KEY=your-random-secret-key
COGNEE_PSEUDONYM_SECRET=another-random-secret-key
```

Use the same `COGNEE_SERVICE_API_KEY` value in both services.

Generate strong, unique secret values instead of using the example placeholders.

Restart the backend after updating its environment variables.

### 3. Sync Fraud Intelligence

1. Start the frontend, backend, and Cognee service.
2. Log in using the admin account.
3. Open **AI Memory** from the sidebar.
4. Select **Sync now**.
5. Wait for the synchronization process to complete.

**Notes:**

- The first startup may take longer because the embedding model loads in the background.
- If the service displays **Still starting**, wait a minute and check again.
- Without an `LLM_API_KEY`, supported graph and search functionality may still work, but AI-generated suggestions will be unavailable.

---

## 🧪 Running Tests

Run each test suite separately from the project root.

### Backend Tests

```bash
cd backend
npm install
npm test
```

### Frontend Tests

```bash
cd frontend
npm install
npm run test:ci
```

### Cognee Service Tests

**Windows (PowerShell)**

```powershell
cd cognee_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pip install -r requirements-dev.txt
python -m pytest
```

**macOS / Linux**

```bash
cd cognee_service
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip install -r requirements-dev.txt
python -m pytest
```

---

## 🔄 Reset Everything

To reset the local database:

1. Stop the backend using `Ctrl + C`.
2. Open a terminal in the project root.
3. Delete the database file.

**Windows (PowerShell)**

```powershell
Remove-Item .\backend\fraudguard.db
```

**macOS / Linux**

```bash
rm ./backend/fraudguard.db
```

4. Start the backend again.
5. Run the sample-data seed command if you want to repopulate the database.

If the browser still shows an old login session, the application should validate it with the backend and sign you out if the session is no longer valid.

---

## 🛠️ Troubleshooting

| Problem | Possible Solution |
|---|---|
| **Backend not reachable** | Start the backend and verify `http://localhost:5000/api/v1/health`. |
| **Cannot reach the server during sign-in** | Check that the backend is running and that the frontend is using the correct backend URL. |
| **Page blinks or reloads repeatedly** | Confirm that you are running build v3. If necessary, open browser DevTools → Application → Storage → Clear site data, then reload. |
| **Try demo button is missing** | You may be running an older project copy. Extract the v3 ZIP into a new folder. |
| **Sidebar is missing** | Verify that the frontend is running the correct v3 build. |
| **ModuleNotFoundError** | Activate the appropriate Python virtual environment and install the corresponding `requirements.txt`. |
| **PowerShell blocks Activate.ps1** | Run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`, then activate the environment again. |
| **Frontend: allowedHosts[0] should be a non-empty string** | Check that `frontend/.env.development` is present. If the issue persists, try `$env:DANGEROUSLY_DISABLE_HOST_CHECK="true"` before `npm start` in your development environment. |
| **Port 5000 or 3100 is already in use** | Stop the process using the port or configure the application to use another available port. |
| **Port 8001 or 8002 is already in use** | Stop the existing ML/Cognee process or select another port and update the corresponding service URL. |
| **Dashboard is empty** | Run `npm run seed` from the backend directory or use the Try demo option. |
| **ML service down** | The ML service is optional. Start it on port 8001 or continue using the rule-based engine. |
| **Invalid credentials** | Use the local development credentials listed above or reset the database if appropriate. |
| **Foreign key constraint failed during database reset** | Stop the backend, follow the reset instructions, and seed the database again. |

### Check Which Process Uses a Port

**Windows (PowerShell)**

For port 5000:

```powershell
netstat -ano | findstr :5000
```

For port 3100:

```powershell
netstat -ano | findstr :3100
```

Stop a process using its PID:

```powershell
taskkill /PID <PID> /F
```

**macOS / Linux**

For port 5000:

```bash
lsof -i :5000
```

For port 3100:

```bash
lsof -i :3100
```

---

## 📁 Project Documentation

Additional technical documentation is available in the `docs/` directory.

| File | Description |
|---|---|
| `docs/FULL_README.md` | Detailed project documentation and architecture |
| `docs/openapi.yaml` | API specification |
| `docs/METHODOLOGY.md` | Fraud detection methodology |
| `docs/TESTING.md` | Testing documentation |

Refer to these files for additional implementation details and technical information.

---

## 🔒 Security Notes

- Never commit `.env` files, API keys, passwords, or private credentials.
- Keep local virtual environments and dependency folders out of version control.
- Use strong, unique secrets for authentication and service-to-service communication.
- Change default development credentials before deployment.
- Do not expose development-only authentication settings in production.
- Configure HTTPS, CORS, and production environment variables before public deployment.

---

## 👨‍💻 Development

To contribute or modify FraudGuard:

1. Fork or clone the repository.
2. Create a separate feature branch.
3. Install the frontend, backend, and Python dependencies as required.
4. Make your changes and run the relevant tests.
5. Submit a pull request with a clear description of your changes.

---

**FraudGuard — Detect suspicious activity. Understand fraud patterns. Make smarter decisions.**
