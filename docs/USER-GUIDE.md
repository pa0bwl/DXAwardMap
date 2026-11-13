# DX Award Map: user guide

## Install
1. Download `DXAwardMap-<version>.zip` from https://github.com/pa0bwl/DXAwardMap/releases and unzip it to a folder of your choice, for example `C:\Ham\DXAwardMap`. Keep the folders `web`, `data` and `packs` next to `DXAwardMap.exe`.
2. Start `DXAwardMap.exe`.
   - **SmartScreen:** Windows may show a "Windows protected your PC" warning the first time, because the program is not code-signed. Click *More info*, then *Run anyway*.
3. A tray icon (blue circle with "DX") appears and the map opens in its own window. Close the window any time. Double-click the tray icon to open it again, or right-click it for *Open map*, *Settings*, *Reload log now* and *Quit*.

Nothing else needs to be installed. The program uses .NET Framework 4.8, Microsoft Edge and the Access database engine, all of which are part of Windows 10 and 11.

## First start: Settings
- **Log.** Choose where your QSOs come from:
  - **N3FJP Amateur Contact Log**: tick *Use N3FJP's active log*, or choose another `.mdb` file. The log is read live; new QSOs and LoTW/eQSL downloads show up within about 15 seconds. The database is only ever read from a temporary copy and never changed.
  - **ADIF file**: export your log from your logging program (Log4OM, DXKeeper, Logger32, HRD, ...) to a fixed file name and choose that file. When you export again to the same file, the map updates by itself.
- **What counts.** Which confirmations count as confirmed: LoTW, eQSL, paper card. Optionally show VHF/UHF bands.
- **Program.**
  - *Start with Windows*: the program starts in the tray when you log in.
  - *Port*: the local web port (default 8766).
- **Award lists.** The JCC/JCG/KU, RDA, DOK and URDA lists are downloaded from their official sites the first time the program starts, and refreshed when they are more than 30 days old. The table shows each list's own date. Press *Update* to refresh one now.
- **Field mapping.** Tells the program which field of your log holds each award's code. The defaults follow common habits; change them when you log differently. See below.

Press **Save settings**.

## Reading the map
- **Filters** (top): band, award, worked or confirmed, operator (if your log has more than one), exclude suspect QSOs, show deleted areas.
- **World**: every DXCC entity, coloured confirmed / worked / not worked for the chosen band. Small entities are dots. Click one for its band details.
  - *Entities* and *Still needed* list them.
  - *By band* shows one small map per band.
- **Country menu** (top right): every DXCC entity. Countries with an award pack open that award; the others open a country page with a map, the band table and all your QSOs with that country.
- **Award pages** (for example Japan, Russia, USA):
  - The map is coloured by the share of areas you have worked in each region. Click a region to see every area by band. A filled dot means confirmed, an open dot means worked, and a red corner marks a suspect code. Hover a dot for the QSO.
  - **Still needed**: areas you have not worked (or not confirmed) on the chosen band.
  - **Suspect QSOs**: codes that look wrong: not in the award list, logged after the area was deleted, outside the station's call area (portable /P stations excepted), or different codes in different fields.
  - **Missing codes**: QSOs with that country that have no code at all. Fill them in your logger.
  - **About**: the award list's source and date, and which log fields are read.

## Field mapping
Every award reads its code from one or more fields of your log, tried in order. For each field you can give a *pattern* (a regular expression) that picks the code out of a longer text; the part in the first brackets is used. *Combined with* joins two fields, for example state + county.

The bottom of the screen shows every field in your log for that country, how often it is filled, and example values. That makes it easy to see where your codes are.

Examples:
| You log | Field | Pattern |
|---|---|---|
| RDA in N3FJP Other2, like `MO-12` | fldOther2 | `([A-Za-z]{2}\s*-?\s*[0-9]{2})` |
| `JCC#1234` somewhere in the comments | fldComments | `JCC\s*#\s*(\d{4,6})` |
| US county in CNTY as `MD,Montgomery` (ADIF) | CNTY | (none) |

Press *Reset this pack to defaults* to undo your changes.

## Where things are stored
- Settings: `%APPDATA%\DXAwardMap\settings.json`
- Downloaded award lists: `%APPDATA%\DXAwardMap\packs`

## Problems and questions
- **"Could not read the log"**: check the log path in Settings. For N3FJP, *Use N3FJP's active log* follows the log N3FJP has open.
- **An award shows few areas**: open its *Missing codes* tab and *Settings → Field mapping*. Your codes are probably in a different field.
- **A list download fails**: the site may be down or have changed. The program keeps using the last downloaded copy. Try *Update* later.
- Report problems or suggest award packs at https://github.com/pa0bwl/DXAwardMap/issues.
