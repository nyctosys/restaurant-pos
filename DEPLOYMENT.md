# Production deployment (Windows)

Steps to deploy nycto-pos on a **Windows production PC** with:

- **Backend** — Python app run as a Windows service via **NSSM**
- **Database** — **Postgres** in **Docker**
- **Frontend** — **Tauri** desktop app built with **Bun**

Project path used below: `C:\Users\SootShoot\Desktop\nycto-pos\nycto-pos` — adjust if yours differs.

---

## Upgrading from a running installation

Use this when the **old version is already running** on Windows and you want to introduce the new changes with minimal risk and downtime.

### Before you start

1. **Pick a quiet time** (e.g. no active sales) so a short backend restart is acceptable.
2. **Backup the database** (recommended):
   ```cmd
   docker exec nycto-pos-database-1 pg_dump -U postgres nycto_pos > C:\Users\SootShoot\Desktop\nycto_pos_backup.sql
   ```
   Replace `nycto-pos-database-1` with your actual Postgres container name from `docker ps` if different. Keep this file until the upgrade is verified.
3. **Optional:** Copy the current project folder to something like `nycto-pos-old` so you can revert code or NSSM path if needed.
4. **Keep `backend\.env`** — do not overwrite it when pulling new code. It already has `DATABASE_URL` and `SECRET_KEY`; only change if you intend to.

### Upgrade order (do in sequence)

| Order | Step | What to do | Why |
|-------|------|------------|-----|
| 1 | **Pull/copy new code** | Replace project files with the new version, but **keep** your existing `backend\.env` (and `frontend\.env.production` if you use it). | New code in place; your config preserved. |
| 2 | **DB migrations** | With Docker Postgres running, run the three migration scripts (see §3.3 below). They are idempotent (safe to run again). | Adds new columns/constraints; old backend keeps working. |
| 3 | **Backend only** | Activate venv, `pip install -r backend\requirements.txt`, then **restart NSSM** for the backend. | New backend runs against updated DB. |
| 4 | **Verify backend** | Open `http://localhost:5000/api/health` in a browser (or use curl). Confirm it returns 200. Log in via the **old** Tauri app if you want; it should still work. | Confirms backend is healthy before touching the app. |
| 5 | **Frontend (Tauri)** | In `frontend`: set `VITE_API_URL` in `.env.production` if needed, then `bun install` and `bun run tauri build`. | New app build uses new frontend and API URL. |
| 6 | **Switch to new app** | Close the old Tauri window. Run the new EXE from `frontend\src-tauri\target\release\` (or install from `bundle\` and open the installed app). Log in and do a quick check: dashboard, one sale, settings. | Users now on the new version. |

### Commands in one place (upgrade runbook)

```cmd
REM 1) Backup DB (use your container name from docker ps)
docker exec nycto-pos-database-1 pg_dump -U postgres nycto_pos > C:\backups\nycto_pos_backup.sql

REM 2) Go to project and run migrations (Docker must be up)
cd C:\Users\SootShoot\Desktop\nycto-pos\nycto-pos
backend\venv\Scripts\activate
pip install -r backend\requirements.txt
python -m backend.scripts.add_product_columns
python -m backend.scripts.add_sale_discount_columns
python -m backend.scripts.add_check_constraints

REM 3) Restart backend service
nssm restart "NyctoBackend"

REM 4) In a browser: open http://localhost:5000/api/health — must return 200

REM 5) Build new frontend (new terminal or after health check)
cd C:\Users\SootShoot\Desktop\nycto-pos\nycto-pos\frontend
bun install
bun run tauri build

REM 6) Close old app; run new: frontend\src-tauri\target\release\<YourAppName>.exe
```

### If something goes wrong

- **Backend won’t start or health fails:** Check NSSM logs (e.g. `nssm status "NyctoBackend"` and the log path configured in NSSM). Fix `.env` or dependencies; run migrations again if needed. Restart: `nssm restart "NyctoBackend"`.
- **DB errors after migrations:** Restore from backup:  
  `docker exec -i nycto-pos-database-1 psql -U postgres nycto_pos < C:\backups\nycto_pos_backup.sql`  
  Then fix the migration or code and retry.
- **Revert to old app:** Keep the old EXE or installer. Close the new app and run the old one. If you also need the old backend, point NSSM back to the old project path and restart the service.

### Summary

1. Backup DB and optionally the project folder.  
2. Update code but keep `backend\.env`.  
3. Run migrations → update backend deps → restart NSSM → verify health.  
4. Build Tauri app with Bun → close old app → run new app and test.

This order keeps the database and backend compatible at each step and avoids running a new frontend against an old backend (or vice versa) in a broken state.

---

## 1. Prerequisites

- **Python 3.10+** (backend)
- **Bun** (frontend: install from https://bun.sh)
- **Rust** + MSVC build tools (for Tauri; install via https://rustup.rs — Windows will prompt for Visual Studio Build Tools if needed)
- **Docker Desktop** (Postgres)
- **NSSM** (backend Windows service)

---

## 2. Database (Docker Postgres)

From the project root:

```cmd
cd C:\Users\SootShoot\Desktop\nycto-pos\nycto-pos
docker-compose up -d
```

To avoid old containers conflicting:

```cmd
docker-compose up -d --remove-orphans
```

Ensure Postgres is reachable from the host (e.g. `localhost:5432`). If you use a custom `docker\pg_hba.conf` that allows the host (e.g. `172.18.0.1`), keep that in place so the backend can connect.

---

## 3. Backend (NSSM)

### 3.1 Activate venv and install dependencies

```cmd
cd C:\Users\SootShoot\Desktop\nycto-pos\nycto-pos
backend\venv\Scripts\activate
pip install -r backend\requirements.txt
```

### 3.2 Environment

Create or edit `backend\.env`:

```env
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/nycto_pos
SECRET_KEY=your-production-secret-key
```

### 3.3 Run migration scripts (idempotent)

With venv still active, from project root:

```cmd
python -m backend.scripts.add_product_columns
python -m backend.scripts.add_sale_discount_columns
python -m backend.scripts.add_check_constraints
```

Or from `backend\`:

```cmd
cd backend
python scripts\add_product_columns.py
python scripts\add_sale_discount_columns.py
python scripts\add_check_constraints.py
```

### 3.4 Restart backend service (NSSM)

Use the exact service name you configured in NSSM (e.g. `NyctoBackend`):

```cmd
nssm restart "NyctoBackend"
```

Start/stop if needed:

```cmd
nssm start "NyctoBackend"
nssm stop "NyctoBackend"
```

---

## 4. Frontend (Tauri + Bun)

### 4.1 Set API URL for production

Create or edit `frontend\.env.production`:

```env
VITE_API_URL=http://localhost:5000/api
```

Use the URL where the backend is reachable from the PC (same machine: `http://localhost:5000/api` or your backend port).

### 4.2 Install dependencies with Bun

```cmd
cd C:\Users\SootShoot\Desktop\nycto-pos\nycto-pos\frontend
bun install
```

### 4.3 Build Tauri app

This runs the Vite build then the Tauri bundle (installer/EXE):

```cmd
bun run tauri build
```

- **Debug build (faster):** `bun run tauri build --debug`
- **Release build (default):** output is under `frontend\src-tauri\target\release\`
  - Executable: `frontend\src-tauri\target\release\Soot Shoot Retail POS.exe` (or the name in `tauri.conf.json`)
  - Installer (if enabled): in `frontend\src-tauri\target\release\bundle\` (e.g. MSI or NSIS)

### 4.4 Run the app

- **From repo:** run the `.exe` under `frontend\src-tauri\target\release\`
- **After installing:** use the installed app (Start Menu or desktop shortcut)

The Tauri app loads the built frontend from `frontend\dist` and talks to the backend using `VITE_API_URL`. Ensure the backend (NSSM) is running and reachable at that URL.

---

## 5. Post-deploy checks

1. **Backend health:** `GET http://localhost:5000/api/health` returns 200 (or your backend URL).
2. **Open the Tauri app:** log in and confirm dashboard, sales, inventory, and settings work.
3. **Backend logs:** check NSSM service logs or the backend process output for errors.

---

## 6. Optional: run tests before deploy

**Backend** (uses SQLite in-memory; does not touch production DB):

```cmd
cd C:\Users\SootShoot\Desktop\nycto-pos\nycto-pos
set DATABASE_URL=sqlite:///:memory:
backend\venv\Scripts\activate
pip install -r backend\requirements.txt
python -m pytest backend\tests -v
```

**Frontend:**

```cmd
cd frontend
bun run test:run
```

---

## Fresh start the database

Use this when you want to **wipe all data** and start with an empty DB (same schema, no products, sales, users, etc.).

### Option A: Reset tables (keep database and connection)

Backend must **not** be running (or stop the NSSM service first), then:

```cmd
cd C:\Users\SootShoot\Desktop\nycto-pos\nycto-pos
backend\venv\Scripts\activate
python -m backend.scripts.reset_db
```

Then start the backend again (e.g. `nssm start "NyctoBackend"`). Tables are recreated empty. You will need to run **Setup** in the app again (create first user).

### Option B: Full reset with Docker (delete Postgres data volume)

This removes the Docker volume so Postgres starts with a completely fresh data directory:

```cmd
cd C:\Users\SootShoot\Desktop\nycto-pos\nycto-pos
docker-compose down -v
docker-compose up -d
```

Then start the backend. On first request the app will run `db.create_all()` and create tables. Again, run **Setup** in the app to create the first user.

---

## 7. Summary checklist

| Step | Action |
|------|--------|
| 1 | `docker-compose up -d` (Postgres) |
| 2 | `backend\venv\Scripts\activate` → `pip install -r backend\requirements.txt` |
| 3 | Set `backend\.env` (DATABASE_URL, SECRET_KEY) |
| 4 | Run migration scripts: `add_product_columns`, `add_sale_discount_columns`, `add_check_constraints` |
| 5 | Restart NSSM backend service |
| 6 | Set `VITE_API_URL` in `frontend\.env.production` |
| 7 | In `frontend`: `bun install` then `bun run tauri build` |
| 8 | Run the built Tauri app and verify login + health |

---

## 8. Quick reference: your stack

| Component | How it runs |
|-----------|-------------|
| **Database** | Docker container (e.g. `docker-compose up -d`) |
| **Backend** | NSSM Windows service (Python, e.g. Flask on port 5000) |
| **Frontend** | Tauri desktop app (Bun for install/build; EXE/installer from `tauri build`) |
