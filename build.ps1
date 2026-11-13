# Builds DX Award Map.
#   pwsh -File build.ps1            compile the program into dist\ (and copy web, data, packs)
#   pwsh -File build.ps1 -Data      also rebuild data\ and packs\ from sources\ (needs the source downloads)
param([switch]$Data)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ($Data) { & "$root\tools\build-world.ps1"; & "$root\tools\build-packs.ps1" }
$dist = "$root\dist"
New-Item -ItemType Directory -Force $dist | Out-Null
$csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"   # 32-bit compiler (x86 build for the Jet engine)
& $csc /nologo /target:winexe /platform:x86 /optimize+ "/out:$dist\DXAwardMap.exe" `
    /r:System.Data.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Core.dll `
    "$root\src\Program.cs"
if ($LASTEXITCODE -ne 0) { throw "Compile failed" }
foreach ($d in 'web', 'data', 'packs') { if (Test-Path "$dist\$d") { Remove-Item "$dist\$d" -Recurse -Force }; Copy-Item "$root\$d" "$dist\$d" -Recurse }
Copy-Item "$root\LICENSE", "$root\README.md" $dist -ErrorAction SilentlyContinue
"built $dist\DXAwardMap.exe"
