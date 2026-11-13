param(
  [string]$ConfigPath = "$PSScriptRoot\config.json"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ConfigPath)) {
  Write-Host "[FAIL] Missing $ConfigPath. Copy config.example.json to config.json and fill in all required fields." -ForegroundColor Red
  exit 1
}

$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json

foreach ($field in @("worker_url", "room_id", "gateway_ip")) {
  $val = [string]($cfg.$field)
  if ([string]::IsNullOrWhiteSpace($val) -or $val -match "<.*>") {
    Write-Host "[FAIL] Missing or placeholder '$field' in $ConfigPath." -ForegroundColor Red
    exit 1
  }
}

$worker = $cfg.worker_url.TrimEnd("/")
$room = $cfg.room_id.Trim()
$gwIp = $cfg.gateway_ip.Trim()

Write-Host "[1/2] Checking WireGuard tunnel..."
if (-not (Test-Connection -ComputerName $gwIp -Count 1 -Quiet -ErrorAction SilentlyContinue)) {
  Write-Host "[FAIL] WireGuard gateway is unreachable. Activate your tunnel in WireGuard first." -ForegroundColor Red
  exit 1
}
Write-Host "      OK: WireGuard gateway reachable." -ForegroundColor Green

Write-Host "[2/2] Checking telemetry hub & forwarder..."
try {
  $status = Invoke-RestMethod -Uri "$worker/room/$room/status" -TimeoutSec 8
} catch {
  Write-Host "[FAIL] Telemetry hub unreachable: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

if (-not $status.ok -or -not $status.ingester) {
  Write-Host "[FAIL] Forwarder is NOT connected to room '$room'. Start wg-forwarder on your endpoint first." -ForegroundColor Red
  exit 1
}
Write-Host "      OK: Hub + forwarder active." -ForegroundColor Green
Write-Host "All checks passed — you may now launch the game normally." -ForegroundColor Cyan
exit 0
