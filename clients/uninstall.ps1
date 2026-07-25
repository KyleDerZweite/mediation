$ErrorActionPreference = 'Stop'
$root = if ($env:MEDIATION_HOME) {
  $env:MEDIATION_HOME
} else {
  $appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME 'AppData\Roaming' }
  Join-Path $appData 'Mediation'
}
$helper = Join-Path $root 'mediation-installer.mjs'
if (Test-Path $helper -PathType Leaf) {
  & node $helper --uninstall @args
  if ($LASTEXITCODE -ne 0) { throw "Mediation uninstaller exited with $LASTEXITCODE." }
  exit
}
$legacyRoot = Join-Path $HOME '.local\share\mediation'
if (Test-Path (Join-Path $legacyRoot 'mediation-mcp.mjs') -PathType Leaf) {
  $root = $legacyRoot
}

# Pre-Alpha fallback. Only remove exact marker blocks and entries pointing at
# the legacy shared client.
$client = Join-Path $root 'mediation-mcp.mjs'
function Remove-MarkerBlock($file, $begin, $end) {
  if (-not (Test-Path $file -PathType Leaf)) { return }
  $text = Get-Content $file -Raw
  if (($text.Split($begin).Count - 1) -ne 1 -or ($text.Split($end).Count - 1) -ne 1) { return }
  $pattern = '(?s)\s*' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end) + '\s*'
  [IO.File]::WriteAllText($file, ([regex]::Replace($text, $pattern, "`r`n").Trim() + "`r`n"))
}
function Remove-MediationSkill($dir) {
  $skill = Join-Path $dir 'SKILL.md'
  if ((Test-Path $skill -PathType Leaf) -and ((Get-Content $skill -Raw) -match '(?m)^name:\s*mediation\s*$')) {
    Remove-Item $skill -Force
    Remove-Item $dir -Force -ErrorAction SilentlyContinue
  }
}
function Remove-MediationJson($file) {
  if (-not (Test-Path $file -PathType Leaf)) { return }
  try { $value = Get-Content $file -Raw | ConvertFrom-Json } catch { return }
  $entry = $value.mcpServers.mediation
  if ($entry -and $entry.command -eq 'node' -and $entry.args[0] -eq $client) {
    $value.mcpServers.PSObject.Properties.Remove('mediation')
    [IO.File]::WriteAllText($file, (($value | ConvertTo-Json -Depth 20) + "`r`n"))
  }
}
if (Get-Command claude -ErrorAction SilentlyContinue) {
  $entry = (& claude mcp get mediation 2>&1 | Out-String)
  if ($entry.Contains($client)) { & claude mcp remove --scope user mediation | Out-Null }
}
Remove-MediationSkill (Join-Path $HOME '.claude\skills\mediation')
$codex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
Remove-MarkerBlock (Join-Path $codex 'config.toml') '# >>> mediation >>>' '# <<< mediation <<<'
Remove-MarkerBlock (Join-Path $codex 'AGENTS.md') '<!-- >>> mediation >>> -->' '<!-- <<< mediation <<< -->'
$kimiDirs = @(
  $(if ($env:KIMI_CODE_HOME) { $env:KIMI_CODE_HOME } else { Join-Path $HOME '.kimi-code' }),
  $(if ($env:KIMI_SHARE_DIR) { $env:KIMI_SHARE_DIR } else { Join-Path $HOME '.kimi' })
)
foreach ($dir in $kimiDirs) {
  Remove-MediationJson (Join-Path $dir 'mcp.json')
  Remove-MediationSkill (Join-Path $dir 'skills\mediation')
  Remove-MarkerBlock (Join-Path $dir 'AGENTS.md') '<!-- >>> mediation >>> -->' '<!-- <<< mediation <<< -->'
}
Remove-Item (Join-Path $root 'mediation-mcp.mjs'), (Join-Path $root 'SKILL.md') -Force -ErrorAction SilentlyContinue
Remove-Item $root -Force -ErrorAction SilentlyContinue
Write-Warning 'Legacy Mediation install removed; per-project .mediation.json files were preserved.'
