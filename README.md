# DX Award Map

A free Windows program for radio amateurs that shows, on maps and in lists, which DXCC entities and which award areas you have worked and confirmed, per band. It reads your log live.

- **N3FJP Amateur Contact Log**: read directly, without Microsoft Office.
- **Any other logger**: through an ADIF export; the file is re-read automatically when it changes.

**Download:** [latest release](https://github.com/pa0bwl/DXAwardMap/releases/latest). Unzip and run `DXAwardMap.exe`; nothing to install. See the [user guide](docs/USER-GUIDE.md).

## What it shows
- **World**: all 340 DXCC entities on a world map (small islands as dots), per band, worked or confirmed, plus lists of all and still-needed entities. Every entity also has its own country page with a map, band table and all your QSOs.
- **Award packs**, each with a map, a band grid per area, a still-needed list, suspect codes and QSOs missing a code:
  - Japan: JCC, JCG, KU, WAJA
  - Russia: RDA
  - USA: WAS and counties, with a county map per state
  - Germany: DOK and special DOKs
  - Ukraine: URDA
  - States, provinces and regions for about 40 more countries (ADIF primary subdivisions)
- **Live updates**: new QSOs and LoTW/eQSL confirmations appear within seconds.
- **Field mapping**: tell it where you keep award codes in your log, with a preview of how each field is filled.
- **Award lists** (JARL, RDA, DOK, URDA) are downloaded from their official sources and refreshed automatically.

The program only reads your log: N3FJP's database is always read from a temporary copy and never changed. Everything stays on your own PC; the map is served on `http://localhost`.

## Requirements
Windows 10 or 11. .NET Framework 4.8, Edge and the Access database engine used for N3FJP logs are all part of Windows.

## Building from source
Needs Windows with PowerShell 7.
```
pwsh -File tools\make-release.ps1    # compile and package release\DXAwardMap-<version>.zip
pwsh -File build.ps1                 # compile into dist\ for development
```
`build.ps1` and `make-release.ps1` only need what is in this repository.

To rebuild the map data and award packs from the original sources, download the files listed in `tools\build-world.ps1` and `tools\build-packs.ps1` into `sources\`, then run `pwsh -File build.ps1 -Data`.

GitHub Actions (`.github/workflows/build.yml`) builds the zip on every push and attaches it to a GitHub release when a tag like `v0.9.0` is pushed.

## Award packs
Every award is a pack in `packs\<id>\`: a definition, the list of areas and an optional map. New packs for other countries' awards are welcome; see [docs/PACKS.md](docs/PACKS.md).

## Licence and data
- Program code: MIT licence, see [LICENSE](LICENSE).
- Data sources and their licences: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Award lists whose licence does not allow redistribution are not in this repository; the program downloads them from their publishers.

Maintained by PA0BWL. Questions, problems and new award packs: [issues](https://github.com/pa0bwl/DXAwardMap/issues).
