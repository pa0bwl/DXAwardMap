# Writing an award pack

An award pack teaches DX Award Map one award (or a group of related awards) for one or more DXCC entities. It is a folder `packs\<id>\` with three files:

| File | What |
|---|---|
| `pack.json` | The definition: which DXCC entities, regions, awards, where the codes are in the log, clean-up rules, checks, map |
| `entities.json` | The award's areas (cities, districts, counties, ...) |
| `map.json` | Optional: region shapes as GeoJSON or TopoJSON |

Add the pack to `packs\index.json` so it shows up in the country menu. The build tools (`tools\build-packs.ps1`) create all of this from the official lists; look there for working examples (Japan, RDA, USA, DOK, URDA and the generic subdivision packs).

## pack.json
```json
{
  "id": "rda",
  "name": "Russia",
  "title": "RDA (Russian Districts Award)",
  "dxcc": [15, 54, 126],
  "source": "RDA list, rdaward.org",
  "regionLabel": "Oblast",
  "regions": [["AD", "Republic of Adygeya"], ["AL", "Altaysky Kraj"]],
  "map": { "file": "map.json", "format": "geojson", "joinProp": "region",
           "projection": { "name": "conicEqualArea", "rotate": [-100, 0], "parallels": [50, 70] } },
  "awards": [
    { "id": "RDA", "name": "RDA", "desc": "Russian Districts Award", "label": "districts",
      "normalize": ["rda"],
      "sources": {
        "n3fjp": [ { "field": "fldOther2", "re": "([A-Za-z]{2}\\s*-?\\s*[0-9Oo]{2})" } ],
        "adif":  [ { "field": "CNTY", "re": "([A-Za-z]{2}-?[0-9]{2})" } ]
      } }
  ],
  "nullTokens": ["NORDA", "-", "?"]
}
```

| Key | Meaning |
|---|---|
| `dxcc` | DXCC entity numbers whose QSOs this pack reads |
| `regions` | `[id, name]` pairs. Every area belongs to one region. The map colours regions, and clicking one lists its areas |
| `flat` | `true` when every region is itself the award area (states, provinces): the panel then lists all areas directly |
| `awards[].sources` | Per log type (`n3fjp` = N3FJP column names, `adif` = ADIF tags), the fields to read, in order. `re` is a regular expression whose first group is the code. `with` adds a second field in front, as `with,value` (used for US counties: state + county) |
| `codeSources` | Shared sources for all awards that have no `sources` of their own (Japan: JCC, JCG and KU codes are told apart by the list they appear in) |
| `awards[].derived` | `true` for awards derived from another code (WAJA prefectures from JCC numbers); these never raise a "fields disagree" warning |
| `normalize` | Clean-up steps applied to each code: `trim`, `upper`, `nospace`, `rda` (`MO12` becomes `MO-12`), `county` (`MD,Montgomery County` becomes `MD,MONTGOMERY`), `alias` (uses the `aliases` map) |
| `aliases` | Alternative spellings, for example `{"PEI": "PE"}` |
| `nullTokens` | Values that mean "no code" |
| `creditParent` | `true`: a QSO with an area also counts for its `parent` area (a ward counts for its city) |
| `callArea` | Region id to expected call-area digit; QSOs from other areas are marked suspect (portable stations excepted) |
| `map` | `file`, `format` (`geojson` or `topojson` + `object`), `joinProp` (property or `id` holding the region id), optional `joinMap` (from that value to the region id), `projection` (`mercator` default, `conicEqualArea`, `albersUsa`), `fit` (bounding box), `inset` (regions drawn in a corner box) |
| `entityMap` | Like `map`, but for individual areas; shown when a region is selected (US counties) |
| `list` | For award lists that the program downloads itself: `kind` (parser), `page`, `files` (name + url). Leave out for lists shipped in the pack |

## entities.json
```json
{ "fields": ["code", "name", "award", "region", "deletedOn", "parent", "deleted"],
  "e": [ ["AD-01", "Maikop", "RDA", "AD", "", "", 0],
         ["AB-01", "Deleted (now ZK-37)", "RDA", "AB", "", "", 1] ] }
```
- `deletedOn` is `yyyy-mm-dd` or empty. A QSO counts for a deleted area only if it was made on or before that date. With `deleted` = 1 and no date, it always counts.
- Deleted areas are shown as a bonus and never as "still needed".

## Testing a pack
Put the folder in `packs\`, add it to `packs\index.json`, restart DX Award Map and open the pack from the country menu.
- **Missing codes** tab: QSOs where none of your `sources` found a code.
- **Suspect QSOs** tab: codes that are not in your `entities.json`.

Please share new packs at https://github.com/pa0bwl/DXAwardMap.
