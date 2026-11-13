# Shared helpers for the build tools. Geometry work is done in GeoTool.cs (typed, fast).
if (-not ('GeoTool' -as [type])) { Add-Type -Path "$PSScriptRoot\GeoTool.cs" -ReferencedAssemblies System.Text.Json, System.Collections, System.Linq, System.Runtime, System.Memory, System.Text.Encodings.Web, System.Console, System.Text.Encoding.Extensions, System.Runtime.Extensions }

function Write-Json($path, $obj) {
    $json = $obj | ConvertTo-Json -Depth 40 -Compress -EscapeHandling EscapeNonAscii
    [IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))
}
function Props-Json($h) { $h | ConvertTo-Json -Compress -Depth 5 -EscapeHandling EscapeNonAscii }
function Norm-Name([string]$s) {
    $s = $s.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
    ($s -replace '[^A-Za-z]', '').ToLower()
}


