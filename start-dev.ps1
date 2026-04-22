Write-Host "Starting Restaurant POS Project..." -ForegroundColor Green

Write-Host "1. Starting PostgreSQL Database (Docker)..." -ForegroundColor Cyan
docker-compose up -d

# Wait a few seconds to let DB initialize
Start-Sleep -Seconds 3

Write-Host "2. Starting Backend Service..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit -Title 'POS Backend' -Command `"cd backend; python run.py`""

Write-Host "3. Starting Frontend App..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit -Title 'POS Frontend' -Command `"cd frontend; npm run tauri:dev`""

Write-Host "All services have been launched in new windows!" -ForegroundColor Green
