# Character Library

**English** · [日本語](README.ja.md) · [한국어](README.ko.md) · [繁體中文](README.zh-TW.md) · [Русский](README.ru.md) · [Français](README.fr.md) · [简体中文](README.md)

> A local gallery for anime / cosplay material that runs entirely on your own machine (the Chinese name is 资料库).
> Images and videos live in four levels — **library → entry → pack → images | videos** — and the folder
> structure on disk mirrors the UI one-to-one. Masonry browsing, tagging, a comic reader, drop-in archive
> extraction, incremental disk sync and batch operations are all built in.
> **Everything stays on your machine: no cloud, no upload, no telemetry.**

**It is not a scanner.** Material is **copied into** the library and stays editable; the source folder is never touched.

| Part | Technology |
|---|---|
| Frontend | Plain ES modules, **zero build step** (no webpack / vite / bundler), one set of CSS variables + hand-written components |
| Backend | Node 22 · Express 5 · better-sqlite3 · sharp (libvips) · ffmpeg |
| Desktop shell | Rust · tao + wry (WebView2), **a 1.4 MB single-file exe** (icon and version info compiled into the PE), statically linked CRT, no DLL dependencies |
| Storage | SQLite index + media files on disk; paths are stored **relative**, so moving the library to another drive needs no data change |

This page documents **v3.74** (2026-10-29), 90 tags. The e2e suite (`npm test` in `server/`) runs 140 cases before a release.

## Screenshots

**Library grid** — one card per entry, the badge in the corner is the pack count; the bar on top switches
libraries and its search box covers the whole library.

![Library grid](docs/screenshots/shelf-grid.jpg)

**Entry detail** — cover and counters on the left (images / videos / packs / disk usage), source and aliases
in the middle, packs grouped underneath. The top-right toggle switches to “all media” for every file under
this entry.

![Entry detail](docs/screenshots/character-detail.jpg)

## What it does

- **Five shelf types**: people (platform accounts), characters (grouped by work), resources (one card per
  work), emoji / loose images (flat), novels (in-app TXT reader + illustrations + comic bags). Plus an
  **inbox library** that collects unsorted files before you distribute them.
- **Four ways to feed it**
  - Drag & drop upload: 400 files per batch, 4 GB per file, with progress and a reason for every failure
  - **Drop an archive**: zip / rar / 7z / tar.gz is extracted automatically, images and videos only; zip is
    parsed in-process (Chinese GBK filenames stay intact), **encrypted archives prompt for a password and
    remember it**, a wrong password asks again
  - Bulk import from a folder: dedupe by sha256, packs built from month in the filename; `--move` deletes the
    source only after verifying the library copy
  - **Desktop shell drag & drop**: a browser only receives bytes, the shell gets the real path — so the
    **source file on disk is deleted right after a successful import**
- **Browsing**: chunked masonry (tens of thousands of tiles stay smooth), four sort dimensions, wide images
  spanning two columns, thumbnails generated at ingest time
- **Tags**: a pack name like `character-outfit` splits into two tags automatically, an entry's own name
  becomes a tag, clicking a tag opens the tag page
- **Search**: the top bar covers library lists / entries / resource library / resource detail; the server
  also matches tags, so searching a fandom surfaces entries that only carry it as a tag
- **Comic reader**: scrolling / single page / spread, right-to-left direction, fit-height / fit-width,
  fullscreen, wheel-to-turn, side rail collapses on narrow windows
- **Batch & keyboard**: Shift range select, Ctrl toggle, `Ctrl+A` select all, Delete, Esc, and a context menu
  on almost everything
- **Disk sync**: every rename / move / delete writes an operation record in the same transaction as the data
  change; the sync button only replays those, never scans the whole library, and never deletes a file it did
  not put there
- **Backup**: `VACUUM INTO` + sampled hash verification + MANIFEST, keeping the last 5 snapshots

## Quick start

Requires **Node.js 20+** (developed and tested on 22). The database is created on first run.

```bash
cd server && npm install && cd ..
start.bat          # start the server → browser opens http://127.0.0.1:7788
```

**The program itself defaults to `D:\character-library` (the repository folder) and the media plus index to `E:\CharacterLibrary`** — program on D:, resources on E:. The data folder can be moved with environment variables:

```bat
set CL_DATA_DIR=D:\MyLibrary
set CL_CACHE_DIR=D:\my-cache
start.bat
```

If you want “double-click one file and it works”, build the desktop shell — see [Desktop shell](#desktop-shell-single-file-exe) below.

## Contents

- [Quick start](#quick-start)
- [Screenshots](#screenshots)
- [Hierarchy](#hierarchy) — the structure of the five shelf types and what each one's “extra column” holds
- [Data model and scale](#data-model-and-scale)
- [Feature index](#feature-index) — **which version introduced what**
- [How to add material](#how-to-add-material) — upload / filters / detail page / tags / context menus / keyboard / batch
- [The three folders](#the-three-folders) — program / data / backup kept apart
- [Storage layout](#storage-layout)
- [Backup](#backup)
- [What happens when a file operation fails](#what-happens-when-a-file-operation-fails)
- [API](#api)
- [Bulk import from an external folder](#bulk-import-from-an-external-folder)
- [Performance](#performance-measured-on-an-ordinary-desktop)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Version control](#version-control) — commit / tag / push conventions, lookup, rollback
- [Version history](#version-history) — the full v2.0 → v3.74 table
- [CHANGELOG.md](CHANGELOG.md) — per-version detail and the traps hit along the way (Chinese)

> Other languages (Japanese / Korean / Traditional Chinese / Russian / French) carry a condensed overview;
> this English page and the Chinese original are the complete manuals.

### Desktop shell (single-file exe)

`资料库.exe` is a ~700 KB native shell (Rust + WebView2) that does exactly three things: start the local Node
service, open `http://127.0.0.1:7788` in WebView2, and make F5 / Ctrl+R reload.
**The page is still the same `web/` folder — not a single line of HTML was changed.**

| Behaviour | Detail |
|---|---|
| Single file | Statically linked CRT, no DLLs; only needs the system WebView2 Runtime (built into Win10 1803+ / Win11) |
| Finding Node | `AMS_NODE` → `PATH` → `Program Files\nodejs` → WorkBuddy's bundled folder; if none is found it shows an explanation page |
| Reusing a service | If a healthy service already listens on the port it connects to it (e.g. one started from `start.bat`) instead of fighting for the port |
| Closing | The window disappears instantly and cleanup finishes in ~200 ms in the background (it asks the service to checkpoint before exiting, so nothing is lost); a service it did not start is left alone |
| Port conflict | Says clearly that the port is taken by another program; `AMS_PORT` switches ports |
| Reload | F5 / Ctrl+R — the injected script intercepts them in the capture phase and leaves the page's own keyboard logic alone; WebView2's default context menu also has “Reload” |
| Logs | `%LOCALAPPDATA%\ams-desktop\shell.log` (shell), `server.log` (Node output) |

Rebuild only when the shell code changes:

```bash
node desktop/build.mjs      # cargo build --release + copy to 资料库.exe in the project root
```

Needs the Rust toolchain + VS2022 Build Tools. **The exe must stay in the project root** — it walks upward
from its own location looking for `server/src/index.js`; make a shortcut if you want it on the desktop, do not
copy the exe somewhere else.

## Hierarchy

```
Library (My library)
 ├ People      ← real people
 │  └ Person (name / intro / tags / platform accounts)
 │     └ Pack (by month, or created by hand)
 │        └ Images / Videos
 ├ Characters  ← fictional characters
 │  └ Character (name / intro / tags / source)
 │     └ Sub-library (official / cosplay / fanart)
 │        └ Pack (by month)
 │           └ Images / Videos
 ├ Loose       ← loose / misc images (flat library: packs and all media only)
 │  ├ Pack (by month or a custom name; cover = first 9 images)
 │  │  └ Images / Videos
 │  └ All media (includes every pack)
 ├ Emoji       ← reaction images (flat library, no entry level)
 │  ├ Pack (custom name; cover = first 9 images)
 │  │  └ Images / Videos
 │  ├ Uncategorized (not in any pack)
 │  └ All media (includes every pack)
 ├ Resources   ← games / anime / films / series (flat library)
 │  └ Resource (Genshin…) ── ties entries in People / Characters together via a “same-name tag”
 ├ Novels      ← original / fanfic libraries (one entry per book)
 │  └ Novel (title / genre or source work / author / word count / intro)
 │     └ Uncategorized / Files
 └ Inbox       ← staging area + whole-library overview (no file copies)
    ├ Undistributed   ← whatever sits in Inbox/Uncategorized/Images|Videos
    └ Distributed     ← read-only aggregate of every other image / video in the library
```

Every library follows “library → entry → pack → images/videos”; **what differs is the extra column on the entry**
(loose, emoji, resources and inbox are flat libraries with no entry level):

| Library | Extra column | What goes in | What a click does |
|---|---|---|---|
| People · real | **Platform** | Platform + ID (profile URL optional) | Opens the URL if there is one, otherwise copies the ID |
| Loose · flat | — | — | — |
| Emoji · flat | — | — | — |
| Resources · flat | — | Category (game / anime / film / series) | — |
| Inbox · flat | — | — | — |
| Characters · fictional | **Source** | Type + work title (link optional) | Opens the link if there is one, otherwise copies the title |
| Novels · original | **Genre** | Xuanhuan / Xianxia / Urban… (also the disk folder) | — |
| Novels · fanfic | **Source work** | The original work's title (disk folder + added as a tag) | “Work page ↗” opens the resource detail |

Source-type presets: game / anime / comic / novel / film / series / tokusatsu / stage play / fanwork / original
(you can type your own as well).

**Sorting packs**: the pack-view toolbar has a dimension dropdown plus an ascending/descending arrow
(time ↓ = newest first, most media first). Four dimensions: name / time / media count / disk usage; ties break
on name ascending, so packs created in the same month never shuffle. Sorting is local only (no refetch) and the
chosen dimension is remembered across entries.

**Sorting media inside a pack**: after opening a pack, the same control sits to the right of “N items” in the
toolbar. Dimensions become name / time / size / type — type puts images first and videos last, so reversing the
order makes videos immediately reachable among hundreds of images. Time prefers the date in the filename and
falls back to the ingest time (batch imports share almost the same ingest timestamp, so sorting by it alone
would be meaningless); the default is name ascending. It only affects display order — nothing is written to the
database and `media.sort_order` is untouched. The ← → sequence on the media detail page follows this order, so
after sorting by size, opening the first image and paging forward keeps the size order.

**Sub-libraries (characters only)**: every character splits into three sub-libraries — `official` / `cosplay` /
`fanart` — each with its own monthly packs. Three tabs with their pack counts sit above the pack area; uploads
and “+ Pack” land in whichever is selected, on disk at
`Characters/<character>/<sub-library>/<pack>/images|videos`.

**Loose library (flat)**: for images you save on a whim, no entry level, only two tabs — **Packs / All media**.
There is no “uncategorized” section (an upload without a target pack is filed by the month in its filename, or
the current month when there is no date), and none of the emoji library's “animated / static” filters.

**Emoji library**: no entry level; the library is directly split into “packs / uncategorized / all media”.
A pack cover is a **3×3 mosaic of the first 9 images** (2×2 or a single tile when there are fewer, gaps filled
with light grey). The disk path has one level less than other libraries: `Emoji/<pack>/images|videos`, and files
outside any pack land in `Emoji/uncategorized/images`. Clicking the “Emoji” tab on the home page expands the
content in place (like People / Characters) and the URL stays at `/s/:id`.
**Emoji, resources, novels and inbox never navigate away** — only the content changes.

**Resource library (the fourth library)**: a card *is* the work itself. Create a card (say “Genshin”), then tag
entries in People / Characters with “Genshin” (or write it as their source) and they show up under the Genshin
detail page automatically. **There is no relation table — the tag is the relation.**

- Clicking a related card opens `/c/:id?res=Genshin`: the character page then shows only packs carrying that
  tag, with a “from resource” banner and a one-click “show all”
- Clicking “Genshin” on an entry's source jumps straight to the resource detail; Back walks back level by level

**Tags have their own landing page, `/tag/:name`**: a tag on an entry page, next to a pack title, or on a media
detail page all lead here, with three sections — “entries / packs / media” (media lists the most recent 200, the
total count is honest). A tag can only come from three places: **the entry name** (built in), **the pack tags**
(split from the name + the owning entry's name), and **tags a single image carries**. Library identity like
“people / characters / novels” is not a tag and never shows up there. When editing tags the selected ones are
listed first, and pasting a whole `character-outfit` string splits it into two on Enter.

**Novel library (the fifth library)**: one entry per book, in two variants — **original** (grouped by genre) and
**fanfic** (grouped by source work). The key point is that **the two layers never interfere**:

| Layer | What it is | On disk? |
|---|---|---|
| Category view | Original “all / published / web”, fanfic “all / short / long” | No, filter only (`novel_subtype`) |
| Grouping folder | Original = genre (Xuanhuan / Xianxia…), fanfic = source work | Yes, one directory level (`novel_group`) |

- Published / web and short / long are **single attributes of a book**; making them folders would split books of
  the same kind in half, so they stay filters
- Disk layout has three levels: `Novels/<genre or source>/<title>/uncategorized/files` (no video level — novels
  hold no video)
- Genre / source work **can be renamed**; renaming moves the directory and rewrites the `rel_path` of every
  media row in it
- The hero column (genre / source work) is a read-only projection of the grouping folder; for fanfic that
  matches a resource-library work, clicking opens that work's resource page, clicking elsewhere opens the editor
- The source work typed into a fanfic entry **becomes a tag automatically**, so the resource card's “related
  entries” count goes up and clicking it lists the fanfic
- Without a cover the card shows the **book title** as a placeholder (it never borrows the work's cover)
- Titles must be **unique within a library** (409), because the title is also the directory name

**Novel bags**: a bag materialises the genre / source-work entity of that library (`packs.kind='novel'`, hung
under the library's container entry) and holds many books. The home page is a grid of bags; open one to see its
books. A bag **only appears when the current category view has books in it** — the “published” view never shows
a bag full of web novels — and empty bags take no slot (a newly created bag goes straight to its own page).

**Body files**: TXT / EPUB / PDF / MD / DOC(X) arrive as `media.kind='file'`, land in
`<book>/uncategorized/files`, belong to no pack, never enter the image masonry and never show up in the media picker.

- TXT: `/read/:id`, read in-app. Encoding: BOM → strict UTF-8 → GB18030 (old web novels are usually GBK).
  Chapters split on whole lines like “Chapter X / volume / prologue / interlude”; if nothing matches the whole
  book is one chapter. A table-of-contents drawer, A− / A+ font size, and position (chapter + ratio inside the
  chapter) are stored in localStorage; ← → change chapters, Esc goes back.
- EPUB: **this release only stores and downloads it** — parsing it in-app would mean shipping unzip + OPF
  parsing, which does not pay off in a zero-build project.
- PDF: handed to the browser (`/api/media/:id/raw`, with Range support).

**Comics**: `packs.kind='comic'` + `media.page_no`, and page order is **completely separate** from pack
sorting — sort a pack by “size” and the comic is still page 1, 2, 3.
- Converting: right-click a pack card or the empty area of a pack page; only `kind` and `page_no` change, files
  are not moved, cover and tags stay, and you can convert back at any time. Page order follows the natural order
  of filenames (`1, 2, 10`, not `1, 10, 2`); converting back clears `page_no`.
- If the pack contains videos it first asks to “convert images only”; videos stay in the pack but do not take
  part in reading (`page_no` stays NULL).
- Comic mode on a pack page: a “comic” badge next to the title, “N pages” + read in the toolbar, sorting
  controls hidden, page numbers in the tile corner, and clicking an image starts reading at that page.
- The reader at `/cm/:id` has three modes sharing one top capsule and one bottom progress slider:
  - **Scroll**: continuous vertical; page height is reserved from the dimensions stored in the database (so the
    scrollbar length is right from the start), and pages load 1200 px before entering the viewport with the
    neighbours prefetched.
  - **Single page**: one page per screen; **fit-height** puts the whole page on screen, **fit-width** lets it
    touch both edges (scrolling the stage when it overflows).
  - **Spread**: left/right facing pages, page 1 stands alone as the cover, then (2,3) (4,5)…; turning a page only
    swaps `src`, nodes are never rebuilt.
  - **Direction**: left→right / right→left. In right-to-left the first page lands on the right and arrow keys,
    click zones and swipes all swap (that is how Japanese manga reads).
  - Controls: ← → / PageUp / PageDown / Space / Home / End, `1 2 3` switch modes, `F` fullscreen, `Esc` back;
    in single/spread mode clicking the right 35 % turns forward and the left 35 % back; touch devices swipe; in
    fullscreen the controls fade out after 2.4 s idle.
  - **Wheel / trackpad turns pages** in single and spread mode (one page per notch, a pair in spread); in
    fit-width a page is taller than the screen, so the page scrolls to the end first (60 px accumulation with a
    420 ms cooldown, so trackpad inertia cannot fly through pages).
  - **Fullscreen applies to the whole page (`<html>`)**, not to `.comic` — when an element itself goes fullscreen
    the document stops scrolling and scroll mode deadlocks.
  - **Side rail**: in single / spread mode, if at least 92 px of margin remain on both sides, the top bar
    collapses — back / page number / vertical progress on the left, mode / direction / fit / fullscreen on the
    right; without enough margin it falls back to the top bar + bottom slider.
  - Progress is stored as “which page”, so switching modes or leaving and returning lands on the same page;
    `?p=N` jumps directly; preferences live in `cl-comic:prefs`.

**Scroll position rules**: stored per path in `sessionStorage` (`cl-scroll:<path>`), updated on `pagehide` and
while scrolling.

- **F5 reload**: back where you were (you were standing right there)
- **Forward / back**: back where you were (list → detail → back, the list stays where it was)
- **Following a link**: always starts at the top — you must not land halfway down just because you scrolled here
  last time

The entry page's “packs / all media” follows the same idea: the view is recorded in the history entry
(`history.state.tab`), so opening an image from “all media” and pressing ✕ returns to “all media”, at the same
position.

The browser's automatic scroll restoration is turned off (`history.scrollRestoration = 'manual'`) because it
jumps before the document has any height and lands on 0.

**There is no longer an “account / source” field in the top right**: it duplicated “source / platform” and was
merged into the right-hand column of the detail page. Old account values were folded into the platform column
once (the platform name recorded as “Other”, editable by clicking).

**The source dialog** is “source type + work title”, both columns are **dropdown + free text**:

- Source type: game / anime / comic / novel / film / series / tokusatsu / stage play / fanwork / original, or
  type your own
- Work title: lists **resources that already exist in the resource library**; picking one links to it. Saving a
  new title **creates a card in the resource library automatically**, with the category taken from the source
  type you chose (a new type adds a new category tag).

Creating a library: the **＋** next to the library tabs on the home page, then a name and a type. The new library
gets a directory of the same name on disk (`E:\CharacterLibrary\<library name>\`), and creating entries or
uploading files expands the five levels automatically.

## Data model and scale

One library is one directory. The hierarchy is fixed at four levels and disk matches the UI exactly:

```
<data dir>\<library>\<entry>\<pack>\<images|videos>\
```

Flat libraries (emoji / loose) skip the entry level and go `<library>\<pack>\<type>\`; the novel library is
`<library>\<genre>\<title>\<uncategorized>\files\`. A mid-sized library looks roughly like this:

| Library | Entries | Packs | Media | Notes |
|---|---|---|---|---|
| People | a dozen or so | 10~60 per person | a few hundred per person | cosplayers / photo sets, packs by month or outfit |
| Characters | 1000+ (grouped by work) | one “official” pack per character | hundreds | built from a name list, source = work title |
| Emoji | flat (no entries) | 3~10 | thousands, mostly animated | split by origin |
| Loose | flat | created by month | whatever | images saved on a whim, never produces “uncategorized” |
| Novels | one per book | volumes / illustrations (optional) | — | TXT read in-app, EPUB downloaded |
| Resources | one card per work | one “official” pack per work | optional | interrelated with characters via “same-name tag + source” |
| Inbox | — | — | pending distribution | collect a pile first, distribute afterwards |

A complete path through the app: drop in an archive → extracted and ingested (images and videos only) → packs
built from dates or outfits → pack names split into tags → found again via the top-bar search or a tag page →
open the detail page for the full image, or jump into the comic reader.

## Feature index

“Since” = the tag where the feature first appeared. Later patches are noted in brackets.

### Libraries and hierarchy

| Feature | Since | Notes |
|---|---|---|
| Multiple libraries side by side | v2.0 | Any number of libraries under one root; `shelves.kind` decides the semantics (people / characters / emoji / resources / novels) |
| Character “sub-libraries” | v3.0 | official / cosplay / fanart, one extra disk level: `library/character/sub-library/pack/images·videos` |
| Loose library (flat) | v3.39 | No entry level, only **packs / all media**; uploads are filed by month automatically, there is no “uncategorized” tab |
| Emoji library (flat) | v3.8 | No entry level, directly “packs / uncategorized / all media”; cover = first 9 images |
| Resource library | v3.9 | The card *is* the work; a **same-name tag** ties entries in people / characters to it, no relation table |
| Entry directory lifecycle | v3.16 | Creating an entry immediately creates `<library>/<entry>` + `uncategorized/images`, `uncategorized/videos` (novels only get `uncategorized/files`, v3.24) |
| Creating a library creates its directory | v3.19 | mkdir on create, so the resource / novel libraries are no longer empty on disk |
| Resource “official” pack | v3.21 | Every work gets one pre-made official pack you can upload official art / video into |
| Novel library | v3.24 | Two variants, original / fanfic; **the category view only filters, genre / source work is the disk directory** |
| Novel bags | v3.32 | A real folder per genre / source work (`packs.kind='novel'`) holding several books; home page is a bag grid |
| Empty bags hidden | v3.34 | A bag only appears when the **current category view** has books; a newly created empty bag opens its own page |
| Novel body files | v3.34 | `media.kind='file'` (txt / epub / pdf / md / doc / docx) lands in `<book>/uncategorized/files`, novels only, never in the masonry |
| TXT reader | v3.34 | `/read/:id`: BOM → UTF-8 → GB18030 detection, chapters split on “Chapter X / prologue”, TOC / font size / position memory |
| Comic packs | v3.34 | `packs.kind='comic'` + `media.page_no`; page order follows filename natural order, independent of pack sorting |
| Comic reader | v3.35 | `/cm/:id`: **scroll / single page / spread**, left→right / right→left, fit-height / fit-width, fullscreen, progress slider, click / swipe / keyboard paging |
| Reader side rail | v3.36 | In single / spread mode with margin on both sides, controls move into two vertical rails (including a vertical progress bar) and the page uses the full height; falls back to the top bar when margin is short |
| Pack context menu | v3.36 | Open · edit pack · edit tags · open local folder · convert to comic · dissolve · delete; people libraries do not offer comic conversion |
| Splitting tags out of pack names | v3.37 | `character-outfit` becomes two tags (“character”, “outfit”) with the same rules on create / rename / import, so linked packs can attach; pure dates and names containing numeric segments are left alone |
| Packs carry the entry-name tag | v3.38 | Every pack automatically carries a tag named after its entry, so searching an entry name lists all its packs; a startup migration backfills it idempotently |
| Tag page | v3.38 | `/tag/:name`: three sections (entries / packs / latest 200 media); tags on entry pages, pack pages and media pages all lead here |
| Selected tags first | v3.38 | When editing tags the selected ones sit at the top with a count, no hunting through 1500+ entries for the dark ones |
| Library identity tags removed | v3.38 | Media no longer inherit “people / characters / novels”; a self-added tag on the media page is removed only by clicking × |
| Eject packs from the library | v3.36 | “Eject” in pack multi-select: every file goes back to the inbox → undistributed, then the empty pack is dissolved |
| Pack ⇄ comic | v3.34 | Convert from the pack card menu or the empty area of a pack page; only type and page order change, files / cover / tags stay; asks “images only” when videos exist |
| Inbox library | v3.26 | Flat: undistributed = whatever is in `<library>/uncategorized`, distributed = read-only aggregate of the rest |
| Library overview bar | v3.28 | A row of cards under the inbox title: entry / media / disk usage per library plus a share bar; clicking a card switches library |
| Flat libraries open in place | v3.26 | Emoji / resources / novels / inbox no longer navigate to `/e` `/rs` `/n` `/x`; the content is embedded on the home page |
| Distributing media | v3.26 | Select → choose library / entry / pack, files move from `uncategorized` to the target directory (across libraries and entries) |
| Eject media | v3.26 | Context menu / detail page / batch multi-select sends media back to `inbox → undistributed`; identical content is merged |
| Novel rename moves the directory | v3.24 | Changing the title or genre / source work moves the directory and rewrites `media.rel_path`; a database failure moves it back |

### Entries and cards

| Feature | Since | Notes |
|---|---|---|
| Platform / source column | v2.0 · v3.11 | People fill “platform + ID”, characters fill “source type + work title”; clicking a card with a URL opens it, without one it copies |
| Aliases column | v3.27 | Right of the source, left of the intro; short name / Japanese name / English name, for people, characters and games / anime / films / series |
| 3:4 covers | v3.4 | All cards are 3:4; people / characters without a cover show a placeholder, novels show the **title** |
| Entries carry their own name tag | v3.4 | Every entry automatically carries its own name tag; deleting it brings it back |
| Source merged into the source column | v3.11 | The separate “account / source” field in the top right was removed and old values folded into the platform column |
| Batch create | v3.11 · v3.17 · v3.18 | Both Chinese and English commas split; switching libraries mid-way cannot leak into the wrong one; resources support it too |
| Cards sort by count by default | v3.22 | People / characters = media count, resources = related count, emoji = media in packs; a `count` dropdown on the right changes it |
| Pack sorting | v3.26 | Name / time / media count / disk usage, with an arrow for ascending · descending; shared by entry pages, the emoji library and resource pages |
| Media sorting inside a pack | v3.29 | Images / videos by name / time / size / type, arrow for ascending · descending; the detail page's paging order follows |
| Novel cards | v3.24 | No cover means the title as a placeholder, with a small badge for publication type / length |
| Novel edit form | v3.30.1 | Six fields in two columns, intro spans the full row; novels have no aliases field (write the original / translated title in the intro) |

### Media and masonry

| Feature | Since | Notes |
|---|---|---|
| Filing by date in the filename | v1.0 | Unrecognised dates go to “uncategorized” |
| Masonry | v1.0 · v3.7 | Fixed 120 px columns (before v3.7 it was container-adaptive, minimum 280), 8 px gaps, column count from the container width |
| Upload queue | v3.3 | Multi-select / drag & drop / progress, 400 files and 4 GB per file |
| Archive extraction | v3.41 | Drop a zip / rar / 7z and it is extracted: onto a pack page it joins that pack, onto an entry page it creates a pack named after the archive; zip is parsed in-process (GBK names intact), rar / 7z go through 7-Zip / UnRAR / bsdtar |
| Filtering all media | v3.6 | Type / tag / pack / sort |
| Hover playback | v3.9 | **Animated** tiles swap to the original playing and enlarge on hover (videos do not take part, see below) |
| Wide media spans two columns | v3.14 | width/height > 1.7 takes two columns (248 = 2×120+8), absolutely positioned |
| Threshold and placement | v3.20 | Threshold 2 → 1.7 (16:9 also spans); wide items score `2×hi − lo`, holes halved |
| Video covers | v3.25 | “Set as video cover” next to the player grabs the current frame as the thumbnail, restorable |

### Tags

| Feature | Since | Notes |
|---|---|---|
| Tag system | v3.1 | Tag dialog; duplicates + similarity check (contains = 0.9 / bigram Dice ≥ 0.5 blocks first, can be forced) |
| Media inheritance | v3.1 · v3.12 · v3.15 | Own tags ∪ entry name ∪ library type ∪ **pack tags** (library-wide since v3.15); generic tags on the entry do not cascade |
| Tag click opens the library | v3.11 | Clicking a resource / work name jumps to the matching resource detail or entry page |

### Detail page and viewing

| Feature | Since | Notes |
|---|---|---|
| Media detail page | v3.4 | Image on the left, info on the right, `←` `→` page within the same pack |
| Vertical constraints | v3.4.1 | Tall images / portrait videos fit the viewport; videos keep their own aspect ratio with no black bars |
| Paging does not stack history | v3.4.2 | Paging replaces the current history entry, so one `✕` exits |
| Video autoplay | v3.5 | Muted + loop is required for autoplay; use the volume button for sound |
| Set as cover | v3.13 | Any media can become a pack cover or an entry cover |
| Reveal in folder | v3.5 | Images and videos are **selected** in Explorer; a pack opens its own root folder |

### Interaction and keyboard

| Feature | Since | Notes |
|---|---|---|
| Context menus | v3.2 · v3.10 | Tiles, packs, platforms and empty areas each have one; the resource library too |
| Rename / move | v3.2 · v3.4 | Rename media, move to another pack (database only, no file move); renaming also works at the bottom of the detail page |
| Multi-select and shortcuts | v3.5 · v3.13 | Shift range, Ctrl toggle, Delete, Enter to open; **`Ctrl+A` select all** (v3.44: no need to click “select” first, one press enters selection and fills it) |
| Custom dropdowns | v3.6 · v3.7 | Native selects render as a system-blue bar, so they were replaced with in-app dropdowns; datalist / select inside dialogs use it too |
| Layered Esc | v3.12 | Stack based: whoever opens pushes, and one Esc only closes the top layer |
| Entry page view memory | v3.26 | “packs / all media” is stored in `history.state.tab`, so closing a detail page returns to the same screen |
| Search does not lose focus | v3.17 | Search only repaints the list container, the top-bar input is not rebuilt |
| Sync folders | v3.45 | Disk directories follow pack names: rename renames the directory, delete reclaims empty ones, scattered packs and unassigned media are merged back; no file is ever deleted |
| Operation log / incremental sync | v3.46 | Every change records one row (pending / applied / verified) and the sync button only replays those instead of scanning the library; moving between packs inside an entry, dissolving a pack and creating an empty pack now wait for sync |
| Top-bar search | v3.43 | People / character lists search name · aliases · tags; entry pages, the resource library and resource detail all have a top-bar search: pack view filters packs, all-media view filters media (the default “unassigned” filter steps aside automatically) |
| Infinite scroll | v3.31 | In the inbox, reaching the bottom pulls the next batch and stops when the screen is full; the button remains for retries |
| Create a pack while moving | v3.31 / v3.38.1 | The “target pack” input accepts a new name: reuse if it exists, create if not; batch move and the single-media context menu share it |
| Enter selection from a context menu | v3.31.1 | The second item in the media context menu is “select this media”, so you do not have to scroll back to the top; while selecting it reads “exit selection” |
| Packs get an automatic name tag | v3.31.2 | Creating / renaming adds a tag with the pack's name, inherited by its media; manually added tags are untouched |
| Cross-library linked packs | v3.33 | A pack in another library whose tags contain this entry's name is attached to the entry page (characters go into the cosplay column; nothing is copied or moved) |

### Engineering and operations

| Feature | Version | Notes |
|---|---|---|
| Static asset version prefix | — | `/a/<ver>/js/main.js`, ver = newest mtime under `web/`; frontend changes apply without a restart |
| Backup script | v2.0 | `VACUUM INTO` snapshot + cross-drive copy + MANIFEST, keeps 5 by default |
| External import CLI | v2.0 · v3.23 · v3.40 | `import-cli` one directory per entry; `import-emoji` splits by subdirectory; `--move` deletes the source after ingest |
| End-to-end tests | v3.x | CDP real clicks / real uploads, **140 cases**; plus `shot.mjs` for screenshots and `inspect.mjs` for DOM queries |
| Global error middleware | v3.24 | API errors always return JSON, so the frontend toast is no longer `Unexpected token <` |
| Orphan cover cleanup | v3.25 | Scans `.covers` at startup and removes covers without a media row and empty buckets |
| File operation reliability | v3.26 | Failed deletes honestly return 409; cross-entry moves write a journal and roll back on failure; a name clash compares the full sha256 |
| Backup hardening | v3.26 | Verifies every row against the snapshot + sampled hashes; failures isolated into `.failed`; restore instructions written into the backup |
| Detail page loading | v3.30 | First paint waits for a single detail request; paging reuses the fetched list, requests only the current item and prefetches neighbours |
| Large list rendering | v3.30 | Masonry inserts at most 80 tiles per frame; “load more” appends without repainting loaded cards |
| Upload refresh merging | v3.30 | Only covers of the packs written to are refreshed; entry counters merge leading + trailing into one |
| Overview cache | v3.30 | `/api/overview` has a 1.5 s TTL and is invalidated by successful writes; embedded views reuse the parent's data |

## How to add material

1. **＋ New person / new character** in the top right of the home page (the label follows the current library) —
   fill in a name and an intro. Separate names with a **Chinese or English comma** (`Shenhe, Raiden Shogun`)
   to create several at once
2. Open the detail page and click **＋ Upload media**, or simply **drag files / a whole folder onto the page**
3. After upload, files are **filed into the month named in their filename** automatically; without a date they go
   to “uncategorized”
4. You can also click **＋ Pack** to create a monthly pack by hand; packs can be renamed / deleted (deleting only
   removes the grouping, it does not delete media)

The detail page also lets you edit the intro (click it and it becomes an input), add tags and change the cover.

### Adding content to a pack: four sources

The **＋** on a pack card, **Add media** in the card's context menu, and **＋ Add media** in the top right of a
pack page all open the same menu:

| Source | Scope |
|---|---|
| From all media | The whole library, **including other entries** |
| From this character's media | Only the current entry |
| From unassigned media | Whatever is not in a pack yet |
| Upload from local files | Goes through the upload queue |

What opens is a **media picker**: the scope can be switched again (all / this character / unassigned / in a
pack), filtered by type, searched by filename or tag, auto-loads the next page at the bottom, and adds several
selected items at once. Media already in the target pack is greyed out and sorted last, so the picker is usable
the moment it opens; picking media from another entry marks the origin and the footer says “N of these come from
other entries and will be moved”.

> Adding inside the same entry only changes the grouping, files stay put.
> **Adding across entries changes ownership**: files move into the target entry's pack directory and disappear
> from the original entry. Duplicates are checked first and skipped when the target entry already has the same
> content.

### Upload

- Character pages, pack pages and the upload page all support **drag & drop**, including a whole folder (files
  are collected recursively)
- **Drop an archive**: zip / rar / 7z / tar.gz is extracted automatically and only the images / videos inside are
  ingested. Dropped on a pack page it joins that pack; dropped on an entry page it creates a pack named after the
  archive (reusing an existing one with the same name); dropped on the inbox it lands in “uncategorized”.
  `__MACOSX`, `Thumbs.db`, readme files and the like are ignored.
- Uploads run **one file per request, 3 in parallel**, so every file has its own progress and its own failure reason
- A progress capsule appears in the bottom right; clicking it opens the **upload queue page `/uploads`**: overall
  progress (bytes / speed / remaining), per-file state, retry for failures, clear for finished items
- Uploads keep running in the background, so browsing other pages does not interrupt them; when everything on the
  current page is done the data refreshes automatically
- Dropping files on the upload page first asks which entry / pack they should go to
- **Only one copy is kept**: files land in the `.cache/inbox` staging area first, and the moment ingest succeeds
  (the cross-drive copy into the data disk) that staged copy is deleted; nothing in the data disk is ever touched
  by a cleanup. Historical leftovers can be counted with `cd server && npm run sweep-inbox` and removed with
  `npm run sweep-inbox -- --apply` — only files whose sha already exists in the library **and whose row points at
  a file that really exists** are deleted, everything else is kept.

### Inbox: collect a pile, then distribute

Import a batch of images from your phone, or save a bunch of videos on a whim — drop them into the inbox first and
decide who they belong to afterwards.

| Section | What is in it | Where the files are |
|---|---|---|
| Undistributed | Media without an owner yet | `inbox/uncategorized/images\|videos`; dragging onto the page or clicking “collect media” lands here |
| Distributed | Every other image / video in the library, **linked, not copied** | Each entry's own directory; opening one still goes to `/i/:id` |

- Both sections split further into “all / images / videos”; the top-bar search matches filename, tag, entry name
  and pack name
- **Select → Distribute to…**: pick a library → an entry → a pack (or “＋ new pack (today)”) and the files
  **move** from `uncategorized` into the target entry's pack directory, with `character_id` / `pack_id` /
  `rel_path` all updated
- Moving reuses the cross-entry machinery: write the journal intent → move the file → write the database; a
  database failure moves the files back. If the target entry already has the same content (identical sha256) the
  item is skipped and the message says so
- “Distributed” is a read-only aggregate: three thousand-plus media items can be browsed here without storing a
  second copy
- Beyond one page, “distributed” shows a “load more” button rather than infinite scroll — the position stays
  predictable and going back does not jump around
- **Library overview**: a row of cards under the title, one per library — the big number is “how many” (people /
  characters / novels / works / packs), the line below is media count and disk usage, and a share bar sits at the
  bottom; clicking a card switches to that library. The summary sits to the right of the title:
  `7 libraries · 1,530 entries · 3,807 media · 4.7 GB`
- **Context menus**: on media it is “open / distribute to… / rename / edit tags / open local folder / delete”; on
  empty space it is “select media / select all / collect media / refresh”. The inbox has no packs, so “set as pack
  cover / move to another pack” do not appear, and since the media is already in the inbox, “eject” does not either
- **The entry list in the distribute dialog is searchable**: no scrolling through a thousand entries, just type a
  name in the “entry” box (it only filters options, the value is still picked); at most 60 items are rendered and
  the rest shows “keep typing to narrow down”
- **Distribute by tag**: tag media first (context menu → edit tags); if a tag name happens to be an entry name, the
  dialog shows a “matched by tag” row at the top — one click fills in the library and entry, then confirm the pack
- **The last library is remembered**: after distributing to “characters”, the next one defaults to characters
  again (the entry still defaults to the first, so nothing is accidentally sent to the previous character).
  Reloading the page returns to the default first library
- **Multi-select**: “select” in the top right, or `Ctrl + click` / `Shift + click` on one item to enter selection
  mode; inside it `Ctrl+A` selects all, `Delete` deletes, `Esc` exits (`Ctrl+A` also works without being in
  selection mode). The bottom bar is “select all / distribute to… / delete / done”
- **Right-clicking one of the selected items** swaps the menu for batch actions (distribute the N selected /
  delete the N selected), so “50 selected, one deleted” cannot happen
- **Eject (the reverse)**: media in any entry / pack — via the context menu, the detail page's “eject” button, or
  multi-select in “all media” — goes back to `inbox → undistributed` with the files. If the inbox already holds the
  same content (identical sha256) nothing is duplicated: the row is merged and a message says so

> This is the entry point for “each character's gallery stays independent and images cannot be moved across
> libraries”: collect first, distribute in one go, instead of switching libraries and going through “add from all
> media” for a single image.

### Filtering “all media”

After switching to “all media”, an extra row of filters appears in the middle of the toolbar:

| Control | Effect |
|---|---|
| All / images / videos | By type |
| Tag dropdown | Tags aggregated from the current entry's media, ordered by frequency (with counts) |
| Pack dropdown | Any pack, or “unassigned” |
| Sub-library dropdown | Characters only (official / cosplay / fanart) |
| Top-bar search | Matches filename or tag; in the “packs” view it filters packs instead (title / sub-library / tags) |
| Sort | Newest / oldest / by name / largest / smallest |

Filtering and sorting happen in the frontend, so changing them never refetches.

The emoji library's “uncategorized” and “all media” use the same controls with **animated / static** instead of
images / videos:

| Control | Effect |
|---|---|
| All / animated / static | Animated = gif (or video), everything else counts as a static reaction image |
| Tag dropdown | Candidates follow the current scope; pack tags cascade to every image inside |
| Pack dropdown | Only in “all media”; includes “uncategorized (not in a pack)” |
| Search / sort | Same as above |

> **Animated means it really has multiple frames** (`media.anim`, decided by sharp's `pages`), not a `.gif`
> extension — a large share of the `.gif` files exported by WeChat / QQ have a single frame and count as static.

**Hover playback**: hovering an animated tile for 420 ms swaps in the original playing and enlarged; moving away
restores immediately, and only one plays at a time. **Video tiles do not take part**: previously their `anim` flag
was also true and the same path stuffed the whole mp4 into an `<img>` to decode — it could not play and burned IO,
so videos now only get a small triangle badge in the corner.

### Media detail page

Clicking any image or video in the masonry opens `/i/:id`:

- The left side is the large image (a player for videos) with an “entry · pack” capsule on top; click ✕ or press
  `Esc` to go back
- The right side is the info panel: resolution (plus duration for videos), tags, description, related entries,
  storage location (`library / entry / pack`), file size, storage time
- **The description** turns into an input on click and saves on blur; when empty it reads “Images related to
  ‘xxx’.”
- **Tags**: the dark ones belong to this image, click to remove; the light ones are inherited from the entry
  (entry name, people / characters) and clicking only tells you to change them on the entry, so nothing is
  deleted by accident
- `←` `→` page within the same pack; clicking the image opens a fullscreen lightbox (while it is open the keyboard
  belongs to it)
- **Videos autoplay muted and looped** (browsers block anything else); use the volume button on the player for sound
- **Video cover**: the “set as video cover” button below the player stores **the current frame** as the cover
  (pause first or click while playing — whatever is on screen at that moment). Afterwards a “restore default
  cover” appears, which falls back to the automatic first frame (10 % into the video). The cover only affects this
  media's thumbnail, so list tiles, pack covers and entry covers all change together
- Thumbnail URLs always carry `?v=<THUMB_REV>` (`web/js/api.js`, currently 2): once an `immutable` response is
  cached, a new response at the same URL is never fetched (not even on F5), so the URL itself must change. Bump it
  when the thumbnail pipeline changes
- The bottom also offers rename, reveal in Explorer and delete
- “Reveal in folder”: images / videos are **selected** in Explorer, while a pack opens the **pack root directory**
  (the folder holding “images” and “videos”)

### Tags

Entries can carry tags; click **+ Tag** at the right of the tag row to open the dialog: an input on top, the list of
existing tags below (click to select / deselect), confirm at the bottom.

- **Filter while typing**: the “existing tags” list narrows to those containing what you typed and the counter
  becomes `(7 / 184)`; already selected tags always stay visible
- **Duplicates**: typing an existing tag selects it and says “xxx already exists” instead of adding a second one
- **Similarity check**: when a new tag is very close to an existing one (containment, or bigram similarity ≥ 0.5)
  it blocks first and asks “very similar to xxx, avoid a duplicate?” — “add anyway” still works
- Tags are shared across the whole library, reusable across libraries and entries

**Clicking a tag opens the matching library, it does not delete** — a tag with a same-name resource (say “Genshin”)
goes straight to the resource detail, one without prints a message; **deleting a tag moved to the context menu**
(right-click the tag → delete). An entry's own name tag has no “delete” item and updates on rename.

**Every entry carries its own name tag** (entry “Foo” → tag “Foo”), synchronised on create and rename; the one on
the entry cannot be deleted. It also shows up on every image / video in that entry.

**Media only inherit two things**:

```
tags of an image = the image's own tags + the entry name itself + the library tag (people / characters)
```

Generic tags typed onto the entry (“Genshin”, “miHoYo”) **do not** cascade to all of its images — a person usually
has one or two packs connected to a work, and cascading everything would dye a thousand images. To tag a batch:
tag the **pack** (the resource page uses this to filter packs by tag), or tag individual images.

For example one image under an entry carries `cosplay / photo / entry name`. It is visible in the top-right of the
lightbox.

### Context menus

Almost everything in the UI has a context menu:

| Where | What it offers |
|---|---|
| Home · entry card | Open / edit name / add media / open local folder / delete |
| Home · empty area | New entry / new library / refresh |
| Entry page · pack card | Open / edit name / edit tags / **add media** (4 sources) / open local folder / **dissolve** / **delete** |
| Entry page · empty area | Upload media / new pack / edit info |
| Entry page · platform (source) card | Edit / copy / delete |
| Entry page · tag | Open the matching resource / delete tag |
| Image or video tile | Open / rename / edit tags / **set as pack cover** / **set as entry cover** / open local folder / move to another pack / delete |
| Pack page · empty area | Upload media (into this pack) / edit pack / edit tags / open local folder |
| Emoji · pack card | Open / edit name / edit tags / add media (4 sources) / open local folder / dissolve / delete |
| Emoji · empty area | Upload media / open the upload queue / new pack / edit library |
| Resource library · resource card | Open / edit resource / edit tags / **copy name** / delete |
| Resource library · empty area | New resource / **view one category** (submenu) / edit library / refresh |
| Resource detail · related card | Open entry / **show only packs of “X”** / open local folder / copy entry name |
| Resource detail · empty area | Edit resource / edit tags / copy resource name / delete resource |

Pack cards have no buttons of their own — everything goes through the context menu (the video count is in the
card's footer text).

### Setting a cover

The image context menu has two **independent** cover actions:

| Item | When it appears | What it does |
|---|---|---|
| Set as pack cover | When the image **currently belongs to a pack**; hidden when it does not (a greyed-out item would just be a permanent dead end) | Writes `packs.cover_media_id`; the pack card / the first cell of the emoji mosaic changes immediately |
| Set as entry / resource cover | When the image's entry is not a container (hidden in the emoji library); the label follows the library type | Writes `characters.cover_media_id`; the entry cover and the home card refresh immediately |

On success it reports `set as the cover of “XXX”`; on failure `failed to set the cover`. A manually chosen cover
**stays** — later uploads never replace it (it only falls back when that image leaves the pack).

### Keyboard

| Key | Effect |
|---|---|
| `Esc` | Closes **only the top layer**: dropdown → dialog → context menu → lightbox, one at a time; with no layer open it exits selection mode / cancels intro editing (restoring the original) / closes the delete confirmation; on the media detail page it leaves the detail |
| `←` `→` | Page within the same pack on the media detail page; page inside the lightbox |
| `Enter` | Submits a dialog (text areas keep newlines; with focus on cancel, it cancels); **in selection mode, opens the item when exactly one is selected** |
| `⌘/Ctrl + Enter` | Forces submit in a dialog; adds directly in the media picker |
| `Delete` / `Backspace` | Deletes selected media / packs in selection mode (confirmation dialog, then `Enter`) |
| `Shift + click` | Selects **a range** from the last clicked item to this one |
| `Ctrl / ⌘ + click` | Adds or removes this item; combines with Shift (`Ctrl+Shift+click` extends the existing selection) |
| `Ctrl / ⌘ + A` | Selects everything on the current screen: entry page (packs or all media), pack page, emoji / loose library, inbox. **Works without entering selection mode** — it enters and fills in one press, and pressing again does not clear. With focus inside an input it stays the native select-all-text |

### Batch selection

Both the entry page and the pack page have **select** in the toolbar; inside it, clicking a card / tile selects it
(instead of navigating) and a bar floats at the bottom:

| Where | What it offers |
|---|---|
| Entry page · pack view | Select all · **dissolve** · **delete** · done |
| Entry page · all media | Select all · **move to pack** · **delete** · done |
| Pack page | Select all · **move to another pack** · **delete** · done |

The check circle sits in the top-left corner and the selection gets a black outline; “done” or switching views
exits. Moving only changes the owning pack (files are untouched), and **only within the same entry** — moving
across entries means moving files, which is what “add media” is for. The first item in the target dropdown is
**＋ New pack…**, so a new pack can be created on the spot.

Masonry tiles are a **fixed 120 px wide** with heights following each image's own aspect ratio (the pack page and
“all media” behave the same).

**Dissolve vs delete** (packs):

- **Dissolve**: removes only the pack shell; its media become “unassigned” and no file is touched
- **Delete**: removes the pack, its media and the files on disk, unrecoverably (double confirmation)

**Renaming an image** only changes the display name in the database; the filename on disk stays — its prefix is the
content sha256 and deduplication relies on it.

### Aliases column

In the hero area of the detail page, between the source column and the intro: **short name, original name, Japanese
name, English name**.

- The whole column is clickable (title, ＋, any tag, even empty space) → one alias per line in the dialog, or
  separate with commas
- Up to 20 entries, 60 characters each; overflow is ellipsised and the full name shows on hover
- The same for people, characters, resources (game / anime / film / series) and novels; stored as a JSON array in
  `characters.aliases`
- **Search matches aliases and tags too**: `GET /api/shelves/:id/characters?q=` LIKEs `aliases` as well as the
  entry's tags
- The “edit info / edit resource” dialog has the same field (separated by enumeration commas) and shares the same
  cleaning rules

### Platform accounts (people) / source (characters)

The middle column of the hero area; its content follows the library type:

| | People (real) | Characters (fictional) |
|---|---|---|
| Column title | Platform | Source |
| Top row | Platform (dropdown, free text allowed) + ID | Source type + work title |
| Bottom row | Profile URL (optional) | Work link (optional) |
| Clicking a card | Opens the URL, otherwise copies the ID | Opens the link, otherwise copies the work title |

Shared behaviour:

- **＋** adds; hovering a card reveals ✎ edit / ✕ delete
- **Beyond 4 rows the column stops growing**: it scrolls without a visible scrollbar and a fade at the bottom hints
  there is more; the fade disappears when you reach the end
- The first column is fixed at 50 px, **the second column's left edge stays exactly aligned**, long values are
  ellipsised with the full name on hover

Links only accept http/https; typing `x.com/xxx` is completed to `https://x.com/xxx` (once on the frontend, once on
the server).

## The three folders

**By default the program lives on drive D: and the media on drive E:** — the program and its thumbnail cache travel with the repository, the original media and the index sit on E:, and the backup sits next to the data. Keep the three **apart**, never stuff them into one folder:

| Location | Default | What it is | If you delete it |
|---|---|---|---|
| Program | `D:\character-library` (the repository folder — any drive works) | code, `web/`, `server/`, `资料库.exe`, `.cache` (thumbnail cache, rebuildable at any time) | Pull the code from GitHub again |
| Data | `E:\CharacterLibrary` (change with `CL_DATA_DIR`) | original media + index `.catalog\library.db` | Media gone, only a backup can restore it |
| Backup | `E:\CharacterLibrary-Backup` (change with `CL_BACKUP_DIR`) | `backup.bat` creates a `<timestamp>\` subfolder per run, keeps the last 5 | Old ones can go, at least one must stay |

> The backup defaults to the same disk as the data, so **one disk failure takes both**. For a second layer, point
> the backup at another physical disk: `set CL_BACKUP_DIR=G:\CharacterLibrary-Backup` and run `backup.bat`.

Disk advice: **data on a spinning disk** (large, sequential reads), **cache on an SSD** (thumbnails are random reads).

## Storage layout

**Data goes to `CL_DATA_DIR` (default `E:\CharacterLibrary`), the cache to `.cache` inside the project**
(rebuildable at any time, never backed up).

```
E:\CharacterLibrary\                  ← data directory (originals + index, ~5 GB)
  .catalog\
    library.db                        index database; lives with the media and is backed up together
    pending-moves\                    intent records for cross-entry moves (used to finish after a kill)
    recovery.log                      JSONL appended when a move cannot be undone / a directory will not delete
  .covers\                            ← custom video covers (the frame the user picked; on the data disk so
    123\2683.webp                       clearing the cache does not drop them)
  Characters\                         ← ① library (shelves, there can be many)
    some-coser\                       ← ② entry (person)
      2026-05\                        ← ③ pack
        images\                       ← ④ images
          55719ba5c9_original-name-20260507-205239.jpg
        videos\                       ← ④ videos
          6678e99dce_original-name-20260501-205021.mp4
      2024-11\
    another-coser\
      2024-11\
    a-third\

D:\character-library\
  start.bat
  test.bat
  .cache\                             ← cache disk (SSD, travels with the project)
    thumbs\                           420 px WebP for the masonry
    preview\                          1400 px WebP for the lightbox
    inbox\                            upload staging, deleted after a successful ingest
  server\src\
    config.js      the two roots are defined here (DATA_DIR / CACHE_DIR)
    store.js       write / hash / dedupe / cross-drive move
    importer.js    external folder import + month parsing + five-level directory building
    thumbs.js      thumbnail pipeline (concurrency pool + 2 libvips threads)
    routes.js      API
  web\             frontend (zero-build native ESM)
```

The folders on disk and the levels in the UI are **one-to-one** — what you see in Explorer is what you see in the
browser. (Real folder names come from your library / entry / pack names; the tree above uses English examples.)

### Sync folders and the operation log (v3.46)

Every folder / file change writes a row into `fs_ops` (same SQLite file, **same transaction** as the data change) and
is kept forever. The “sync folders” badge in a library's top bar = pending + failed operations; clicking it processes
only those and **no longer scans the whole library**.

**What still lands on disk immediately (unchanged behaviour)**

| Operation | Disk |
|---|---|
| Upload / extract / path import | Files written immediately |
| Rename pack | Directory renamed immediately (refused when the directory still holds another pack's files — left to sync) |
| Delete pack / delete media | Files deleted immediately, empty directories reclaimed |
| Cross-entry move / distribute / eject | Files moved immediately |
| Rename entry / delete entry | Directory renamed / removed recursively immediately |

**What only touches the database and waits for sync**

| Operation | On sync |
|---|---|
| Create pack | Creates the empty directory |
| Move to another pack inside the same entry | Moves files into the new pack directory |
| Dissolve pack | Media go to `<entry>/uncategorized/images\|videos`, then empty directories are reclaimed |

Sync order: apply pending (create directories / move files / retry deletes / reclaim empty directories) → verify the
operations that happened **after the previous sync and have not been verified yet** (checking the **current state**,
not the historical target, so a later rename is not reverted) → repair the affected packs once more when verification
fails → write `fs_sync_runs`. Nothing without a record is ever deleted, name clashes get `-1` / `-2`, and the only
files actually deleted are the media / packs you deleted in the UI.

- **Operation log page `/ops`**: right-click empty space on a library page → “operation log”. Actions listed newest
  first with result and failure reason; searchable, filterable by status, and finished records older than a year can
  be archived
- **Full verification**: top right of the same page. Only needed when you moved files by hand in Explorer

Implementation: `server/src/ops-log.js` (tables and writes), `server/src/ops-apply.js` (incremental apply and
verification), `server/src/pack-sync.js` (single-pack recompute engine; the `scope` argument limits it to the packs
involved).

Hard rules:

- A whole-directory rename is only used on an **exclusive directory** (file names are cross-checked so no other
  pack's files are inside) — a monthly directory often holds files from several packs, and a blind rename would take
  the others along
- A real run writes `.catalog/sync-journal/<time>.jsonl` (one line per move), keeping the last 5 so an incident can be
  rolled back
- When the file a record points at is missing, it looks **once by filename inside the entry directory**: a single
  match is claimed, several are never guessed
- Empty packs get no directory (newly created ones are filled in on sync)

## Backup

The whole library is one directory, so **backup = copying `E:\CharacterLibrary`**. `.cache` needs no backup — it
rebuilds itself.

One-click backup (double-click `backup.bat`, or `npm run backup`):

```bat
backup.bat                   :: backs up to E:\CharacterLibrary-Backup\<timestamp>\, keeps the last 5
npm run backup -- --keep 10  :: keep 10
npm run backup -- --sample 30 :: how many files to hash-compare (default 12, 0 = none)
```

### What it actually does

1. **Snapshots the index first** (`VACUUM INTO`, safe while the server runs, includes committed WAL changes), then
   opens **the snapshot itself** and runs `integrity_check` plus a row count — it verifies the copy, not the source
2. Copies **every top-level directory and loose file** of the data disk into a staging area
   `<backup root>\.staging\<timestamp>\` (`.catalog` is handled separately and only `library.db` is carried;
   `.covers` video posters count as media and are copied as usual)
3. **Verifies row by row against the `media` table in the snapshot**: every `rel_path` must exist and its byte size
   must equal `bytes`; rows with a custom video cover also check `poster_rel`
4. Then hashes `--sample` files and compares **sha256** (catching silent corruption where the size matches but the
   content differs)
5. Only when everything passes is the staging directory renamed to the real `20261027-123302\`, with `MANIFEST.txt`
   and `RESTORE.md` written
6. Old backups are pruned last, and **only directories whose name matches, that contain a MANIFEST and no
   FAILURE.txt**

Why not verify with “file count + total bytes”: that proves neither content equality nor “files ingested after the
snapshot are missing from the backup” — restoring such a backup leaves broken entries. Now a single record without a
matching file makes the backup fail.

### When it fails

The failed copy is renamed to `<timestamp>.failed\` with a `FAILURE.txt` inside (reason + time). It is **not** treated
as a usable backup and **does not** trigger pruning. The directory listing tells you which run failed:

```
E:\CharacterLibrary-Backup\
  20261026-133946\          a real backup
    MANIFEST.txt            time / source / file count / bytes / sampled hashes / integrity
    RESTORE.md              step-by-step restore instructions
    .catalog\library.db     index snapshot
    .covers\                custom video covers
    Characters\ People\ …   original media
  20261027-123302-3.failed\ a failed run (has FAILURE.txt, cannot be used to restore)
```

### Restoring

See `RESTORE.md` inside each backup. The essentials:

1. **Stop the service** (confirm nothing listens on port 7788)
2. **Rename the current directory aside first**, never overwrite it directly
3. If the target directory still contains `library.db-wal` / `library.db-shm`, **delete them first** — an old WAL is
   replayed as the log of the new database and can corrupt what you just restored
4. Copy everything from the backup back (including `.catalog\library.db` and `.covers`)
5. Start up, check the entry count on the home page, open a few images and videos to confirm they load
6. Delete the aside copy from step 2 only after confirming

Index paths are relative to `DATA_DIR`, so changing drive letter or directory only means one line in `config.js` (or
an environment variable) — the database needs no change:

```bat
set CL_DATA_DIR=E:\CharacterLibrary
set CL_CACHE_DIR=D:\my-cache
start.bat
```

If the data disk is not plugged in, startup fails loudly instead of silently creating an empty library on C:.

The filename prefix is the first 10 characters of the content sha256: **uploading the same file again is skipped
automatically**, so it never takes two copies.

## What happens when a file operation fails

Manual tidying inevitably hits “file in use / read-only / permission denied”; these are **no longer reported as
success**:

- **Delete**: the disk file is removed first; if that fails the API returns 409 and **keeps the row** (you still see
  it and can try again), with the real cause (`EBUSY` / `EPERM`) in the error. Batch delete returns
  `{ done, failed:[{id, reason}] }` and the UI says “deleted 2 media, 1 failed: …”. A read-only attribute is cleared
  and retried automatically, which does not count as a failure.
- **Cross-entry move**: files move first, then the database is written; a database failure **moves the files back**
  and says so in the response. Before moving, an intent file is written to `<data dir>\.catalog\pending-moves\*.json`,
  so if the process is killed the next start finishes the job (row already points at the new location → drop the
  record; not yet → move the file back). Moves that cannot be undone are appended to `.catalog\recovery.log` for
  manual handling.
- **Target already has a file with that name**: the **full sha256** is compared. Identical → the source is deleted
  and deduplicated; different → it is stored as `name-1.ext` and both are kept (previously only the 10-character sha
  prefix in the filename was compared, which could theoretically delete the wrong source).
- **Deleting an entry / pack**: a directory that does not delete cleanly is recorded in `recovery.log` and the message
  says how many files are left; it will **never** go and delete directories that “look like leftovers”.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/overview` | Library + shelf list + totals |
| POST | `/api/shelves` | Create a library |
| GET | `/api/shelves/:id/characters` | Entry list (`q` / `sort`, containers excluded) |
| GET | `/api/shelves/:id/novel` | Novel library: category counts + genre/source groups + book list (`view` / `group` / `q` / `sort`) |
| GET | `/api/shelves/:id/emoji` | Emoji library: packs + first 9 thumbnails + stats |
| GET | `/api/shelves/:id/resources` | Resource library: cards + category counts |
| GET | `/api/tags` | Tag pool: name + usage count (entries / packs / images aggregated) |
| GET | `/api/tags/:name` | Tag page: entries / packs / latest 200 media + the three totals |
| GET | `/api/shelves/:id/novelbags` | Novel bags (`bookCount` / cover taken from the first book) |
| POST | `/api/shelves/:id/novelbags` | Create a bag |
| GET | `/api/characters/:id/texts` | Body files of a novel (`kind='file'`) |
| GET | `/api/media/:id/raw` | Serves a body file / attachment as-is (`?download=1` forces download, supports Range) |
| POST | `/api/packs/:id/convert` | Pack ⇄ comic (`{"to":"comic"}` / `{"to":"pack"}`; returns 409 first when videos exist, `onlyImages` converts images only) |
| GET | `/api/resources/:id` | Resource detail + related characters / people |
| GET | `/api/resources/index` | Resource name → id (used by source / tag jumps) |
| POST | `/api/resources/ensure` | Creates a resource card when a new work title is typed as a source (`{ name, category }`) |
| POST | `/api/characters` | Create an entry |
| GET / PATCH / DELETE | `/api/characters/:id` | Detail / update / delete |
| GET / POST | `/api/characters/:id/packs` | Pack list / create |
| POST | `/api/characters/:id/media` | Upload (multipart `files`, optional `packId`) |
| POST | `/api/characters/:id/archive` | Upload an archive (multipart `archive`, optional `packId` / `category`): only images / videos are ingested; without `packId` a pack named after the archive is created (reused if it exists) |
| GET | `/api/characters/:id/media` | Every media item of an entry |
| GET / PATCH / DELETE | `/api/packs/:id` | Pack detail / rename + cover / delete |
| GET | `/api/packs/:id/media` | Media inside a pack |
| POST | `/api/packs/:id/media` | Add existing media to a pack (`{ ids:[...] }`, cross-entry moves files) |
| POST | `/api/packs/bulk` | Batch dissolve / delete packs (`{ ids, action: dissolve\|delete }`) |
| POST | `/api/media/bulk` | Batch delete / move media (`{ ids, action: delete\|move, packId }`) |
| GET | `/api/media/pick` | Media picker (`scope=all\|character\|loose\|filed`, `q` / `kind` / paging) |
| GET | `/api/media/:id` | Single media detail (entry / pack / library / full tag list / description) |
| PATCH / DELETE | `/api/media/:id` | Move pack / rename / tags / description / delete |
| POST | `/api/media/:id/poster` | Video cover: grab the frame at second `at` (`{ at: 12.5 }`) |
| DELETE | `/api/media/:id/poster` | Restore the default cover (falls back to the automatic first frame) |
| GET | `/t/:id` `/pv/:id` `/m/:id` | Thumbnail / preview / original file (Range) |

> Media endpoints use `/t` `/pv` `/m`; page routes use `/` `/s/:id` `/c/:id` `/p/:id` `/i/:id` `/e/:id` `/rs/:id`
> `/r/:id` `/n/:id` `/uploads`. The two prefixes must never collide.
>
> `/s/:id` is the **single main entry**: whichever library you switch to, the URL stays on it. `/e` `/rs` `/n` `/x`
> still exist but only as direct links that open one library (independent views with `embedded=false`, their own top
> bar and a back button).

## Bulk import from an external folder

### Emoji library: one pack per subdirectory

```bash
cd server
node src/import-emoji.mjs 3 "%USERPROFILE%\Pictures\emoji"
```

Each subdirectory becomes a pack (`emoji-related` → curated emoji, `marketface` → store emoji, `personal` → personal
emoji); duplicates are checked by sha256 and skipped, and thumbnails are generated on the way out.

### People / characters: one directory per entry

```bash
cd server
node src/import-cli.js "D:\inbox\<character folder>" --name "Display name"
```

It hashes files, creates packs by month, and can be re-run safely (identical sha256 is skipped).

**`--move` moves instead of copying**: `node src/import-cli.js "<source>" --name "Display name" --move`.
Each source file is deleted **only after confirming a complete copy exists in the library** (present and the same byte
size); copy failures, size mismatches and duplicates without a physical file are all kept and listed at the end.
Afterwards empty subdirectories in the source are removed, **the root directory stays**. Without `--move` not a single
source file is touched.

## Performance (measured on an ordinary desktop)

| Item | Number |
|---|---|
| Importing 538 media items (512 MB) | 12 s |
| Importing 789 media items (252 MB) | 6 s |
| Bulk thumbnail generation | **45.8 per second** (997 in 21.8 s) |
| Thumbnail cache hit | **14 ms** |
| Queue concurrency | 8 by default, tune with `THUMB_CONCURRENCY` |
| libvips internal threads | 2 |

Why those numbers (sample of 24 real images):

| Configuration | Throughput |
|---|---|
| Serial | 19.4 per second |
| Concurrency 8 + libvips 16 threads | 59.3 per second |
| **Concurrency 8 + libvips 2 threads** | **66.3 per second** |

Giving libvips more internal threads makes it fight the outer concurrency; 2 is the sweet spot.

**Thumbnails are generated at ingest time**: uploads and imports create them on the way, so new content never waits.
Existing data can be backfilled with `POST /api/warm`. The current library is 1334/1334 = 100 % ready, so opening any
pack is a cache hit.

**Lists and detail pages (v3.30)**

| Item | Approach |
|---|---|
| Opening a detail page | Only `api.media(id)` is awaited before the image shows; the pack's media list arrives in the background and only updates “x / y” and the arrows |
| Paging | Reuses the in-memory list and requests only the current item; neighbours are prefetched (`new Image()`) |
| Large lists | Masonry inserts at most 80 tiles per frame, so 3000 items never block the main thread |
| Load more | Appends only the tiles after item N; already painted nodes stay put (120 → 240, the first card is still the same DOM node) |
| Upload | Only the covers of the packs written to are refreshed; entry counters merge leading + trailing |
| Overview | 1.5 s TTL cache invalidated by writes; embedded views reuse the parent's data, so switching libraries fires one request |

## Testing

### One command for the automated suite

```bash
cd server
npm run e2e
```

It launches headless Chrome, really clicks buttons, really opens context menus, really uploads files and really deletes
data, then prints `140/140 passed`. It runs sequentially and cleans up its own test data afterwards (test names carry a
timestamp suffix, so it can be re-run endlessly).

| Scenario | Assertions |
|---|---|
| Home | Five library tabs, card rendering, stylesheet applied |
| People / character pages | Navigating to `/c/:id`, monthly pack rendering, platform column overflow and copy, intro editing and Esc restore |
| Pack / all media | Masonry tile count, thumbnails actually decoding pixels, filter bar (type / tag / pack / sort), sorting does not freeze |
| Wide tiles | Oversized media spans two columns (248 px), columns align, no overlap, container height matches content |
| Lightbox / detail page | Click opens, large image loads, Esc closes; vertical constraints, paging does not stack history |
| Batch and shortcuts | Shift range, Ctrl toggle, Delete, Enter to open, Ctrl+A select all |
| Upload | PNG generated in memory (filename carries a date) → monthly pack created → counters refresh |
| Tags | Duplicate and similarity blocking, pack tags cascading to every image, no residue after undo |
| Context menus | Tile / pack / platform / empty area / resource card each show their own items |
| Emoji library | Section switching, animated vs static filtering, 3×3 cover, GIF detail |
| Resource library | Category grouping, official pack, related cards, comma batch create |
| Novel library | Category views, grouping folders, title placeholder, three disk levels, genre rename moving the directory, duplicate title 409, automatic fanfic tag |
| Video cover | Button only on videos, message text, thumbnail bytes really change, `no-cache`, restore falls back to the first frame |
| Delete | API delete → 404 on re-query → the disk directory disappears too |

Uploads use `DataTransfer` + in-memory `File`, so they depend on no local media; test videos are generated on the spot
with ffmpeg `lavfi testsrc`. The assertion count grows with each version — see the end of [Version history](#version-history).

### Isolated tests for file operations / backup

```bash
node tools/fs-safety-test.mjs        # runs entirely in a temp directory, never touches the real library
```

It only uses `%TEMP%\cl-fs-test-<ts>\{data,cache,backup}` and points the service and the backup at them via
`CL_DATA_DIR` / `CL_CACHE_DIR` / `CL_BACKUP_DIR`; everything is deleted at the end (`CL_FS_TEST_KEEP=1` keeps the
scene). Coverage: filename cleaning, cross-entry moves (normal / same name different content / database failure
rollback), delete failing while a file is in use (simulated with an exclusive handle, equivalent to a player playing
it), partially successful batches, a successful backup plus a restore drill, files disappearing during a backup, loose
files at the root, and failures not pruning old backups.

### Just look at the UI

```bash
cd server
npm run shot -- "http://127.0.0.1:7788/c/1" "../shots/char.png" 1440 1100 4000
```

Arguments: `<url> <output path> [width] [height] [wait ms]`. Give it enough wait for images to load, otherwise you get
a wall of grey. The script also prints the page's JS errors — only `console errors: 0` counts as clean.

### Bulk-eject a sub-library back to the inbox

```bash
node tools/eject-official.mjs                       # count only, no file changes
node tools/eject-official.mjs --apply               # eject the whole "official" sub-library to inbox → undistributed
node tools/eject-official.mjs --keep 鸣潮 --apply    # keep one work, e.g. "鸣潮" / Wuthering Waves
node tools/eject-official.mjs --dir /cosplay/ --apply  # use a different directory fragment
```

- The decision is based on the **disk path** (`m.rel_path LIKE %/official/%`), not `packs.category` — the official
  sub-library also contains a batch of “uncategorized” pack media, so filtering by pack would miss them
- It calls `POST /api/media/eject` under the hood (150 per batch), using the same “move + journal + rollback” path
- Content that already exists in the inbox with the same sha256 is merged (source file deleted, row deleted);
  **if that round exhausts the delete quota** (an environment safe-delete guard), those stay in the library marked
  `ERR` and re-running normally fails again — they need a later round or manual handling

### Manual checklist (run through it after touching the frontend)

1. **Frontend changes not showing** → `Ctrl + Shift + R`. The backend already sends `no-cache`, so a normal reload is
   enough, but a hard reload rules out every cache layer.
2. **Home**: character cards have covers and the count badges match.
3. **Character page**: clicking the intro turns it into an input and blur saves; clicking a tag deletes it; “＋ Upload”
   with a few images raises the pack count after the progress bar finishes.
4. **Pack page**: masonry keeps aspect ratios; videos carry a play badge; playback and seeking work; switching sort to
   “type ↓” puts videos first.
5. **Deleting a pack**: media become unassigned rather than disappearing (they are still in the character page's “all
   media”).
6. **Deleting a character**: `library/<character>/` is removed with it — **this cannot be undone**.

## Known limitations

- 4 GB per file, 400 files per upload (archives included)
- rar / 7z extraction needs 7-Zip or WinRAR installed (Windows' bundled `tar.exe` also works); zip needs nothing
- `mkv` / `avi` may not play in the browser
- Moving media between packs inside a library only updates the database, files are not moved (intentional, so
  re-categorising is always cheap)
- Rubber-band (marquee) batch selection is not implemented yet (the API already has `PATCH /api/media/:id`)

## Version control

Repository: `https://github.com/zhexianqaq/character-library` (public, default branch `main`).
**Only code is committed**: original media, `.catalog/library.db`, `.cache/`, `shots/` and `node_modules/` are all in
`.gitignore`.

### Conventions

- **One change = one commit + one annotated tag**, the tag name is the version number
- Documentation-only changes (README / CHANGELOG) are committed separately and **not tagged** — tags mark features and
  fixes
- The first line of a commit message is `vX.Y: subject`; the body explains *why* and *what trap was hit* (that is what
  future debugging relies on)
- Version numbers: features / structural changes use two digits (`v3.25`), bug fixes use three (`v3.24.1`)
- **e2e must be green before tagging** (currently 140 cases), plus at least one screenshot of the changed page
  confirming `console errors: 0`
- Release: `git push origin main --follow-tags` (tags go with the commits)
- Changes that touch the database schema are followed by `npm run backup` for a fresh snapshot

### Useful commands

```bash
git tag -l --sort=creatordate                 # every version, by time
git tag -n9 v3.24                             # the message of one version
git log --oneline v3.24..v3.25                # what changed between two versions
git show v3.25 --stat                         # which files a version touched
git log -S "novel_group" --oneline            # which commit introduced a field / string
git tag --contains <commit>                   # which version first contains this commit
```

> For an annotated tag, `git rev-parse v3.25` returns the **tag object** SHA; the commit needs `v3.25^{commit}`.

### Rolling back

```bash
git checkout v3.24          # just look at an old version (detached HEAD; checkout main to come back)
git revert <commit>         # undo one version, history preserved (recommended)
git reset --hard v3.24      # hard local reset, requires a force push afterwards; only when the later commits are
                            # definitely unwanted
```

The database only adds columns, never drops them (`migrate()` is `ADD COLUMN` only), so **rolling back the code cannot
corrupt the library**; going “new version first, old version later” is safe too — old code simply ignores the new
columns.

### Release checklist

1. `cd server && npm run e2e` — all green (currently 140/140)
2. Run `node tools/shot.mjs <url> <out.png>` on the changed page and confirm `console errors: 0`
3. Update `CHANGELOG.md` (newest version at the top) and the feature / version tables in this file
4. `git add -A` → `git commit` → `git tag -a vX.Y -m "..."` → `git push origin main --follow-tags`
5. `npm run backup` when the schema changed

## Version history

One row per tag since v2.0; the detailed changes (including the traps) live in [CHANGELOG.md](CHANGELOG.md).
v1.0 was an earlier single-library version with no source control record and is not in this repository. All dates below
are in **2026**.

| Version | Date | Content |
|---|---|---|
| v2.0 | 10-26 | **Two-library structure**: people (real) and characters (fictional) coexist, `shelves.kind` distinguishes the semantics; backup script |
| v3.0 | 10-26 | **Sub-libraries for characters**: official / cosplay / fanart, one extra disk level, the same month can have one pack per sub-library |
| v3.1 | 10-26 | **Tag system**: tag dialog, duplicate + similarity checks, automatic media inheritance |
| v3.2 | 10-26 | **Context menus everywhere**: tiles / packs / empty areas |
| v3.3 | 10-26 | Pack add-media entry point, drag & drop upload, upload queue |
| v3.4 | 10-26 | **Media detail page**, 3:4 covers, entries carry their own name tag |
| v3.4.1 | 10-26 | Vertical constraints on the detail page (tall images no longer overflow), videos keep their aspect ratio |
| v3.4.2 | 10-26 | Detail paging no longer stacks history, one `✕` exits |
| v3.5 | 10-26 | Batch selection and actions, video autoplay, reveal in folder |
| v3.6 | 10-26 | Custom dropdowns, the all-media filter bar |
| v3.7 | 10-26 | Unified dropdowns, slimmer pack cards, 120 px tiles |
| v3.8 | 10-26 | **Third library: emoji** (flat, 3×3 covers, animated filter, gif detail) |
| v3.9 | 10-26 | **Fourth library: resources**; animated decided by frame count; hover playback; state preserved on back |
| v3.10 | 10-26 | Resource library context menus |
| v3.11 | 10-26 | Source merged into the source column, batch create, source auto-creates a resource card, tag click opens the library |
| v3.12 | 10-26 | **Layered Esc** (one layer at a time), tighter tag inheritance |
| v3.13 | 10-26 | Set as cover, Shift / Ctrl multi-select, Delete · Enter shortcuts |
| v3.14 | 10-26 | Oversized media spans two columns (absolute positioning + placement algorithm) |
| v3.15 | 10-26 | Pack tags cascade to every image in the pack (library-wide consistency) |
| v3.16 | 10-26 | Creating a person creates the directory immediately + `uncategorized/images`, `uncategorized/videos` |
| v3.17 | 10-26 | Batch create locks the library (switching mid-way cannot leak), top-bar search keeps focus |
| v3.18 | 10-26 | Comma batch create for the resource library |
| v3.19 | 10-26 | The resource library has directories on disk; resource cards create them lazily, no pre-warming |
| v3.20 | 10-26 | Span threshold 2 → 1.7 (16:9 spans too), wide placement scores `2×hi − lo` |
| v3.21 | 10-26 | Every resource gets a pre-made “official” pack; the pack page breadcrumb splits by library type |
| v3.22 | 10-26 | Cards sort by count descending by default + a `count` dropdown on the right |
| v3.23 | 10-26 | Import by game (741 files / 18 packs); fixed two real bugs around deleting sources with long filenames |
| v3.24 | 10-27 | **Fifth library: novels** (original / fanfic, category view × grouping folder orthogonal, rename moves the directory) |
| v3.24.1 | 10-27 | The novel detail page reads `novel_group` for its “source / genre” column; the edit form gained the novel fields |
| v3.25 | 10-27 | **Video covers**: grab the current frame as a thumbnail, restorable; fixed two thumbnail cache issues |
| v3.26 | 10-27 | **Flat libraries open in place** + **inbox** (undistributed / distributed, distribute / eject) + pack sorting + file operation and backup hardening |
| v3.27 | 10-27 | “Aliases” column on the detail page (short / Japanese / English name), shared by all five entry types |
| v3.28 | 10-27 | Library overview bar in the inbox (entry count / media count / usage per library + share bars) |
| v3.28.1 | 10-27 | Context menus in the inbox; `Ctrl+click` / `Shift+click` enters multi-select, `Ctrl+A` / `Delete` / `Esc` |
| v3.28.2 | 10-27 | Distribute dialog: context-menu entry point, searchable entries (`searchable` dropdown), match entries by tag |
| v3.28.3 | 10-27 | Distribute dialog remembers the last library (library only, in memory) |
| v3.29 | 10-27 | **Media sorting inside a pack**: name / time / size / type with ascending / descending, the detail page ← → order follows |
| v3.30 | 10-27 | **Performance**: detail page paints first and fills the sequence later, paging reuses the list and fetches only the current item; chunked masonry + incremental load-more; uploads refresh only the affected packs and merge counter updates; overview 1.5 s cache and a single request |
| v3.30.1 | 10-27 | Novel editor in two columns (intro spans the row); novels lost the aliases field, the hero no longer shows the aliases column |
| v3.30.2 | 10-27 | Fixed two chunked-rendering timing bugs: selecting all mid-render left some unchecked, consecutive “load more” dropped tiles (calibrated the start from `_rendered`) |
| v3.31 | 10-27 | Inbox **auto-loads at the bottom** (button kept for retries); the move dialog's “target pack” **accepts a new name** without another dialog |
| v3.31.1 | 10-27 | Media context menu gained “select this media / exit selection” — no scrolling back to the top to enter multi-select |
| v3.31.2 | 10-27 | Packs automatically carry a tag with their own name (maintained on create / rename), media inherit it |
| v3.32 | 10-27 | **Novel bags**: `packs.kind='novel'`, one bag per genre / source work holding several books; the novel home page became a bag grid |
| v3.33 | 10-27 | All media defaults to “unassigned”; selection keeps the scroll position; dropdowns collapse when nothing matches; **cross-library linked packs** (a tag exactly equal to the entry name attaches the pack, read-only) |
| v3.34 | 10-27 | **Empty bags hidden** (book count from the current view); **novel body files + TXT reader** (GB18030 fallback, chapter splitting, TOC, position memory); **comic packs** interconvertible with normal packs (`page_no` natural order + continuous scroll reader) |
| v3.35 | 10-27 | **Comic reader rewritten**: scroll / single / spread, left→right / right→left, fit-height / fit-width, fullscreen, progress slider; clicking the sides or swiping also turns pages, mode and progress remembered |
| v3.36 | 10-27 | Fullscreen moved to the whole page (scroll restored) + controls moved into the side margins (vertical progress bar) + paging returns to the top; linked packs merged into the cosplay column; pack context menu regained edit; people libraries no longer offer comic conversion; pack multi-select gained “eject” |
| v3.37 | 10-27 | “character-outfit” in pack names splits into two tags (idempotent startup migration for existing packs), pasting the whole string into the tag input also splits; pure dates and names with numeric segments are left alone |
| v3.38 | 10-27 | New **tag pages** `/tag/:name` (entries / packs / media); packs carry the entry-name tag; the tag dialog lists selected tags first; media no longer inherit library identity tags like “people” |
| v3.38.1 | 10-27 | “Move to another pack” in the single-media context menu also accepts a new name (reuse / create / unassign), consistent with batch move |
| v3.38.2 | 10-27 | **Wheel paging** in comic single / spread mode (a pair at a time in spread); in fit-width the current page scrolls to the end first, with a threshold and cooldown for trackpad inertia |
| v3.39 | 10-27 | New **loose library** (`kind=loose`): flat, only packs and all media; uploads are filed by month, no “uncategorized” |
| v3.39.1 | 10-27 | The staged source in `.cache/inbox` is deleted after upload (library originals untouched); `npm run sweep-inbox` added to verify by sha256 and clean historical leftovers |
| v3.40 | 10-27 | Folder import supports `--move`: deletes the source and prunes subdirectories after verifying the library copy; fixed EBUSY caused by `sharp`'s file cache (409 when deleting right after upload) |
| v3.41 | 10-27 | **Archive extraction on drop**: dropping a zip / rar / 7z onto a pack joins that pack, onto an entry page creates a pack named after the archive; zip parsed in-process (GBK names decoded correctly, zip64 supported), rar / 7z handed to 7-Zip / UnRAR / bsdtar |
| v3.42 | 10-27 | **Desktop shell `资料库.exe`** (Rust + WebView2, single 700 KB file): starts the Node service, reuses a running one, stops on close; F5 / Ctrl+R reload; zero page changes |
| v3.43 | 10-27 | **Top-bar search**: people / character lists (name · aliases · tags), entry pages (pack view filters packs, all-media view filters media, novels filter body files too), resource library, resource detail; filtering happens on the page, no extra requests |
| v3.44 | 10-27 | **`Ctrl+A` select all**: entry pages (both views), pack pages, emoji / loose libraries, inbox; works without entering selection mode — one press enters and fills, pressing again does not clear; inside an input it stays the native select-all-text |
| v3.45 | 10-27 | **Disk sync**: a “sync folders” button in the library top bar (preview → confirm → run, no file deleted); renaming a pack renames its directory, deleting a pack reclaims empty directories; `pack-sync.js` renames whole directories (exclusive ones only), merges scattered packs, moves unassigned media home and heals lost paths by filename, writing `.catalog/sync-journal` for rollback |
| v3.46 | 10-27 | **Operation log + incremental sync**: `fs_ops` / `fs_sync_runs` tables, every frontend change written in the same transaction as the data change; a badge in the top bar and a sync that “only processes these”; moving between packs inside an entry / dissolving a pack / creating an empty pack now wait for sync; new `/ops` page and a full-verification entry point |
| v3.47 | 10-27 | **Closing no longer stalls**: the window is hidden before cleanup and polling `try_wait` replaced the fixed `sleep(900)`, measured 257 ms end to end (previously 1.2~2.8 s) |
| v3.48 | 10-27 | **Repository made public**: README rewritten as a project home page (positioning / stack / capability list / quick start / data model), machine-specific paths and real-library statistics stripped from the code and docs, license notice added |
| v3.49 | 10-28 | **Desktop shell: single instance** — a named mutex is acquired first; a second launch restores and focuses the existing window instead of opening another |
| v3.50 | 10-28 | **Window geometry memory** — position / size / maximised state saved on close, validated against the current monitors on start, oversized sizes clamped |
| v3.51 | 10-28 | **Startup skeleton page** — spawning the server and polling health moved to a background thread, so the window shows a loading page instead of a white screen for up to 30 s |
| v3.52 | 10-28 | **Window icon (first pass)** — hand-written ICO parser feeding `tao::Icon`, plus the `ICON_BIG` slot that `with_window_icon` never sets |
| v3.53 | 10-28 | **Log rotation** — `shell.log` renamed to `.1` once it passes 2 MB, one generation kept |
| v3.54 | 10-28 | **Final icon + PE resources** — 16/24/32/48/64/128/256 generated from the design (successive halving, rounded corners cut to transparent), `build.rs` drives `rc.exe` to compile the icon and version info into the exe |
| v3.55 | 10-28 | **Shelf names redone** — all eight shelves renamed to three characters (人物集 / 角色集 / 表情包 / 作品录 / 原创书 / 同人书 / 收件箱 / 散图集); `shelves.name`, `dir_slug`, 5772 `rel_path` rows and the on-disk folders moved together |
| v3.56 | 10-28 | **Folder icons** — `desktop.ini` plus directory attributes make the app and data folders show the project icon in Explorer |
| v3.57 | 10-28 | **Separate icon for the data folder** — the generator takes `<source> <output.ico>` |
| v3.58 | 10-28 | **Inset for the data icon** — content shrunk 5% so the rounded mask stops cutting into the artwork |
| v3.59 | 10-28 | **Second data-icon revision** — the redrawn artwork carries its own margin, back to the default inset |
| v3.60 | 10-28 | **Black border fixed** — the ICO AND mask is now written from alpha (an all-zero mask means "fully opaque" per the spec), transparent pixels whitened |
| v3.61 | 10-28 | **Per-shelf folder icons** — a 2×4 sheet split into eight, PNG-in-ICO keeps them small |
| v3.62 | 10-28 | **Symbolic shelf icons** — folder plus a motif, still readable at 32 px |
| v3.63 | 10-28 | **`.catalog` / `.covers` icons** — the two metadata folders get their own, so the data folder looks complete |
| v3.64 | 10-28 | **Ctrl+F focuses the search box** — the browser find bar is intercepted (it cannot see lazily rendered cards); dialogs keep focus, pages without a search box fall back to the browser |
| v3.65 | 10-28 | **Duplicate names rejected** — the uniqueness check now covers every shelf (not just novels), applies to create and rename, returns `409` with the existing id so the UI jumps there; batch create reports skips separately from failures |
| v3.66 | 10-28 | **Long filenames keep their extension** — truncation during extraction and upload now elides the middle, preserving both the extension and the trailing `_001`; Douyin/Qzone archives are no longer rejected as "no images or videos" |
| v3.67 | 10-28 | **Video detail layout fixed** — the cover button bar and the info panel shared the `.mp-actions` class, so a stray 20px margin pushed portrait videos out of the card; renamed to `.mp-coverbar` and fixed the sizing order |
| v3.68 | 10-28 | **Manage characters from a work card** — multi-select the related characters (search results included), unlink / delete / move them, and add candidates by searching; the new endpoint only touches tags and credits, never media |
| v3.69 | 10-28 | **tar and nested archives** — tar / tar.gz extracted in pure JS (bsdtar mangled UTF-8 names), archives inside archives unpacked automatically, and ZipCrypto-encrypted zips can be opened in-app |
| v3.70 | 10-28 | **Archive uploads leave a trail** — every attempt appends a line to `.cache/archive-log.jsonl` (received / reject / extract / filter / done), including archives mistakenly sent to `/media` |
| v3.71 | 10-28 | **Dragging archives into the desktop shell** — `/api/import/paths` tries the saved passwords, prompts once on failure and retries, and reports the real reason; fixed an undefined `packId` that turned every success into a 500; the source archive is now deleted only when something was actually imported |

**e2e count over time** (recorded since v3.14): 111 → 115 → 116 → 118 → 119 → 120 → 122 → 125 → 133 → 140.
Versions that only add features (like v3.23) keep the previous count.

**Not done / possibly later**: marquee batch selection, a pack merge UI, previewing inside a zip, an mkv/avi playback
fallback, novel body files (already shipped in v3.34), a tag disambiguation UI.

## License

Personal project, **no open-source license declared** (All rights reserved). The code is public so the implementation
can be read and issues can be filed; that does not grant commercial use or redistribution. If you want to reuse a
piece of it, open an issue and say so first.\n| v3.72 | 10-29 | **Listener leak fixed** — the view container was reused, so `root.addEventListener` piled up with every visit; editing a bio wrote to the previously visited entry and the alias dialog opened several times. Each render now gets a fresh scope container |\n| v3.73 | 10-29 | **Hero height pinned** — the three fixed columns now shrink with lower bounds, `.hero-main` matches the cover height (224px), the bio scrolls inside its own box with a bottom fade, and below 900px the hero stacks. Changing the window width no longer changes the hero height |\n| v3.74 | 10-29 | **Aliases added one at a time** — chip list plus a single-line input (Enter appends, clicking a chip removes, uncommitted text is folded in on save); shared by the character page and the works page |
