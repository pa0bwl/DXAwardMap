# Builds the award packs in ..\packs from the official lists in ..\sources.
# Each pack folder: pack.json (definition), entities.json (award areas), map.json (region shapes, optional).
# Usage: pwsh -File build-packs.ps1 [-Only ja,rda,...]
param([string[]]$Only)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$src = "$root\sources"
$packsDir = "$root\packs"
. "$PSScriptRoot\geo-lib.ps1"
[Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance)
$ti = (Get-Culture).TextInfo
function Want($id) { -not $Only -or $id -in $Only -or ($id -like 'sub-*' -and 'sub' -in $Only) }

# ---------- shared ----------
$admin1 = $null
function Admin1 { if (-not $script:admin1) { $script:admin1 = [GeoTool]::LoadGeoJson("$src\ne_10m_admin_1_states_provinces.geojson") }; $script:admin1 }
function NameKeys($f) {
    $names = @($f.Prop('name'), $f.Prop('name_en'), $f.Prop('woe_name'), $f.Prop('gn_name'), $f.Prop('name_local')) + ($f.Prop('name_alt') -split '\|')
    @($names | ? { $_ } | % { Norm-Name $_ } | ? { $_ } | Select -Unique)
}
# write a pack folder; entities: list of @(code, name, award, region, delDate, parent, deleted)
function Save-Pack($id, $pack, $entities, $mapFeats, $mapProps) {
    $dir = Join-Path $packsDir $id; New-Item -ItemType Directory -Force $dir | Out-Null
    Get-ChildItem $dir -File | Remove-Item
    if ($mapFeats) { [GeoTool]::WriteFeatureCollection("$dir\map.json", $mapFeats, $mapProps) }
    Write-Json "$dir\entities.json" ([ordered]@{ fields = @('code', 'name', 'award', 'region', 'deletedOn', 'parent', 'deleted'); e = @($entities) })
    Write-Json "$dir\pack.json" $pack
    $cur = @($entities | ? { -not $_[6] }).Count
    "  {0,-10} {1,-34} {2,6} areas ({3} current), {4} regions{5}" -f $id, $pack.name, @($entities).Count, $cur, @($pack.regions).Count, $(if ($pack.map) { ', map' } else { ', table only' })
}
function Region-Map($feats, [hashtable]$regionOf, [int]$digits = 2) {
    $fs = New-Object 'System.Collections.Generic.List[GeoFeature]'; $ps = New-Object 'System.Collections.Generic.List[string]'
    foreach ($f in $feats) { $r = $regionOf[$f]; if (-not $r) { continue }; [GeoTool]::Simplify($f, $digits); $fs.Add($f); $ps.Add((Props-Json ([ordered]@{ region = $r; name = $f.Prop('name') }))) }
    , @($fs, $ps)
}
$months = @{ jan = 1; feb = 2; mar = 3; apr = 4; may = 5; jun = 6; jul = 7; aug = 8; sep = 9; oct = 10; nov = 11; dec = 12 }
function EngDate($t) { if ($t -match '([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})\s*[,.]\s*(\d{4})') { '{0}-{1:00}-{2:00}' -f $matches[3], $months[$matches[1].ToLower()], [int]$matches[2] } else { '' } }
# call area digit expected for each JARL prefecture
function JaArea([int]$p) { if ($p -eq 1) { 8 } elseif ($p -le 7) { 7 } elseif ($p -le 9) { 0 } elseif ($p -le 17) { 1 } elseif ($p -le 21) { 2 } elseif ($p -le 27) { 3 } elseif ($p -le 30) { 9 } elseif ($p -le 35) { 4 } elseif ($p -le 39) { 5 } else { 6 } }
$dxccNames = @{}; foreach ($d in (Get-Content "$root\data\dxcc.json" -Raw | ConvertFrom-Json).dxcc) { $dxccNames[[int]$d[0]] = $d[1] }
$dxccA3 = Get-Content "$root\data\dxcc-a3.json" -Raw | ConvertFrom-Json
$aliases = Get-Content "$PSScriptRoot\pack-aliases.json" -Raw | ConvertFrom-Json
$index = New-Object System.Collections.ArrayList
function Add-Index($pack, $n) { [void]$index.Add([ordered]@{ id = $pack.id; name = $pack.name; title = $pack.title; dxcc = $pack.dxcc; awards = @($pack.awards | % { $_.id }); map = [bool]$pack.map; areas = $n }) }
New-Item -ItemType Directory -Force $packsDir | Out-Null
"Building packs:"

# =====================================================================
# Japan: JCC / JCG / KU / WAJA (JARL lists)
# =====================================================================
if (Want 'ja') {
    $prefNames = @{}; $ents = New-Object System.Collections.ArrayList
    foreach ($list in @(@{ f = 'jcc-list.txt'; t = 'JCC' }, @{ f = 'jcg-list.txt'; t = 'JCG' })) {
        foreach ($line in Get-Content "$src\$($list.f)") {
            if ($line -match '^([A-Z][A-Za-z\- ]+?)\s+(\d{2})\s*$') { if (-not $prefNames.ContainsKey($matches[2])) { $prefNames[$matches[2]] = $ti.ToTitleCase($matches[1].ToLower()) }; continue }
            if ($line -match '^\s*(\*)?\s*(\d{4,6})\s+(.+?)\s*$') {
                $del = [bool]$matches[1]; $code = $matches[2]; $rest = $matches[3]; $d = ''
                if ($rest -match '^(.*?)\s*"([^"]*)"\s*$') { $rest = $matches[1].Trim(); $d = EngDate $matches[2] }
                [void]$ents.Add(@($code, $rest, $list.t, $code.Substring(0, 2), $d, '', [int]$del))
            }
        }
    }
    $sj = [Text.Encoding]::GetEncoding(932); $parent = ''
    foreach ($line in $sj.GetString([IO.File]::ReadAllBytes("$src\ku-list.txt")).Split("`n")) {
        $line = $line.TrimEnd()
        if ($line -match '^(\S+)[(（](\d{4})[)）]\s*$') { $parent = $matches[2]; continue }
        if ($line -match '^(\d{6})(※)?\s*(\S+)\s+(\S+)\s*(.*)$') {
            $code = $matches[1]; $name = $matches[3]; $mark = $matches[2]; $rest = $matches[5]; $d = ''
            if ($mark -and $rest -match '(\d{4})(?:\([^)]*\))?年(\d{1,2})月(\d{1,2})日') { $d = '{0}-{1:00}-{2:00}' -f $matches[1], [int]$matches[2], [int]$matches[3] }
            [void]$ents.Add(@($code, $name, 'KU', $code.Substring(0, 2), $d, $parent, [int][bool]$d))
        }
    }
    $regions = @($prefNames.Keys | Sort-Object | % { , @($_, $prefNames[$_]) })
    foreach ($r in $regions) { [void]$ents.Add(@($r[0], $r[1], 'WAJA', $r[0], '', '', 0)) }
    # map: Natural Earth admin-1 Japan (public domain), matched to JARL prefectures by name
    $regionOf = @{}
    foreach ($f in (Admin1 | ? { $_.Prop('adm0_a3') -eq 'JPN' })) {
        $n = (Norm-Name $f.Prop('name')) -replace '^gumma$', 'gunma'
        $hit = $regions | ? { (Norm-Name $_[1]) -eq $n -or ((Norm-Name $_[1]) -replace '^gumma$', 'gunma') -eq $n } | Select -First 1
        if ($hit) { $regionOf[$f] = $hit[0] } else { Write-Warning "no prefecture for $($f.Prop('name'))" }
    }
    $m = Region-Map ($regionOf.Keys) $regionOf 2
    $code = '(?:JCC|JCG|AJA|KU|JGC|JCCC|WAJA)?\s*#\s*(\d{4,6})'
    $pack = [ordered]@{
        id = 'ja'; name = 'Japan'; title = 'JCC / JCG / KU / WAJA'; dxcc = @(339)
        source = 'JARL JCC, JCG and KU lists'
        list = [ordered]@{ kind = 'jarl'; page = 'https://www.jarl.org/English/4_Library/A-4-5_jcc-jcg/jcc-jcg.htm'; files = @([ordered]@{ name = 'jcc-list.txt'; url = 'https://www.jarl.org/English/4_Library/A-4-5_jcc-jcg/jcc-list.txt' }, [ordered]@{ name = 'jcg-list.txt'; url = 'https://www.jarl.org/English/4_Library/A-4-5_jcc-jcg/jcg-list.txt' }, [ordered]@{ name = 'ku-list.txt'; url = 'https://www.jarl.org/Japanese/A_Shiryo/A-2_jcc-jcg/ku-list.txt' }) }
        regionLabel = 'Prefecture'; regions = $regions
        map = [ordered]@{ file = 'map.json'; format = 'geojson'; joinProp = 'region'; fit = @(@(128.6, 30.9), @(145.9, 45.6)); inset = [ordered]@{ regions = @('47'); fit = @(@(122.9, 24.0), @(128.4, 26.95)); label = 'Okinawa' } }
        codeSources = [ordered]@{
            n3fjp = @([ordered]@{ field = 'fldOther3'; re = '^\s*(\d{4,6})\s*$' }, [ordered]@{ field = 'fldOther1'; re = $code }, [ordered]@{ field = 'fldComments'; re = $code })
            adif  = @([ordered]@{ field = 'CNTY'; re = '^\s*(\d{4,6})\s*$' }, [ordered]@{ field = 'COMMENT'; re = $code })
        }
        awards = @(
            [ordered]@{ id = 'JCC'; name = 'JCC'; desc = 'Japan Century Cities'; label = 'cities' }
            [ordered]@{ id = 'JCG'; name = 'JCG'; desc = 'Japan Century Guns'; label = 'districts (gun)' }
            [ordered]@{ id = 'KU'; name = 'KU'; desc = 'Wards of designated cities'; label = 'wards (ku)' }
            [ordered]@{ id = 'WAJA'; name = 'WAJA'; desc = 'Worked All Japan prefectures'; label = 'prefectures'; derived = $true
                sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldOther3'; re = '^\s*(\d{2})\d{2,4}\s*$' }, [ordered]@{ field = 'fldOther1'; re = '#\s*(\d{2})\d{2,4}' }, [ordered]@{ field = 'fldComments'; re = '#\s*(\d{2})\d{2,4}' })
                    adif = @([ordered]@{ field = 'STATE'; re = '^\s*(\d{2})\s*$' }, [ordered]@{ field = 'CNTY'; re = '^\s*(\d{2})\d{2,4}\s*$' }) } }
        )
        normalize = @('trim')
        creditParent = $true; rules = @('ja-tokyo-wards')
        callArea = [ordered]@{}
    }
    foreach ($r in $regions) { $pack.callArea[$r[0]] = JaArea ([int]$r[0]) }
    Save-Pack 'ja' $pack $ents $m[0] $m[1]
    Add-Index $pack $ents.Count
}

# =====================================================================
# Russia: RDA (rdaward.org)
# =====================================================================
if (Want 'rda') {
    $regionNames = [ordered]@{}; $ents = New-Object System.Collections.ArrayList
    foreach ($line in Get-Content "$src\rda_eng.txt") {
        if ($line -match '^\s+(.+?)\s+\(([A-Z]{2})\)') { $regionNames[$matches[2]] = $matches[1].Trim(); continue }
        if ($line -match '^([A-Z]{2}-\d{2})\t(.*)$') {
            $code = $matches[1]; $parts = @($matches[2].Split("`t") | % { $_.Trim() } | ? { $_ })
            $name = if ($parts) { $parts[0] } else { '' }; $del = $name -match '^deleted'
            if ($del) { $repl = @($parts)[-1]; $name = if ($repl -and $repl -ne 'deleted' -and $repl -ne '***') { "deleted (now $repl)" } else { 'deleted' } }
            [void]$ents.Add(@($code, $ti.ToTitleCase($name.ToLower()), 'RDA', $code.Substring(0, 2), '', '', [int]$del))
        }
    }
    $extra = @{ RA = 'Ryazanskaya oblast' }
    foreach ($c in ($ents | % { $_[3] } | Select -Unique)) { if (-not $regionNames.Contains($c)) { $regionNames[$c] = if ($extra[$c]) { $extra[$c] } else { $c } } }
    $regions = @($regionNames.Keys | Sort-Object | % { , @($_, $regionNames[$_]) })
    foreach ($r in $regions) { $all = @($ents | ? { $_[3] -eq $r[0] -and $_[2] -eq 'RDA' }); [void]$ents.Add(@($r[0], $r[1], 'OBL', $r[0], '', '', [int](@($all | ? { -not $_[6] }).Count -eq 0))) }
    # Natural Earth admin-1 (ISO code) -> RDA oblast. Crimea, Sevastopol and the occupied Ukrainian oblasts
    # are kept in the RDA list (table) but not drawn on this map.
    $iso = @{ 'RU-AL' = 'GA'; 'RU-PSK' = 'PS'; 'RU-KDA' = 'KR'; 'RU-KC' = 'KC'; 'RU-KB' = 'KB'; 'RU-SE' = 'SO'; 'RU-IN' = 'IN'; 'RU-CE' = 'CN'; 'RU-DA' = 'DA'; 'RU-MUR' = 'MU'; 'RU-KR' = 'KL'; 'RU-LEN' = 'LO'; 'RU-KGD' = 'KA'
        'RU-SMO' = 'SM'; 'RU-BRY' = 'BR'; 'RU-KRS' = 'KU'; 'RU-BEL' = 'BO'; 'RU-VOR' = 'VR'; 'RU-ROS' = 'RO'; 'RU-BU' = 'BU'; 'RU-TY' = 'TU'; 'RU-ZAB' = 'ZK'; 'RU-AMU' = 'AM'; 'RU-YEV' = 'EA'; 'RU-KHA' = 'HK'; 'RU-PRI' = 'PK'
        'RU-TYU' = 'TN'; 'RU-KGN' = 'KN'; 'RU-OMS' = 'OM'; 'RU-NVS' = 'NS'; 'RU-CHE' = 'CB'; 'RU-ALT' = 'AL'; 'RU-ORE' = 'OB'; 'RU-SAR' = 'SA'; 'RU-AST' = 'AO'; 'RU-VGG' = 'VG'; 'RU-MAG' = 'MG'; 'RU-SAK' = 'SL'; 'RU-CHU' = 'CK'
        'RU-YAN' = 'YN'; 'RU-NEN' = 'NO'; 'RU-SA' = 'YA'; 'RU-SPE' = 'SP'; 'RU-ARK' = 'AR'; 'RU-KYA' = 'KK'; 'RU-KL' = 'KM'; 'RU-KAM' = 'KT'; 'RU-BA' = 'BA'; 'RU-SVE' = 'SV'; 'RU-KHM' = 'HM'; 'RU-LIP' = 'LP'; 'RU-TAM' = 'TB'
        'RU-TOM' = 'TO'; 'RU-TA' = 'TA'; 'RU-ULY' = 'UL'; 'RU-PNZ' = 'PE'; 'RU-KEM' = 'KE'; 'RU-ORL' = 'OR'; 'RU-IRK' = 'IR'; 'RU-KK' = 'HA'; 'RU-MO' = 'MD'; 'RU-KLU' = 'KG'; 'RU-KOS' = 'KS'; 'RU-YAR' = 'YR'; 'RU-VLA' = 'VL'
        'RU-RYA' = 'RA'; 'RU-IVA' = 'IV'; 'RU-NIZ' = 'NN'; 'RU-TUL' = 'TL'; 'RU-CU' = 'CU'; 'RU-VLG' = 'VO'; 'RU-NGR' = 'NV'; 'RU-TVE' = 'TV'; 'RU-ME' = 'MR'; 'RU-KIR' = 'KI'; 'RU-UD' = 'UD'; 'RU-KO' = 'KO'; 'RU-PER' = 'PM'
        'RU-SAM' = 'SR'; 'RU-STA' = 'ST'; 'RU-AD' = 'AD' }
    $regionOf = @{}
    foreach ($f in (Admin1 | ? { $_.Prop('adm0_a3') -eq 'RUS' })) {
        # Natural Earth swaps the codes of Moscow city and oblast; go by name
        if ($f.Prop('name') -eq 'Moskva') { $regionOf[$f] = 'MA' } elseif ($f.Prop('name') -eq 'Moskovskaya') { $regionOf[$f] = 'MO' } elseif ($iso[$f.Prop('iso_3166_2')]) { $regionOf[$f] = $iso[$f.Prop('iso_3166_2')] }
    }
    $m = Region-Map ($regionOf.Keys) $regionOf 2
    $rda = '([A-Za-z]{2}\s*-?\s*[0-9Oo]{2})'
    $pack = [ordered]@{
        id = 'rda'; name = 'Russia'; title = 'RDA (Russian Districts Award)'; dxcc = @(15, 54, 126)
        source = 'RDA list, rdaward.org'
        list = [ordered]@{ kind = 'rda'; page = 'https://rdaward.org/'; files = @([ordered]@{ name = 'rda_eng.txt'; url = 'https://rdaward.org/rda_eng.txt' }) }
        regionLabel = 'Oblast'; regions = $regions
        map = [ordered]@{ file = 'map.json'; format = 'geojson'; joinProp = 'region'; projection = [ordered]@{ name = 'conicEqualArea'; rotate = @(-100, 0); parallels = @(50, 70) } }
        awards = @(
            [ordered]@{ id = 'RDA'; name = 'RDA'; desc = 'Russian Districts Award'; label = 'districts'; normalize = @('rda')
                sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldOther2'; re = $rda }, [ordered]@{ field = 'fldComments'; re = "RDA[#: ]*$rda" }, [ordered]@{ field = 'fldCountyR'; re = '^\s*([A-Za-z]{2}-[0-9]{2})\s*$' })
                    adif = @([ordered]@{ field = 'CNTY'; re = $rda }, [ordered]@{ field = 'COMMENT'; re = "RDA[#: ]*$rda" }) } }
            [ordered]@{ id = 'OBL'; name = 'Oblasts'; desc = 'RDA oblasts (regions)'; label = 'oblasts'; derived = $true; normalize = @('upper')
                sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldOther2'; re = '([A-Za-z]{2})\s*-?\s*[0-9Oo]{2}' }, [ordered]@{ field = 'fldComments'; re = 'RDA[#: ]*([A-Za-z]{2})\s*-?\s*[0-9]{2}' })
                    adif = @([ordered]@{ field = 'CNTY'; re = '([A-Za-z]{2})\s*-?\s*[0-9]{2}' }) } }
        )
        nullTokens = @('NORDA', 'NONE', '-', '?', '??', '???', '????', 'N/A')
    }
    Save-Pack 'rda' $pack $ents $m[0] $m[1]
    Add-Index $pack $ents.Count
}

# =====================================================================
# USA: WAS states + counties (us-atlas, Census county list)
# =====================================================================
if (Want 'usa') {
    $fips = @{ '01' = 'AL'; '02' = 'AK'; '04' = 'AZ'; '05' = 'AR'; '06' = 'CA'; '08' = 'CO'; '09' = 'CT'; '10' = 'DE'; '12' = 'FL'; '13' = 'GA'; '15' = 'HI'; '16' = 'ID'; '17' = 'IL'; '18' = 'IN'; '19' = 'IA'; '20' = 'KS'; '21' = 'KY'; '22' = 'LA'; '23' = 'ME'; '24' = 'MD'
        '25' = 'MA'; '26' = 'MI'; '27' = 'MN'; '28' = 'MS'; '29' = 'MO'; '30' = 'MT'; '31' = 'NE'; '32' = 'NV'; '33' = 'NH'; '34' = 'NJ'; '35' = 'NM'; '36' = 'NY'; '37' = 'NC'; '38' = 'ND'; '39' = 'OH'; '40' = 'OK'; '41' = 'OR'; '42' = 'PA'; '44' = 'RI'; '45' = 'SC'
        '46' = 'SD'; '47' = 'TN'; '48' = 'TX'; '49' = 'UT'; '50' = 'VT'; '51' = 'VA'; '53' = 'WA'; '54' = 'WV'; '55' = 'WI'; '56' = 'WY' }
    function CountyKey([string]$state, [string]$county) {
        $c = $county.Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
        $c = $c.ToUpper() -replace '&', 'AND' -replace '\bSAINT\b', 'ST' -replace '\bCITY AND BOROUGH\b', '' -replace '\bCENSUS AREA\b', '' -replace '\b(COUNTY|PARISH|BOROUGH|MUNICIPALITY)\b', ''
        "$($state.ToUpper().Trim()),$($c -replace '[^A-Z0-9]', '')"
    }
    $topo = Get-Content "$src\us-counties-10m.json" -Raw | ConvertFrom-Json
    $ents = New-Object System.Collections.ArrayList; $stateJoin = [ordered]@{}; $countyJoin = [ordered]@{}; $regions = @()
    foreach ($g in $topo.objects.states.geometries) { $st = $fips["$($g.id)"]; if (-not $st) { continue }; $stateJoin["$($g.id)"] = $st; $regions += , @($st, $g.properties.name); [void]$ents.Add(@($st, $g.properties.name, 'WAS', $st, '', '', 0)) }
    foreach ($g in $topo.objects.counties.geometries) {
        $id = "$($g.id)"; $st = $fips[$id.Substring(0, 2)]; if (-not $st) { continue }
        $name = $g.properties.name
        if ([int]$id.Substring(2) -ge 500 -and $id.Substring(0, 2) -in '51', '24', '29' -and $name -notmatch 'City$') { $name = "$name City" }
        $key = CountyKey $st $name
        $countyJoin[$id] = $key
        [void]$ents.Add(@($key, $name, 'CNTY', $st, '', '', 0))
    }
    $regions = @($regions | Sort-Object { $_[0] })
    $pack = [ordered]@{
        id = 'usa'; name = 'USA'; title = 'WAS + US counties'; dxcc = @(291, 6, 110)
        source = 'US Census counties via us-atlas 3.0.1 (ISC); approximates CQ USA-CA (3,077 counties)'
        regionLabel = 'State'; regions = $regions
        map = [ordered]@{ file = 'map.json'; format = 'topojson'; object = 'states'; joinProp = 'id'; joinMap = $stateJoin; projection = [ordered]@{ name = 'albersUsa' } }
        entityMap = [ordered]@{ award = 'CNTY'; file = 'map.json'; format = 'topojson'; object = 'counties'; joinProp = 'id'; joinMap = $countyJoin }
        awards = @(
            [ordered]@{ id = 'WAS'; name = 'WAS'; desc = 'Worked All States'; label = 'states'; normalize = @('upper', 'nospace')
                sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldState'; re = '^\s*([A-Za-z]{2})\s*$' }); adif = @([ordered]@{ field = 'STATE'; re = '^\s*([A-Za-z]{2})\s*$' }) } }
            [ordered]@{ id = 'CNTY'; name = 'Counties'; desc = 'US counties (USA-CA)'; label = 'counties'; normalize = @('county')
                sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldCountyR'; with = 'fldState' }); adif = @([ordered]@{ field = 'CNTY' }) } }
        )
        nullTokens = @('', '-', '?', 'UNKNOWN', 'N/A')
    }
    Save-Pack 'usa' $pack $ents $null $null
    Copy-Item "$src\us-counties-10m.json" "$packsDir\usa\map.json"
    Add-Index $pack $ents.Count
}

# =====================================================================
# Germany: DOK (DARC) + special DOKs
# =====================================================================
if (Want 'dok') {
    $ents = New-Object System.Collections.ArrayList; $districts = [ordered]@{}
    foreach ($line in [IO.File]::ReadAllLines("$src\dok.csv", [Text.Encoding]::UTF8)) {
        $p = $line.Split(';'); if ($p.Count -lt 3 -or $p[0] -notmatch '^[A-Z]\d{2}$') { continue }
        $letter = $p[0].Substring(0, 1); if (-not $districts.Contains($letter)) { $districts[$letter] = $p[1] }
        [void]$ents.Add(@($p[0], $p[2], 'DOK', $letter, '', '', 0))
    }
    $seen = @{}
    foreach ($line in [IO.File]::ReadAllLines("$src\sdok.csv", [Text.Encoding]::UTF8)) {
        $p = $line.Split(';'); if ($p.Count -lt 5 -or $seen[$p[0]]) { continue }; $seen[$p[0]] = 1
        $end = ''; if ($p[4] -match '^(\d{2})\.(\d{2})\.(\d{2,4})$') { $y = [int]$matches[3]; if ($y -lt 100) { $y += if ($y -gt 50) { 1900 } else { 2000 } }; $end = '{0}-{1}-{2}' -f $y, $matches[2], $matches[1] }
        [void]$ents.Add(@($p[0].ToUpper(), $p[1], 'SDOK', 'S', $end, '', [int]($end -and $end -lt (Get-Date).ToString('yyyy-MM-dd'))))
    }
    $regions = @($districts.Keys | Sort-Object | % { , @($_, $districts[$_]) }) + , @('S', 'Special DOKs')
    $pack = [ordered]@{
        id = 'dok'; name = 'Germany'; title = 'DOK (DARC local clubs)'; dxcc = @(230)
        source = 'DOK and special DOK lists (df2et.de mirror of the DARC lists)'
        list = [ordered]@{ kind = 'dok'; page = 'https://www.darc.de/der-club/referate/conteste/wag-contest/en/service/districtsdoks/'; files = @([ordered]@{ name = 'dok.csv'; url = 'https://www.df2et.de/cqrlog/dok.csv' }, [ordered]@{ name = 'sdok.csv'; url = 'https://www.df2et.de/cqrlog/sdok.csv' }) }
        regionLabel = 'DARC district'; regions = $regions; map = $null
        awards = @(
            [ordered]@{ id = 'DOK'; name = 'DOK'; desc = 'DARC local club codes (DLD)'; label = 'DOKs'; normalize = @('upper', 'nospace')
                sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldOther6'; re = '^\s*([A-Za-z]\s*-?\s*\d{2})\s*$' }); adif = @([ordered]@{ field = 'DARC_DOK'; re = '^\s*([A-Za-z]\s*-?\s*\d{2})\s*$' }) } }
            [ordered]@{ id = 'SDOK'; name = 'Special DOK'; desc = 'Special (temporary) DOKs'; label = 'special DOKs'; normalize = @('upper', 'nospace')
                sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldOther6'; re = '^\s*(\S{3,})\s*$' }); adif = @([ordered]@{ field = 'DARC_DOK'; re = '^\s*(\S{3,})\s*$' }) } }
        )
        nullTokens = @('', '-', 'NM', 'NONE', 'KEIN')
    }
    Save-Pack 'dok' $pack $ents $null $null
    Add-Index $pack $ents.Count
}

# =====================================================================
# Ukraine: URDA (uarl.com.ua, 2012 list)
# =====================================================================
if (Want 'urda') {
    $t = Get-Content "$src\urda-listeng.htm" -Raw
    $t = [regex]::Replace($t, '(?i)<br\s*/?>|</tr>|</p>|</td>', "`n"); $t = [Net.WebUtility]::HtmlDecode([regex]::Replace($t, '<[^>]+>', ''))
    $cyr = @{ 'А' = 'A'; 'В' = 'B'; 'С' = 'C'; 'Е' = 'E'; 'Н' = 'H'; 'І' = 'I'; 'К' = 'K'; 'М' = 'M'; 'О' = 'O'; 'Р' = 'P'; 'Т' = 'T'; 'Х' = 'X' }
    $ents = New-Object System.Collections.ArrayList; $regionNames = [ordered]@{}; $pendingHeader = $null
    foreach ($raw in ($t -split "`n")) {
        $line = ($raw -replace '\s+', ' ').Trim(); if (-not $line) { continue }
        $head = $line; foreach ($k in $cyr.Keys) { $head = $head.Replace($k, $cyr[$k]) }
        if ($head -match '^([A-Z]{2})-(\d{2})\b\s*(.*)$') {
            $code = "$($matches[1])-$($matches[2])"; $name = $matches[3] -replace '^\d{5}\s*-\s*\d{5}\s*', '' -replace '^\d{5}\s*-\s*', '' -replace '[\p{IsCyrillic}][^.]*\.\s*', '' -replace '\(Up [^)]*\)', ''
            if ($pendingHeader -and -not $regionNames.Contains($matches[1])) { $regionNames[$matches[1]] = $pendingHeader }
            $pendingHeader = $null
            [void]$ents.Add(@($code, $name.Trim(), 'URDA', $matches[1], '', '', 0))
        }
        elseif ($line -match '(?i)(REGION|CITY|REPUBLIC)\s*$') { $pendingHeader = $ti.ToTitleCase(($line -replace '^.*?-\s*(?=[A-Z][A-Z])', '' -replace '^U[RU][0-9A-Z-]*\s*', '').ToLower().Trim()) }
    }
    $regions = @($regionNames.Keys | Sort-Object | % { , @($_, $regionNames[$_]) })
    foreach ($r in $regions) { [void]$ents.Add(@($r[0], $r[1], 'OBL', $r[0], '', '', 0)) }
    # map: Natural Earth admin-1 Ukraine (+ Crimea and Sevastopol, filed under RUS in Natural Earth)
    $alias = @{ kiev = 'kyivregion'; kievcity = 'kyivcity'; transcarpathia = 'zakarpatskaregion'; odessa = 'odesaregion'; vinnytsya = 'vinnytsiaregion'; zaporizhzhya = 'zaporizhzhiaregion'; khmelnytskyy = 'khmelnytskyiregion'; crimea = 'crimeanrepublic'; sevastopol = 'sevastopolcity' }
    $regionOf = @{}
    foreach ($f in (Admin1 | ? { $_.Prop('adm0_a3') -eq 'UKR' -or $_.Prop('iso_3166_2') -in 'UA-43', 'UA-40' })) {
        $n = Norm-Name $f.Prop('name'); if ($alias[$n]) { $n = $alias[$n] }
        $hit = $regions | ? { $rn = Norm-Name $_[1]; $rn -eq $n -or $rn -eq "${n}region" -or $rn.StartsWith($n.Substring(0, [math]::Min(6, $n.Length))) -and -not ($rn -like '*city' -xor $n -like '*city') } | Select -First 1
        if ($hit) { $regionOf[$f] = $hit[0] } else { Write-Warning "URDA: no region for $($f.Prop('name'))" }
    }
    $m = Region-Map ($regionOf.Keys) $regionOf 2
    $pack = [ordered]@{
        id = 'urda'; name = 'Ukraine'; title = 'URDA (Ukrainian Districts Award)'; dxcc = @(288)
        source = 'URDA list, uarl.com.ua'
        list = [ordered]@{ kind = 'urda'; page = 'https://uarl.com.ua/urda/'; files = @([ordered]@{ name = 'listeng.htm'; url = 'https://uarl.com.ua/urda/files/listeng.htm' }) }
        regionLabel = 'Region'; regions = $regions
        map = [ordered]@{ file = 'map.json'; format = 'geojson'; joinProp = 'region' }
        awards = @(
            [ordered]@{ id = 'URDA'; name = 'URDA'; desc = 'Ukrainian Districts Award'; label = 'districts'; normalize = @('rda')
                sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldOther4'; re = '([A-Za-z]{2}\s*-?\s*[0-9Oo]{2})' }, [ordered]@{ field = 'fldComments'; re = 'URDA[#: ]*([A-Za-z]{2}\s*-?\s*[0-9]{2})' }); adif = @([ordered]@{ field = 'CNTY'; re = '([A-Za-z]{2}\s*-?\s*[0-9]{2})' }) } }
            [ordered]@{ id = 'OBL'; name = 'Regions'; desc = 'URDA regions (oblasts)'; label = 'regions'; derived = $true; normalize = @('upper')
                sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldOther4'; re = '^\s*([A-Za-z]{2})\b' }); adif = @([ordered]@{ field = 'CNTY'; re = '^\s*([A-Za-z]{2})\s*-?\s*[0-9]{2}' }, [ordered]@{ field = 'STATE'; re = '^\s*([A-Za-z]{2})\s*$' }) } }
        )
        nullTokens = @('', '-', '?', 'NONE')
    }
    Save-Pack 'urda' $pack $ents $m[0] $m[1]
    Add-Index $pack $ents.Count
}

# =====================================================================
# Generic: ADIF primary administrative subdivisions (states, provinces, ...)
# =====================================================================
if (Want 'sub') {
    $skip = @(339, 291, 6, 110, 15, 54, 126, 288)
    $recs = (Get-Content "$src\adif316\316\exports\json\enumerations_primary_administrative_subdivision.json" -Raw | ConvertFrom-Json).Adif.Enumerations.Primary_Administrative_Subdivision.Records.psobject.Properties.Value
    $byDx = $recs | Group-Object { [int]$_.'DXCC Entity Code' }
    $labels = @{ 1 = 'Province'; 150 = 'State'; 108 = 'State'; 318 = 'Province'; 230 = 'State' }
    foreach ($g in ($byDx | Sort-Object { [int]$_.Name })) {
        $dx = [int]$g.Name; if ($dx -in $skip) { continue }
        $id = "sub-$dx"; if (-not (Want $id)) { continue }
        $subs = @($g.Group | % { [pscustomobject]@{ code = $_.Code.Trim().ToUpper(); name = $_.'Primary Administrative Subdivision'; del = [bool]($_.Deleted -eq 'true' -or $_.Deleted -eq $true) } } | Group-Object code | % { $_.Group[0] })
        $ents = @($subs | % { , @($_.code, $_.name, 'SUB', $_.code, '', '', [int]$_.del) })
        $regions = @($subs | ? { -not $_.del } | % { , @($_.code, $_.name) })
        # try to find map shapes
        $a3 = $dxccA3."$dx"; $mapFeats = $null; $mapProps = $null; $map = $null
        if ($a3) {
            $cands = @(Admin1 | ? { $_.Prop('adm0_a3') -eq $a3 })
            $regionOf = @{}
            foreach ($f in $cands) {
                $codes = @($f.Prop('postal'), ($f.Prop('iso_3166_2') -split '-')[-1], ($f.Prop('code_hasc') -split '\.')[-1]) | ? { $_ } | % { $_.ToUpper() }
                $keys = NameKeys $f
                $hit = $subs | ? { -not $_.del -and $_.code -in $codes } | Select -First 1
                if (-not $hit) { $hit = $subs | ? { -not $_.del -and (Norm-Name $_.name) -in $keys } | Select -First 1 }
                if (-not $hit) { $hit = $subs | ? { -not $_.del -and ($nn = Norm-Name $_.name) -and ($keys | ? { $_.Length -ge 5 -and $nn.Length -ge 5 -and ($_.StartsWith($nn.Substring(0, 5))) }) } | Select -First 1 }
                if ($hit) { $regionOf[$f] = $hit.code }
            }
            $covered = @($regionOf.Values | Select -Unique).Count; $cur = @($subs | ? { -not $_.del }).Count
            if ($cur -gt 0 -and $covered / $cur -ge 0.6) {
                $m = Region-Map ($regionOf.Keys) $regionOf 2; $mapFeats = $m[0]; $mapProps = $m[1]
                $bb = @(999, 999, -999, -999); foreach ($f in $mapFeats) { $bb[0] = [math]::Min($bb[0], $f.BBox[0]); $bb[1] = [math]::Min($bb[1], $f.BBox[1]); $bb[2] = [math]::Max($bb[2], $f.BBox[2]); $bb[3] = [math]::Max($bb[3], $f.BBox[3]) }
                $map = [ordered]@{ file = 'map.json'; format = 'geojson'; joinProp = 'region' }
                if ($bb[2] - $bb[0] -gt 35) { $map.projection = [ordered]@{ name = 'conicEqualArea'; rotate = @(- [math]::Round(($bb[0] + $bb[2]) / 2), 0); parallels = @([math]::Round($bb[1] + ($bb[3] - $bb[1]) / 4), [math]::Round($bb[3] - ($bb[3] - $bb[1]) / 4)) } }
            }
        }
        $label = if ($labels[$dx]) { $labels[$dx] } else { 'Subdivision' }
        $al = $aliases."$dx"
        $pack = [ordered]@{
            id = $id; name = $dxccNames[$dx]; title = "$($label)s"; dxcc = @($dx)
            source = 'ADIF 3.1.6 Primary Administrative Subdivision enumeration' + $(if ($map) { '; Natural Earth 1:10m admin-1 (public domain)' } else { '' })
            regionLabel = $label; regions = $regions; flat = $true; map = $map
            awards = @([ordered]@{ id = 'SUB'; name = "$($label)s"; desc = "$($dxccNames[$dx]) $($label.ToLower())s"; label = "$($label.ToLower())s"; normalize = @('upper', 'trim', 'alias')
                    sources = [ordered]@{ n3fjp = @([ordered]@{ field = 'fldState' }); adif = @([ordered]@{ field = 'STATE' }) } })
            aliases = $(if ($al) { $al } else { [ordered]@{} })
            nullTokens = @('', '-', '?')
        }
        Save-Pack $id $pack $ents $mapFeats $mapProps
        Add-Index $pack @($ents).Count
    }
}

# ---------- index of all packs ----------
$existing = @(); if ($Only -and (Test-Path "$packsDir\index.json")) { $existing = @((Get-Content "$packsDir\index.json" -Raw | ConvertFrom-Json).packs | ? { $_.id -notin @($index | % { $_.id }) }) }
Write-Json "$packsDir\index.json" ([ordered]@{ packs = @($existing) + @($index) })
"index: $(@($existing).Count + $index.Count) packs"


