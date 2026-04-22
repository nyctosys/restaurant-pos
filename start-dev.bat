@echo off
echo Starting Restaurant POS Project...

echo 1. Starting PostgreSQL Database (Docker)...
docker-compose up -d

timeout /t 3 /nobreak >nul

echo 2. Starting Backend Service...
cd backend
start "POS Backend" cmd /k "python run.py"
cd ..

echo 3. Starting Frontend App...
cd frontend
start "POS Frontend" cmd /k "npm run tauri:dev"
cd ..

echo All services have been launched in new windows!
pause
