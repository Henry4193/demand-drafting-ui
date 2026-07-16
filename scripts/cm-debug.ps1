# CM Action Router - calibration helper.
# Logs into the local app (reads creds from .env - never printed), calls the
# /api/cm-monitor/debug endpoint, saves the FULL result (with client names) to a
# Desktop file for you to read, and prints a PHI-SAFE summary you can share.
#
#   Routing only:            powershell -ExecutionPolicy Bypass -File scripts\cm-debug.ps1
#   Routing + classification: powershell -ExecutionPolicy Bypass -File scripts\cm-debug.ps1 -Classify

param([int]$Limit = 25, [switch]$Classify)

$envPath = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envPath)) { Write-Host "No .env found at $envPath" -ForegroundColor Red; exit 1 }
$lines = Get-Content $envPath

function Get-EnvVal($name) {
  $line = $lines | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  $v = ($line -replace "^\s*$name\s*=\s*", '').Trim()
  $v = $v -replace '^"','' -replace '"$',''
  $v = $v -replace "^'","" -replace "'$",''
  return $v
}

$user = Get-EnvVal 'APP_USERNAME'
$pass = Get-EnvVal 'APP_PASSWORD'
$port = Get-EnvVal 'PORT'; if (-not $port) { $port = '3100' }
$base = "http://localhost:$port"

if (-not $user -or -not $pass) { Write-Host "APP_USERNAME/APP_PASSWORD not found in .env" -ForegroundColor Red; exit 1 }

Write-Host "Logging in to $base ..."
$loginBody = @{ username = $user; password = $pass } | ConvertTo-Json
try {
  Invoke-WebRequest -Uri "$base/api/login" -Method Post -Body $loginBody -ContentType 'application/json' `
    -SessionVariable sess -UseBasicParsing | Out-Null
} catch {
  Write-Host "Login failed (is the server running? npm start): $($_.Exception.Message)" -ForegroundColor Red; exit 1
}

$uri = "$base/api/cm-monitor/debug?limit=$Limit"
if ($Classify) { $uri += "&classify=1" }
$note = if ($Classify) { "routing + classification" } else { "routing only" }
Write-Host "Calling debug ($note; first run builds the Filevine index, may take ~30-60s) ..."
try {
  # Invoke-WebRequest + explicit ConvertFrom-Json: PS 5.1's Invoke-RestMethod can
  # return a JSON array as ONE nested object, which breaks per-row access.
  $resp = Invoke-WebRequest -Uri $uri -WebSession $sess -UseBasicParsing
  $parsed = ConvertFrom-Json $resp.Content
  $data = @($parsed)
} catch {
  Write-Host "Debug call failed: $($_.Exception.Message)" -ForegroundColor Red; exit 1
}

# Full detail (INCLUDES client names / subjects - PHI) -> local file for you only.
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'cm-debug-output.json'
$data | ConvertTo-Json -Depth 6 | Out-File -FilePath $out -Encoding utf8

# PHI-safe summary -> console (counts + staff names + case numbers only; no client names/subjects).
$total     = $data.Count
$withFile  = @($data | Where-Object { $_.fileNumber }).Count
$withProj  = @($data | Where-Object { $_.projectId }).Count
$withPoc   = @($data | Where-Object { $_.poc }).Count
$routed    = @($data | Where-Object { $_.routed }).Count
$actionReq = @($data | Where-Object { $_.classification -eq 'action_required' }).Count
$wouldGo   = @($data | Where-Object { $_.wouldRoute }).Count

Write-Host ""
Write-Host "===== CM routing summary (safe to share) =====" -ForegroundColor Cyan
Write-Host "emails examined       : $total"
Write-Host "file # parsed         : $withFile"
Write-Host "project resolved      : $withProj"
Write-Host "POC extracted         : $withPoc"
Write-Host "routing chain worked  : $routed"
if ($Classify) {
  $toIntake = @($data | Where-Object { $_.dest -eq 'intake' }).Count
  $toHenry  = @($data | Where-Object { $_.dest -eq 'henry-review' }).Count
  Write-Host "classified action_req : $actionReq"
  Write-Host "WOULD post in prod    : $wouldGo   ($toIntake to intakes, $toHenry to Henry-review)"
}
Write-Host ""
Write-Host "per-email (classification / file# / intake / would-post - no client names):"
$i = 0
foreach ($r in $data) {
  $i++
  $c = if ($r.classification) { $r.classification } else { 'n/a' }
  $f = if ($r.fileNumber) { $r.fileNumber } else { '-' }
  $n = if ($r.intake) { $r.intake } else { '-' }
  $x = if ($r.note) { "  <$($r.note)>" } else { '' }
  $d = if ($r.wouldRoute -and $r.dest) { " -> $($r.dest)" } else { '' }
  Write-Host ("  {0,2}. [{1,-14}] file={2,-6} intake={3,-16} wouldPost={4}{5}{6}" -f $i, $c, $f, $n, $r.wouldRoute, $d, $x)
}
Write-Host ""
Write-Host "Full detail (with subjects + client names) saved for YOUR eyes only at:" -ForegroundColor Yellow
Write-Host "  $out"
Write-Host "==============================================" -ForegroundColor Cyan
