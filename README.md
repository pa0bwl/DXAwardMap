# DX Award Map

A free Windows program for radio amateurs that shows, on maps and in lists, which DXCC entities and which award areas you have worked and confirmed, per band. It reads your log live.

- **N3FJP Amateur Contact Log**: read directly, without Microsoft Office.
- **Any other logger**: through an ADIF export; the file is re-read automatically when it changes.

## What it shows
- **World**: all 340 DXCC entities on a world map (small islands as dots), per band, worked or confirmed, plus lists of all and still-needed entities.
- **Award packs**, each with a map, a band grid, still-needed list, suspect codes and QSOs missing a code:
  - Japan: JCC, JCG, KU, WAJA
  - Russia: RDA
  - USA: WAS and counties, with a county map per state
  - Germany: DOK and special DOKs
  - Ukraine: URDA
  - States, provinces and regions for about 60 more countries (ADIF primary subdivisions)

## Using it
1. Download the release zip and unzip it anywhere.
2. Run `DXAwardMap.exe`. A tray icon appears and the map opens in its own window.
3. **First run:** Settings opens. Choose N3FJP (its active log is found automatically) or an ADIF file, and which confirmations count (LoTW, eQSL, card).
4. **Field mapping:** if you log award codes in a different field (for example RDA in Other2), set that under Settings > Field mapping. The screen shows how each field in your log is filled.

The program only reads your log: N3FJP's database is always read from a temporary copy and never changed. Everything stays on your PC; the page is served on `http://localhost`.

## Building
Needs Windows with .NET Framework 4.8 (built in) and PowerShell 7.
```
pwsh -File build.ps1            # compile dist\DXAwardMap.exe and copy web, data, packs
pwsh -File build.ps1 -Data      # also rebuild data\ and packs\ from sources\ (see tools\)
```
`tools\build-world.ps1` and `tools\build-packs.ps1` turn the downloaded source lists in `sources\` into `data\` and `packs\`.

## Award packs
A pack is a folder `packs\<id>\` with `pack.json` (which DXCC entities, which log fields hold the code, clean-up rules, checks, map), `entities.json` (the award areas, with deletion dates) and an optional `map.json`. See `tools\build-packs.ps1` for examples. New packs are welcome.

## Data sources and licences
- Program code: MIT licence (see `LICENSE`).
- DXCC entities and subdivisions: ADIF 3.1.6 enumerations (adif.org.uk). Entity positions: country-files.com.
- Maps: Natural Earth (public domain); us-atlas 3.0.1 (ISC); Japan prefectures from dataofjapan/land.
- Award lists:
  - JARL (JCC/JCG/KU)
  - rdaward.org (RDA)
  - DARC DOK lists via df2et.de
  - UARL (URDA)

  These belong to their publishers. Check their terms before redistributing them, or let users download them.
