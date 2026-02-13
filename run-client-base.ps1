# Запуск сборки базы клиентов. Ищет node/npm в типичных путях, если их нет в PATH.
$paths = @(
  "$env:ProgramFiles\nodejs\npm.cmd",
  "${env:ProgramFiles(x86)}\nodejs\npm.cmd",
  "$env:APPDATA\nvm\*\npm.cmd",
  "$env:LOCALAPPDATA\Programs\node\npm.cmd"
)
$npm = $null
foreach ($p in $paths) {
  $resolved = Resolve-Path $p -ErrorAction SilentlyContinue
  if ($resolved) { $npm = $resolved.Path; break }
}
if (-not $npm) {
  $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
}
if (-not $npm) {
  Write-Host "Node.js/npm не найден. Установи Node.js с https://nodejs.org или открой 'Node.js command prompt' и выполни: cd C:\bot; npm run client-base"
  exit 1
}
Set-Location $PSScriptRoot
& $npm run client-base
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
