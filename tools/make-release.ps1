# Builds the release zip: release\DXAwardMap-<version>.zip
# Contains the program, the web interface, the open data (DXCC list, maps, ADIF subdivisions, US counties)
# and the pack definitions. Award lists that may not be redistributed (JARL, RDA, DOK, URDA) are left out:
# the program downloads them from the official sources on first start.
# Works on a developer PC and on the GitHub Actions Windows runner (no downloads needed).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$version = [regex]::Match((Get-Content "$root\src\Program.cs" -Raw), 'public const string Version = "([^"]+)"').Groups[1].Value
$name = "DXAwardMap-$version"
$stage = "$root\release\$name"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

$csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"   # 32-bit compiler: x86 build for Windows' own Jet engine
& $csc /nologo /target:winexe /platform:x86 /optimize+ "/out:$stage\DXAwardMap.exe" `
    /r:System.Data.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Core.dll `
    "$root\src\Program.cs"
if ($LASTEXITCODE -ne 0) { throw "Compile failed" }

foreach ($d in 'web', 'data', 'packs') { Copy-Item "$root\$d" "$stage\$d" -Recurse }
$downloaded = @()
foreach ($pj in Get-ChildItem "$stage\packs" -Recurse -Filter pack.json) {
    $p = Get-Content $pj.FullName -Raw | ConvertFrom-Json
    if ($p.list) { Remove-Item (Join-Path $pj.DirectoryName 'entities.json') -ErrorAction SilentlyContinue; $downloaded += $p.id }
}
Copy-Item "$root\README.md", "$root\LICENSE", "$root\THIRD-PARTY-NOTICES.md" $stage
New-Item -ItemType Directory -Force "$stage\docs" | Out-Null
Copy-Item "$root\docs\USER-GUIDE.md", "$root\docs\PACKS.md" "$stage\docs"

$zip = "$root\release\$name.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $stage -DestinationPath $zip
"release: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
"award lists downloaded on first start (not in the zip): $($downloaded -join ', ')"
