# Builds data/dxcc.json (all DXCC entities) and data/world.json (map shapes linked to DXCC numbers).
# Sources (in ..\sources): ADIF 3.1.6 enumerations, country-files.com cty.csv, Natural Earth 50m map subunits
# and 10m admin-1 (for splitting Russia).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$src = "$root\sources"
. "$PSScriptRoot\geo-lib.ps1"

# ---------- DXCC entity list ----------
$adif = (Get-Content "$src\adif316\316\exports\json\enumerations_dxcc_entity_code.json" -Raw | ConvertFrom-Json).Adif.Enumerations.DXCC_Entity_Code.Records
$cty = @{}
foreach ($line in Get-Content "$src\cty.csv") {
    $f = $line.Split(',')
    if ($f.Count -lt 9 -or $f[0].StartsWith('*')) { continue }   # '*' = WAE-only, not DXCC
    $n = [int]$f[2]
    if (-not $cty.ContainsKey($n)) { $cty[$n] = @{ pfx = $f[0]; name = $f[1]; cont = $f[3]; lat = [double]$f[6]; lon = - [double]$f[7] } }
}
$ti = (Get-Culture).TextInfo
$dxcc = foreach ($p in $adif.psobject.Properties) {
    $r = $p.Value; $n = [int]$r.'Entity Code'; if ($n -eq 0) { continue }
    $c = $cty[$n]
    [pscustomobject]@{ n = $n; name = $(if ($c) { $c.name } else { $ti.ToTitleCase($r.'Entity Name'.ToLower()) }); pfx = $(if ($c) { $c.pfx } else { '' })
        cont = $(if ($c) { $c.cont } else { '' }); lat = $(if ($c) { $c.lat } else { $null }); lon = $(if ($c) { $c.lon } else { $null }); del = [bool]($r.Deleted -eq 'true' -or $r.Deleted -eq $true)
    }
}
"DXCC entities: $(@($dxcc).Count) (current $(@($dxcc | ? { -not $_.del }).Count))"

# ---------- world shapes ----------
$feats = New-Object 'System.Collections.Generic.List[GeoFeature]'
foreach ($f in [GeoTool]::LoadGeoJson("$src\ne_50m_admin_0_map_subunits.geojson")) {
    if ($f.Prop('ADM0_A3') -eq 'RUS') { continue }   # replaced by the admin-1 split below
    [GeoTool]::Simplify($f, 2); $f.Props['dx'] = ''; $feats.Add($f)
}
# Russia: European (15), Asiatic (54), Kaliningrad (126) from admin-1 regions; Urals taken as 59.5 E
foreach ($f in ([GeoTool]::LoadGeoJson("$src\ne_10m_admin_1_states_provinces.geojson") | ? { $_.Prop('adm0_a3') -eq 'RUS' })) {
    [GeoTool]::Simplify($f, 1)
    $c = [GeoTool]::Centroid($f)
    $f.Props['NAME'] = $f.Prop('name'); $f.Props['ADMIN'] = 'Russia'
    $f.Props['dx'] = if ($f.Prop('name') -match 'Kaliningrad') { '126' } elseif ($c[0] -lt 59.5 -and $c[0] -gt 0) { '15' } else { '54' }
    $feats.Add($f)
}

# assign each DXCC entity to the shape containing its point; when several share a shape, the name match wins
$overrides = Get-Content "$PSScriptRoot\world-overrides.json" -Raw | ConvertFrom-Json
$byShape = @{}
foreach ($e in ($dxcc | ? { -not $_.del -and $_.lat -ne $null -and $_.n -notin 15, 54, 126 })) {
    $hit = $null; foreach ($f in $feats) { if (-not $f.Props['dx'] -and [GeoTool]::Contains($f, $e.lon, $e.lat)) { $hit = $f; break } }
    if ($hit) { if (-not $byShape.ContainsKey($hit)) { $byShape[$hit] = @() }; $byShape[$hit] += $e }
}
foreach ($kv in $byShape.GetEnumerator()) {
    $f = $kv.Key; $cands = $kv.Value; $fn = Norm-Name $f.Prop('NAME'); $fa = Norm-Name $f.Prop('ADMIN')
    $best = $cands | ? { (Norm-Name $_.name) -in $fn, $fa } | Select -First 1
    if (-not $best) { $best = $cands | ? { $fn.Contains((Norm-Name $_.name)) -or (Norm-Name $_.name).Contains($fn) } | Select -First 1 }
    if (-not $best) { $c = [GeoTool]::Centroid($f); $best = $cands | Sort-Object { [math]::Pow($_.lon - $c[0], 2) + [math]::Pow($_.lat - $c[1], 2) } | Select -First 1 }
    $f.Props['dx'] = "$($best.n)"
}
# shapes nobody claimed: match by name
foreach ($f in ($feats | ? { -not $_.Props['dx'] })) {
    $fn = Norm-Name $f.Prop('NAME'); $fa = Norm-Name $f.Prop('ADMIN')
    $m = $dxcc | ? { -not $_.del -and (Norm-Name $_.name) -in $fn, $fa } | Select -First 1
    if ($m) { $f.Props['dx'] = "$($m.n)" }
}
# manual fixes: "Natural Earth NAME or SU_A3": DXCC (0 = none)
foreach ($p in $overrides.shapes.psobject.Properties) { foreach ($f in ($feats | ? { $_.Prop('NAME') -eq $p.Name -or $_.Prop('SU_A3') -eq $p.Name })) { $f.Props['dx'] = if ([int]$p.Value -eq 0) { '' } else { "$($p.Value)" } } }
# split shapes that hold two DXCC entities side by side (e.g. West / East Malaysia)
foreach ($p in $overrides.splitByLongitude.psobject.Properties) {
    $f = $feats | ? { $_.Prop('NAME') -eq $p.Name } | Select -First 1; if (-not $f) { continue }
    $lon = [double]$p.Value[0]; $parts = @{ w = New-Object GeoFeature; e = New-Object GeoFeature }
    foreach ($poly in $f.Polys) { $one = New-Object GeoFeature; $one.Polys.Add($poly); $c = [GeoTool]::Centroid($one); $(if ($c[0] -lt $lon) { $parts.w } else { $parts.e }).Polys.Add($poly) }
    [void]$feats.Remove($f)
    foreach ($k in 'w', 'e') { $g = [GeoTool]::Merge([GeoFeature[]]@($parts[$k])); $g.Props['NAME'] = "$($p.Name) ($(if ($k -eq 'w') { 'west' } else { 'east' }))"; $g.Props['dx'] = "$($p.Value[$(if ($k -eq 'w') { 1 } else { 2 })])"; $feats.Add($g) }
}

$withShape = @{}; foreach ($f in $feats) { if ($f.Props['dx']) { $withShape[[int]$f.Props['dx']] = 1 } }
"shapes: $($feats.Count), linked to a DXCC: $(@($feats | ? { $_.Props['dx'] }).Count); DXCC with a shape: $($withShape.Count); drawn as dots: $(@($dxcc | ? { -not $_.del -and -not $withShape[$_.n] }).Count)"

# ---------- write ----------
Write-Json "$root\data\dxcc.json" ([ordered]@{
        source = 'ADIF 3.1.6 DXCC enumeration; country-files.com cty.csv; Natural Earth 1:50m map subunits and 1:10m admin-1 (public domain)'
        fields = @('dxcc', 'name', 'prefix', 'continent', 'lat', 'lon', 'deleted', 'hasShape')
        dxcc   = @($dxcc | Sort-Object n | % { , @($_.n, $_.name, $_.pfx, $_.cont, $_.lat, $_.lon, [int]$_.del, [int][bool]$withShape[$_.n]) })
    })
# DXCC -> Natural Earth country code (used by build-packs.ps1 to find admin-1 regions)
$a3 = [ordered]@{}; foreach ($f in $feats) { $dx = $f.Props['dx']; $code = $f.Prop('ADM0_A3'); if (-not $code) { $code = $f.Prop('adm0_a3') }; if ($dx -and $code -and -not $a3.Contains($dx)) { $a3[$dx] = $code } }
Write-Json "$root\data\dxcc-a3.json" $a3
$props = New-Object 'System.Collections.Generic.List[string]'
foreach ($f in $feats) { $props.Add((Props-Json ([ordered]@{ dx = $(if ($f.Props['dx']) { [int]$f.Props['dx'] } else { $null }); name = $f.Prop('NAME') }))) }
[GeoTool]::WriteFeatureCollection("$root\data\world.json", $feats, $props)
"wrote data\dxcc.json ($([int]((Get-Item "$root\data\dxcc.json").Length/1KB)) KB), data\world.json ($([int]((Get-Item "$root\data\world.json").Length/1KB)) KB)"
"-- shapes shared by several DXCC points (others shown as dots):"
foreach ($kv in $byShape.GetEnumerator() | ? { $_.Value.Count -gt 1 }) { "  $($kv.Key.Prop('NAME')) -> $($kv.Key.Props['dx']); dots: " + (($kv.Value | ? { "$($_.n)" -ne $kv.Key.Props['dx'] } | % { "$($_.n) $($_.name)" }) -join ', ') }
"-- unlinked shapes: " + (($feats | ? { -not $_.Props['dx'] } | % { $_.Prop('NAME') }) -join ', ')

