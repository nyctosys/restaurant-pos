param(
  [switch]$ApplyMigrations,
  [switch]$SkipHttp,
  [string]$BaseUrl,
  [int]$DbTimeout
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

$ArgsList = @("backend/scripts/verify_production.py")
if ($ApplyMigrations) {
  $ArgsList += "--apply-migrations"
}
if ($SkipHttp) {
  $ArgsList += "--skip-http"
}
if ($BaseUrl) {
  $ArgsList += "--base-url"
  $ArgsList += $BaseUrl
}
if ($DbTimeout) {
  $ArgsList += "--db-timeout"
  $ArgsList += "$DbTimeout"
}

python @ArgsList
