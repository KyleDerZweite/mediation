$ErrorActionPreference = 'Stop'
$mediationUrl = if ($env:MEDIATION_URL) { $env:MEDIATION_URL.TrimEnd('/') } else { '__MEDIATION_URL__' }
if ($mediationUrl -like '*__MEDIATION_URL__*') {
  throw 'Fetch install.ps1 from your Mediation server or set MEDIATION_URL.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20 or newer is required.'
}
$major = [int]((& node -p "process.versions.node.split('.')[0]"))
if ($major -lt 20) { throw 'Node.js 20 or newer is required.' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("mediation-installer-{0}.mjs" -f [guid]::NewGuid())
try {
  Invoke-WebRequest "$mediationUrl/install/mediation-installer.mjs" -OutFile $temp
  & node $temp install --server $mediationUrl @args
  if ($LASTEXITCODE -ne 0) { throw "Mediation installer exited with $LASTEXITCODE." }
} finally {
  Remove-Item $temp -Force -ErrorAction SilentlyContinue
}
