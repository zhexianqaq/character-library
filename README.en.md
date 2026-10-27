# Character Library

**English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.md)

> A self-hosted gallery for anime / cosplay material that runs entirely on your own machine.
> Images and videos live in a four-level tree — **library → entry → pack → images | videos** — and the
> folder layout on disk mirrors the UI one-to-one. Masonry browsing, tagging, a comic reader, drop-in
> archive extraction and incremental disk sync are all built in.
> **Nothing leaves your machine: no cloud, no upload, no telemetry.**

**It is not a scanner.** Material is *copied* into the library and stays editable; the source folder is never touched.

> The interface and all code comments are **Simplified Chinese only** — the app itself is not localized.
> This file is a short overview. The full manual (every screen, the API table, tuning notes, known issues
> and the whole version history) is in [README.md](README.md) (Chinese).

## Screenshots

**Library grid** — one card per entry, the badge in the corner is the pack count. The top bar holds
library switching and a global search box.

![Library grid](docs/screenshots/shelf-grid.jpg)

**Entry detail** — cover and counters on the left, source / aliases in the middle, packs below.
Switch to “all media” to see every file under this entry.

![Entry detail](docs/screenshots/character-detail.jpg)

## What it does

- **Five shelf types** — people (cosplayer + accounts), characters (grouped by work), resources
  (one card per work), emoji / loose images (flat), novels (in-app TXT reader + illustrations + comic
  bags). Plus an inbox shelf that collects unsorted files before you distribute them.
- **Four ways to get material in**
  - Drag & drop upload: up to 400 files at a time, 4 GB per file, with progress and per-file failure reasons
  - **Drop an archive**: zip / rar / 7z / tar.gz is extracted automatically, images and videos only.
    zip is parsed in-process (correct GBK filenames), **encrypted archives prompt for a password and remember it**
  - Bulk import from a folder: dedupe by sha256, build packs from dates in filenames, `--move` deletes the
    source only after verifying the library copy
  - **Desktop shell drag & drop**: a browser only receives bytes, the shell gets the real path — so the
    source file can be **deleted after a successful import**
- **Browsing** — chunked masonry (tens of thousands of tiles stay smooth), four sort keys, wide images
  spanning two columns, thumbnails generated at ingest time
- **Tags** — pack names like `character-outfit` are split into two tags automatically, every entry carries
  its own name tag, clicking a tag opens the tag page
- **Search** — the top-bar box covers shelf lists, entries, the resource library and resource detail;
  the server also matches tags (searching a fandom finds entries that only carry it as a tag)
- **Comic reader** — scrolling / single page / spread, right-to-left direction, fit-height or fit-width,
  fullscreen, wheel-to-turn, side rail collapses on narrow windows
- **Batch + keyboard** — Shift range select, Ctrl toggle, `Ctrl+A` select all, Delete, Esc, and a context
  menu on almost everything
- **Disk sync** — every rename / move / delete writes an operation record in the same transaction as the
  data change; the sync button only replays those, never scans the whole library, and never deletes a file
  it did not put there
- **Backup** — `VACUUM INTO` + sampled hash verification + MANIFEST, keeping the last 5 snapshots

## Tech stack

| Part | |
|---|---|
| Frontend | Plain ES modules, **zero build step** (no webpack / vite / bundler), CSS variables and hand-written components |
| Backend | Node 22 · Express 5 · better-sqlite3 · sharp (libvips) · ffmpeg |
| Desktop shell | Rust · tao + wry (WebView2) — a **689 KB single .exe**, statically linked CRT, no DLLs to ship |
| Storage | SQLite index + media files on disk; paths stored **relative** to the data root, so the library can be moved to another drive |

## Quick start

Node.js **20+** required (developed and tested on 22). The database is created on first run.

```bash
cd server && npm install && cd ..
start.bat          # starts the server and opens http://127.0.0.1:7788
```

The data directory defaults to `E:\CharacterLibrary`. Point it elsewhere with environment variables:

```bat
set CL_DATA_DIR=D:\MyLibrary
set CL_CACHE_DIR=D:\my-cache
start.bat
```

To get a double-clickable window instead of a browser tab, build the desktop shell (needs the Rust
toolchain and VS2022 Build Tools on Windows):

```bash
node desktop/build.mjs      # produces 资料库.exe in the project root
```

The .exe must stay in the project root — it looks upward for `server/src/index.js`. Put a shortcut on the
desktop rather than copying the executable somewhere else.

## Where the data lives

| Location | Default | What it is |
|---|---|---|
| Program | the repository folder | code, `web/`, `server/`, the .exe, `.cache` (thumbnails — safe to delete) |
| Data | `E:\CharacterLibrary` (`CL_DATA_DIR`) | original media + index `.catalog\library.db` |
| Backup | `E:\CharacterLibrary-Backup` (`CL_BACKUP_DIR`) | one timestamped folder per run, last 5 kept |

Put data on a spinning disk (large, sequential reads) and the cache on an SSD (random reads).

## Known limitations

- 4 GB per file, 400 files per upload (archives included)
- rar / 7z extraction needs 7-Zip or WinRAR installed (Windows' bundled `tar.exe` also works); zip needs nothing
- `mkv` / `avi` may not play in the browser
- Moving media between packs inside one entry only updates the database — files are moved on the next sync
- The desktop shell is Windows-only (WebView2); the web app itself runs anywhere Node runs
- **The interface is Chinese only.** There is no i18n layer and no plan to add one.

## License

Personal project, **no open-source license declared** (All rights reserved). The code is public so the
implementation can be read and issues can be filed; that does not grant commercial use or redistribution.
