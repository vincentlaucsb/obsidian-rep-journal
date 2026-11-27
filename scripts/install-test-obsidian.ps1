$installer = Join-Path $env:RUNNER_TEMP 'Obsidian-1.15.0.exe'
$url = 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.0/Obsidian-1.15.0.exe'
Invoke-WebRequest -Uri $url -OutFile $installer -MaximumRetryCount 3
$sha256 = 'b0f60c75a12f96d54cb16b9fc32919966f2ebf029d9af75d67a19ba6555e1da0'
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $sha256) {
  throw 'Obsidian installer checksum mismatch.'
}
$installDir = Join-Path $env:RUNNER_TEMP 'Obsidian'
$install = Start-Process -FilePath $installer -ArgumentList '/S', "/D=$installDir" -WindowStyle Hidden -PassThru -Wait
if ($install.ExitCode -ne 0) { throw "Obsidian installer exited with $($install.ExitCode)." }
$executable = Join-Path $installDir 'Obsidian.exe'
if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Obsidian was not installed at $executable." }
Add-Content -LiteralPath $env:GITHUB_ENV -Value "OBSIDIAN_EXECUTABLE=$executable" -Encoding utf8
