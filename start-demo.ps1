# RAG-Debugger Demo Deployment Script
# Builds frontend and runs combined server with ngrok

Write-Host "RAG-Debugger Demo Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check prerequisites
Write-Host "Checking prerequisites..." -ForegroundColor Yellow

$ngrokExists = Get-Command ngrok -ErrorAction SilentlyContinue
if (!$ngrokExists) {
    Write-Host "ERROR: ngrok is not installed!" -ForegroundColor Red
    Write-Host "Install from: https://ngrok.com/download" -ForegroundColor Gray
    exit 1
}
Write-Host "  OK: ngrok found" -ForegroundColor Green

$venvExists = Test-Path ".\venv\Scripts\Activate.ps1"
if (!$venvExists) {
    Write-Host "ERROR: Python virtual environment not found!" -ForegroundColor Red
    exit 1
}
Write-Host "  OK: Python venv found" -ForegroundColor Green

$nodeModulesExist = Test-Path ".\frontend\node_modules"
if (!$nodeModulesExist) {
    Write-Host "ERROR: Frontend dependencies not installed!" -ForegroundColor Red
    Write-Host "Run: cd frontend; npm install" -ForegroundColor Gray
    exit 1
}
Write-Host "  OK: Node modules found" -ForegroundColor Green
Write-Host ""

# Step 1: Build the frontend
Write-Host "Step 1: Building React frontend..." -ForegroundColor Cyan
Push-Location ".\frontend"
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Frontend build failed!" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location
Write-Host "  OK: Frontend built" -ForegroundColor Green
Write-Host ""

# Step 2: Start the demo server
Write-Host "Step 2: Starting demo server on port 8000..." -ForegroundColor Cyan

$pwd = Get-Location
$serverJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    & .\venv\Scripts\Activate.ps1
    python -m uvicorn main_demo:app --host 0.0.0.0 --port 8000
} -ArgumentList $pwd

Write-Host "  Waiting for server to start..." -ForegroundColor Gray
Start-Sleep -Seconds 8

$serverRunning = $false
for ($i = 1; $i -le 10; $i++) {
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:8000/collections" -TimeoutSec 2 -ErrorAction Stop
        $serverRunning = $true
        break
    } catch {
        if ($i -eq 10) {
            Write-Host "  WARNING: Health check failed, but server may still be running..." -ForegroundColor Yellow
            Write-Host "  Check manually at http://localhost:8000" -ForegroundColor Yellow
            $serverRunning = $true
        }
        Start-Sleep -Seconds 1
    }
}

if (!$serverRunning) {
    Write-Host "ERROR: Server failed to start!" -ForegroundColor Red
    Receive-Job -Job $serverJob
    Stop-Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "  OK: Server running" -ForegroundColor Green
Write-Host ""

# Step 3: Start ngrok tunnel
Write-Host "Step 3: Creating ngrok tunnel..." -ForegroundColor Cyan

$ngrokJob = Start-Job -ScriptBlock {
    ngrok http 8000 --log=stdout
}

Start-Sleep -Seconds 5

$publicUrl = ""
try {
    $response = Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -ErrorAction Stop
    $publicUrl = $response.tunnels[0].public_url
} catch {
    Write-Host "ERROR: Failed to get ngrok URL!" -ForegroundColor Red
    Write-Host "Check ngrok dashboard: http://localhost:4040" -ForegroundColor Gray
    Stop-Job $serverJob,$ngrokJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob,$ngrokJob -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "  OK: Tunnel created" -ForegroundColor Green
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "RAG-Debugger is now LIVE!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Public URL: $publicUrl" -ForegroundColor Yellow
Write-Host ""
Write-Host "ngrok dashboard: http://localhost:4040" -ForegroundColor Cyan
Write-Host "Local access: http://localhost:8000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Share the public URL with others!" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop all services" -ForegroundColor Yellow
Write-Host ""

try {
    while ($true) {
        Start-Sleep -Seconds 2
        
        $sJob = Get-Job -Id $serverJob.Id -ErrorAction SilentlyContinue
        $nJob = Get-Job -Id $ngrokJob.Id -ErrorAction SilentlyContinue
        
        if ($sJob -and $sJob.State -eq 'Failed') {
            Write-Host "ERROR: Server crashed!" -ForegroundColor Red
            Receive-Job -Id $serverJob.Id
            break
        }
        
        if ($nJob -and $nJob.State -eq 'Failed') {
            Write-Host "ERROR: ngrok tunnel failed!" -ForegroundColor Red
            break
        }
    }
} finally {
    Write-Host ""
    Write-Host "Shutting down..." -ForegroundColor Yellow
    Stop-Job $serverJob,$ngrokJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob,$ngrokJob -Force -ErrorAction SilentlyContinue
    Write-Host "All services stopped" -ForegroundColor Green
}
