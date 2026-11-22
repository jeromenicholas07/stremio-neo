# Incognito catalog redesign: plan

Status (2026-11-22): Phases 1–3 are built on branch
`claude/incognito-catalog-redesign-c89f96`.
- P2P playback and the auto-pick retry are tested in the Shell.
- Recommendations are tested against the dev addon.
- Nothing is deployed. The weekly Claude picks task isn't created yet.

## Revised direction (2026-11-22, from your feedback)

> More than clips, you want full HD, full-length videos. The catalog should
> be basically everything, from as many sources as possible, deduplicated,
> with professional videos first and amateur as a bonus. Streams come from
> torrents, plus clearnet where it exists. Use Stremio's own stream list page
> and reuse its components.

### Catalog: ThePornDB is the master index

ThePornDB already aggregates scenes from thousands of studio sites into one
deduplicated record per scene. Probed 2026-11-22:

| Listing | Endpoint | Result |
|---|---|---|
| Newest scenes | `/scenes?sort=date` | Today's studio releases (Brazzers, Bang Bros, Mofos…), full length |
| A performer's filmography | `/performers/{id}/scenes` | Maya Woulfe: 454 scenes |
| A studio's catalogue | `/sites/{id}/scenes` | Blacked: 829 scenes |
| Full movies (DVDs) | `/movies` | 10,000+ |
| Search | `/scenes?q=` | Works |
| By category | `/scenes?tags[]=` | **0 results by name.** Needs tag ids, or falls back to search. |

**Rows:**

- Favorites.
- One row per ★ performer (their filmography, newest first).
- One row per ★ studio (new).
- Newest scenes.
- Full movies.
- "Amateur & clips" at the bottom: the tube sites, kept as a bonus.

Categories become ThePornDB tag rows if tag ids work; otherwise they run as
searches.

**Finding torrents on one record.** The torrent side keeps its current role,
with every release attached to that one ThePornDB record:

- Grouping by `?parse=` matched 80% of real release names.
- A targeted search (studio + performers + date) finds more releases when a
  title opens.

**Playable now.** A ThePornDB-first row can include scenes nobody has
torrented. Rows show a "▲ seeders" badge once a background check finds
releases, so playable scenes stand out without hiding the full catalogue.

### Streams: Stremio-shaped, from the addon

For each scene the addon returns ordinary Stremio stream objects, the same
shape Torrentio returns:

- **`[RD] 1080p · <release>`:** `url` points at an addon endpoint that
  resolves through Real-Debrid on demand and redirects to the file. This is
  the Torrentio pattern, so the existing auto-pick preflight and copyright
  checks work unchanged.
- **`P2P 1080p · <release>`:** `infoHash` (+ `fileIdx`) for the streaming
  server, with seeders and size in the description.
- **`Direct · Eporner 1080p`:** only when a clearnet copy of the scene is
  found. Matched by performer + title words; marked as unverified until a
  match rate is measured.

### Title page: Stremio's details page, reused

- **Layout:** the details page layout (`MetaDetails` styles), with
  `MetaPreview` for the hero (name, date, runtime, description, performers
  as links) and `StreamsList` for streams.
- **What reuse brings:** the source picker, auto-pick panel, preflight,
  "Playing best…" banner and resume behave as they do for films.
- **Input:** `StreamsList` takes stream groups of the form `{ addon, content:
  { type, content: [streams] } }`. The Incognito page builds that from the
  addon's response instead of from stremio-core. The addon is still never
  installed in core, so nothing reaches Library or Continue Watching.
- **Play links:** `#/player/<encoded stream>`, the same as today's Incognito
  play. With no meta or type/id in the link, the Player creates no library
  item.
- **Open questions:**
  - `StreamsList` dispatches `MetaDetails/MarkVideoAsWatched` when an
    external player is set; check this is a no-op without the core model.
  - Its player-failure retry routes back to `#/metadetails/...`. Incognito
    needs its own return route.
  - The custom `IncTitlePage` stream list built in Phase 1 is replaced.

### Revised build: results (2026-11-22)

Built on the same branch and tested against the dev addon (port 7010) and
the dev web server. Not tested in the Shell; not deployed.

**Rows.** Measured cold; ThePornDB listings are cached on disk for 30 min.

| Row | First load | Notes |
|---|---|---|
| New scenes | 4.6 s | Clip stores filtered out, so it fetches two pages' worth |
| Full movies | 7.2 s | 40 per page, mostly 2–3 h |
| ★ performer | 7.7 s | Filmography, with scenes found in a torrent search listed first |
| ★ studio | 4.6 s | Studio catalogue, with torrented scenes first |
| ★ category | 1.7 s | A ThePornDB title search |
| Studio releases with torrents | | Torrent-first; every card has releases |
| Amateur & clips | 1.2 s | Tube sites, kept as the bonus row |

- **Availability:** cards show "▲ seeders · best quality" once releases are
  known for a scene.
- **Duplicates:** ThePornDB sometimes lists one scene twice (once per site);
  same title and date are now merged.

**Title page.** Stremio's own details page: the `MetaDetails` layout and
styles, `MetaPreview`, and `StreamsList`.

- **Left side:** cast, studio and genre links open the matching Incognito
  rows. The library button reads "Add to Favorites".
- **Streams:** found in about 1 s for a scene. Example: a Mom's Tight scene
  listed 1080p and 720p releases, each as `[RD download]` and `P2P`, with
  seeders and sizes.
- **Auto-pick:** Stremio's auto-pick ran on it unchanged ("Playing #1 ·
  1080p · RealDebrid (download)"), and going back didn't replay.
- **Small additions to shared components:**
  - `StreamsList` gets a `privateMode` prop: no StreamClicked analytics, no
    MarkVideoAsWatched, and no "install addons" button.
  - `MetaPreview` can link to Incognito routes and relabel its library
    button.

**Coverage, measured on 30 recent scenes from three performers:**

- 9 had torrents.
- 4 had a clearnet copy.

Recent and VR scenes are usually missing, which is why playable scenes are
listed first.

**Matching releases to scenes.** A studio often releases several scenes on
one day, and the "`<Studio> yy mm dd`" search returns all of them.

- **Rule:** a release now needs the date *plus* a performer or most of the
  title. Undated releases need most of the title, plus a performer when the
  title is short.
- **Checked by eye:** the releases behind 8 Abella Danger scenes (5–12
  each). All named the right scene.

**Real-Debrid:**

- **Token:** the addon keeps a copy. Settings sends it on Save, and the home
  page syncs it once when the addon has none.
- **No token, no RD streams:** without a token they could only fail, and
  auto-pick ranks them first.
- **Signed links:** `/inc/rd/<payload>.<signature>` resolves through RD and
  redirects the Player. The signature uses a per-install secret, so the
  addon spends the RD token only on links it handed out. It answers 503 after
  30 s if RD is still downloading.
- **Uncached torrents stay on your RD account,** like Torrentio's
  `[RD download]` streams, so they're ready next time. Changing that to
  "delete if it didn't play" is a one-line policy switch if you'd rather.
- **Not yet tested with a real token:** the dev addon has none. The
  favorites-after-restart test passes with the new stream code (P2P only,
  for that reason).
- **Multi-file torrents** (split-scene DVDs under Full movies) play the
  largest file. The file picker only exists on the old torrent screen.

**Still open:**

- **Shell test:** RD redirect, P2P via the streaming server, and clearnet
  streams from the new page, all in mpv.
- **Player retry:** when a stream fails, the Player doesn't come back to the
  Incognito page to try the next one (its retry route is MetaDetails-only).
- **Category rows:** title searches, since ThePornDB's tag filter didn't take
  names.
- **Cold performer row:** the first visit to a new performer's row isn't
  sorted until ThePornDB lookups finish (the row refreshes itself).

### P2P first (2026-11-22)

You asked for P2P to be Incognito's main path. Real-Debrid only had 1–2 of
36 top releases cached.

**Indexed seeder counts are stale.** A UDP scrape of three public trackers
(opentrackr, stealth.si, torrent.eu.org; about 1 s for up to 70 hashes)
gives live counts. On 15 Blacked releases:

| Listed | Live |
|---|---|
| 428 | 2–3 |
| 81–147 (five releases) | 0 |
| 50 | 48–57 |

**What the addon does now** (`src/inc/scrape.js`, `catalog.js`):

- Ranks P2P streams by live seeders. A count only an index reported shows
  as "👤 ~428 listed", which auto-pick reads as unknown.
- Card badges and "playable first" use live counts. Playable means at least
  5 live seeders.
- **No pre-warming (your call, 2026-11-22):** opening a title joins no
  swarm. The streaming server starts on a torrent only when you press Play
  or auto-pick does. The cost: a cold torrent's metadata takes 18–30 s
  after Play. (A tried version warmed the top two releases on open; it
  was removed.)
- **RD cache check:** RD streams are only listed when RD reports the torrent
  cached (`[RD+]`), and auto-pick takes those first. Uncached torrents are
  deleted from the account at once.

**Auto-pick on P2P:**

- Incognito P2P streams join the "Main add-on (P2P)" bucket, which is on by
  default. Before, they fell into "Other", which is off, so auto-pick
  refused P2P-only titles.
- Only healthy swarms qualify: at least 5 live seeders and a tenth of the
  best release's count.

**Retry.** Player links carry `?incognito=<id>`. When an Incognito
auto-pick fails, the Player returns to the title page with `autopickRetry`,
and StreamsList skips the failed stream and picks the next. Two triggers:

- Any fatal error.
- Nothing played after 60 s (a stall watchdog). It was 45 s while titles
  were pre-warmed; cold starts need the extra time.

The retry only fires for the stream auto-pick chose, never one picked by
hand. Seen in the browser: pick #4 stalled, it came back at 56 s, and #6
played at 57 s.

**Measured P2P playback** through your running streaming server, top live
release of each scene:

- **The Dutiful Wife:** played; with pre-warm, instant.
- **Scorned:** 19 live seeders, but no metadata in 45 s.
- **Wanderlust Part 2:** 3 live seeders, dead.
- **Yoga for Perverts:** best release has 4 live seeders; auto-pick now
  declines it instead of trying dead swarms.

A second run of 4 Blacked scenes with ranking and pre-warm: 1 started.
"Party Hard" (26 live seeders) and "Scorned" (19) got no metadata in 45 s.

**Control test: is it this PC or the swarms?**

| Torrent | Live seeders | Peers connected | Speed |
|---|---|---|---|
| Ubuntu 24.04 ISO | 44 | 11 within 2 s (9 unchoked) | ~6.8 MB/s overall |
| Tushy scene | 19 | 1 after 50 s | ~10 KB/s |

**Conclusion:** this PC's P2P is healthy. Adult swarms are the limit: most
of the "seeders" a tracker counts can't actually be reached. Ranking and
retry get the most out of what exists, but many scenes won't play over P2P
at all. (These runs used pre-warming, since removed.)

**Ruled out for now:** ranking by peers actually connected (join the top
3–4 swarms, read `/<hash>/stats.json` after about 8 s). It would join
swarms when a title opens, which the no-pre-warm decision excludes.

**Stall watchdog:** "started" is now one-way per stream, so a seek back to
0:00 or the end of the file can't re-arm it.

**Tested in the Shell (2026-11-22).** Setup: the real launcher proxy on
12470 (a scratch build of `StremioLauncher.cs` pointed at the dev UI),
Prowlarr and FlareSolverr started the way the launcher starts them, and
the dev addon on 7000. Playback went through mpv.

- **"Octavia Red And Freya Mayer Knockouts"** (60 live seeders):
  - auto-pick went straight to the player;
  - the picture started at 27 s and played 6 s;
  - then it stalled: trackers gave about 195 peer addresses, the server
    connected to 1, and that peer stopped sending.
  - It stays stuck: once playback has started, the watchdog doesn't retry,
    by design.
- **"24 Hours Part 2"** (live seeders 22 / 21 / 16):
  - pick #1 hadn't played at 60 s, so it went back to the title page and
    auto-pick moved on;
  - pick #2 also stalled;
  - pick #3 played at about 5 MB/s and was still playing past a minute.
  - Pick #1 reached about 1 MB/s some 70 s in, just after it was dropped.
- **Fix from this run:** P2P streams listed only tracker sources, so the
  streaming server never searched DHT. They now carry `dht:<hash>` too, as
  Torrentio's streams do.

**Shell test notes:**
- Switching the Shell's page to another origin closes the Shell, and the
  launcher shuts down with it.
- On the dev origin the Incognito PIN lock is a per-session flag.

## Phase 1 results (2026-11-22)

**ThePornDB, measured with your token:**

- `?parse=<release name>` recognised **40 of 50** real release names: 23/25
  in studio + date form, 17/25 without. Median time is 0.9 s.
- A bare performer name always returns *some* scene, so a match is accepted
  only when the release names the scene's date, or most of its title words.
- No rate-limit headers are sent. The `performers=` filter returns 422.
- The unfiltered "latest" list is mostly clip sites, so rows come from
  torrent releases instead.
- `cdn.` and `thumb.theporndb.net` loaded 15/15, so their images load
  directly. Cards use `background.medium`; the title page uses `large`.

**What works (dev addon on port 7010 + dev web server):**

- **Home rows:**
  - Favorites, then one row per ★ performer and ★ category.
  - Trending, Latest studio scenes, Latest videos, Top rated.
  - The old torrent rows remain at the bottom as "Torrents · …".
- **Cards:** 16:9 artwork, hover-cycled snapshots, a ♥ toggle, a duration
  badge, and the site or release count.
- **Studio scenes:**
  - A row of 75 scenes took 8.5 s cold. 72% got ThePornDB artwork within
    about 20 s; the row re-fetches itself while lookups are pending.
  - Opening a scene runs one targeted search for more releases. Example: one
    release in the row became **8** on the title page (480p–1080p, with
    seeders and sizes).
- **Tube title page:** each site's own qualities. RedTube 1080p played in the
  web player through the relay.
- **Favorites:** stored in `shared/incognito/favorites.json`. Personal
  endpoints only answer the app's own origins.
- **Settings:** favorite performers and categories (add, remove, reorder),
  and the ThePornDB token field. The token is never read back.
- **Old addons:** the web UI checks `/version` and keeps the old torrent home
  when `/inc/*` is missing.
- **Tests:** `tests/incognitoCatalog.spec.js` has 17 unit tests: match
  checks, grouping, merging, relay tokens, favorites and routes.

**Exercised in the dev browser:**

- Home rows with artwork.
- Hover snapshots.
- Title page ♥ and performer ★, which add the Favorites and performer rows.
- A category "see all" grid (46 cards).
- Adding a category in Settings.
- RedTube 1080p playback in the web player.

**Exercised against the addon:**

- **Restart:** three favorites (tube, ThePornDB scene, un-enriched scene)
  still open with streams after an addon restart. Scenes carry their top 8
  releases in the snapshot for this.
- **Node 20:** the new code runs under the launcher's Node 20.18.1.
- **Packaging:** `deploy.sh` copies `src/`, so `src/inc/` is in the addon zip.

**Built, not clicked through:**

- The ♥ on cards.
- Performer and category chip links.
- Reordering favorites in Settings.
- Saving or removing the ThePornDB token from Settings. Not tried, so the
  real token file stayed untouched.

**Tested in the Shell (2026-11-22, dev UI on localhost:8080, dev addon on
7000):**

- **Home page:** Favorites, starred performer and category rows, all rows
  with artwork. The addon-served Eporner thumbnails loaded (10/10 visible).
- **RedTube 1080p:** played in mpv through the relay. A seek from 0:13 to
  2:12 kept playing.
- **Eporner 720p:** played in mpv through the relay.
- **Fixed during the test:**
  - One RedTube stream lookup lost all its retries; lookups now retry once
    more.
  - Some RedTube API entries have broken thumbnail URLs; they now fall back
    to the next good snapshot.

**Not done yet:**

- Proxied images on the live HTTPS page. The Shell won't navigate away from
  its start page, and a relaunch pointed at the HTTPS page exited before its
  debug port came up. The built-in browser (Chrome 156) blocks every
  HTTPS-to-127.0.0.1 request, including the addon calls that already work in
  your Shell, so it can't answer this.
- Shipping. That needs `ADDON_VERSION` and `LAUNCHER_VERSION` bumps.
- ~~Clearnet results on the search page~~: done 2026-11-22. Search shows the clearnet catalog first (studio scenes and movies, healthy P2P first, then amateur and clips); cards open the title page and its auto-pick. Raw torrent hits stay below under "Torrents". Measured: "Lena Paul" gave 94 studio titles, 56 ready over P2P. Many have only 480p or SD copies seeded.
- **Lint:** the new UI files add `react/prop-types` errors, like the existing
  Incognito components. All other rules pass.

## Decision (2026-11-21): option A, ThePornDB in Phase 1

You're getting a ThePornDB token, so studio scenes get artwork from the
start. The background is below.

**Token storage.**

- **Until the Settings field exists,** save the token as a single line in
  `%LOCALAPPDATA%\StremioLauncherFULL\shared\incognito\theporndb-token.txt`.
  The addon reads it from there.
- **Later,** Incognito Settings gets a field that writes the same file.
- **Rules:** the token never goes into the repo, the browser's localStorage,
  logs or chat. The addon sends it only to `api.theporndb.net`.

**First Phase 1 task once the token exists:** confirm what the API actually
returns: scene search, parse from a release name, performer lookup, image
fields and rate limits. Record it here before building on it.

### Background: tube videos and studio scenes don't join up

What you asked for has two halves:

- **Clearnet artwork:** thumbnails, snapshots and clean titles.
- **A multi-source stream list:** RD and torrents with seeders.

Phase 0 found that these come from **different titles**:

- **Tube videos** (Eporner, RedTube) have the artwork and play from the site's
  own files. Torrents almost never exist for them (see result 1), so their
  stream list is just that site's qualities, plus the other site when the same
  video is on both. That second case is probably rare, because titles get
  rewritten.
- **Studio scenes** (built from torrent releases) have the RD and torrent
  list, but no artwork: just the current tinted cards.

**ThePornDB** is what joins the two: studio-scene artwork and performer data,
matched to releases by studio + date + performers. That makes the choice:

- **A: get a ThePornDB token now.** It moves into Phase 1, and studio scenes
  get artwork from the start.
- **B: tube-first.** Phase 1 ships tube videos (artwork + direct play) and
  tinted studio scenes. ThePornDB comes in a later phase.

## Goal

Make the Incognito tab work like Stremio itself:

- **A real catalog.** Titles come from clearnet sites, with proper titles,
  thumbnails, several snapshots per video, performers and categories. They come
  from more than one site so coverage is wide.
- **A stream list page.** Opening a title lists every way to play it: the
  site's own file, Real-Debrid, or a plain torrent. Each stream shows its
  quality, size and seeders. Auto-pick plays the best one and moves on to the
  next when one fails.
- **Favorites everywhere.** Favorite titles, favorite performers and favorite
  categories each get their own rows.
- **Recommendations.** A weekly Claude run picks what to show, plus a local
  "more like this" fallback.
- **Search stays.** So do the PIN lock and saved-search rows.

Trailers are out of scope. Hover snapshots are in.

## Phase 0 results (2026-11-21)

### 1. Torrents almost never match tube videos

| Test | Result |
|---|---|
| 40 "top this week" videos (20 Eporner, 20 RedTube), searching torrents by title | **0/40** real matches. Most are amateur or regional uploads that have no torrent at all. |
| 50 videos from 5 well-known performers (5 RedTube + 5 Eporner each), searching torrents by performer and matching title words | **2/50**, and one of those looks false |

**What this shows:** matching by title words fails. Tube sites rewrite titles
("ANGELA WHITE - Big Natural Tits…"), while torrent releases use the studio's
own scene name:

```
FreeUseFantasy 23 01 07 Jordan Maxx And Maya Woulfe Off To College XXX -XXX
```

**What it doesn't show:** linking by performer pair + studio is untested.
The scorer missed likely true pairs:

- Jordan Maxx + Maya Woulfe against the Off To College release.
- Abella Danger + Eliza Ibarra against a Cum4K release.

Searches also hit the addon's 100-result cap per query, so later releases
were never seen. That key may recover some tube ↔ scene links, but only for
tube titles that name two performers.

**Torrent release names parse well:**

- 941 unique release names from 10 performer and studio searches.
- **63%** parse as `<Studio> <yy mm dd> <rest>`. Many of the rest end in
  `dd mm yyyy` instead, so a second pattern raises this.
- Of 552 parsed scenes, **6%** had more than one release in that sample (at
  most 4).
- A targeted search on opening a title finds more: Off To College alone had 5
  releases (`-XXX`, `PRT`, `WEB-GalaXXXy`, `rq`, …).
- Studio + date alone is not a safe grouping key. `BrazzersExxtra 20 04 29`
  holds two different scenes, so grouping also needs performers and title
  words.

**Decision.** Don't try to attach torrents to tube videos by title. There are
two kinds of title instead (see *Title kinds*):

- **Tube videos** play from the site's own files.
- **Studio scenes** are built *from* torrent releases, grouped by scene, and
  play through RD or P2P.

### 2. Playing the site's own file works, through a local relay

| | Eporner | RedTube |
|---|---|---|
| Resolve id → file URLs | ✓ (page hash → `/xhr/video/<id>`) | ✓ (page `mediaDefinitions` → mp4 list) |
| Qualities on the sample | 720p, 480p, 360p, 240p (whatever was uploaded) | 1080p, 720p, 480p, 240p |
| Needs a Referer header | No | **Yes** (410 Gone without it) |
| URL lifetime | Signed and expiring | `validfrom`/`validto`, a 2 h window |
| Video host reachable | **About half of new connections are reset** (host is under `eporner.com`) | 15/15 (`rdtcdn.com`) |
| Speed once connected | ~1 MB/s | 1080p ~6 MB/s; 720p throttled to ~300 KB/s (still above its 1.7 Mbit/s bitrate) |
| Through the test relay (ffprobe, ffmpeg seek-and-decode, 12 range reads) | ✓ 406×720 h264/aac; seek to 100 s decodes; 11/12 reads (1 timed out at 20 s while retrying); 9 resets retried, 0 failures | ✓ 1920×1080 h264/aac, Referer added by the relay; seek to 600 s decodes; 12/12 reads; 0 resets |

**A test relay solved both problems.** It retries resets before any bytes
arrive and adds the Referer header. Without it, about half of Eporner's
connections fail and every RedTube request returns 410.

**Decision.** Every direct stream plays through an addon relay,
`GET /inc/play/<token>`. The relay:

- adds the Referer header;
- forwards Range requests;
- retries connection resets that happen before the response starts;
- re-resolves the file URL when it expires (410 or 403).

It wasn't tried in the Shell's mpv itself. ffmpeg uses the same demuxer, but
confirming in mpv is the first task of Phase 1.

### 3. Reaching blocked domains: retrying is enough

Connection success per attempt, 15 tries each:

| Host | OK |
|---|---|
| `www.eporner.com` (API and pages) | 12/15 |
| `api.redtube.com` | 8/15 |
| `www.redtube.net` (pages) | 6/15 |
| Eporner thumbnail CDNs | 3–7/15 |
| `rdtcdn.com` (RedTube thumbnails and video) | 15/15 |
| `api.real-debrid.com` | 15/15 |

With up to 10 retries every API and page request got through in Phase 0
(pages took 1–8 tries). **Decision: retries in the addon, with no VPN or
Worker needed**, for API, page and video traffic. The Worker route stays only
as a fallback if that ever stops working.

This means the addon routinely retries past your ISP's connection resets. It
connects straight from your PC; nothing goes through a third party.

**Eporner thumbnails must go through the addon too:** an image proxy with
retries and a disk cache. Loaded straight from the UI, more than half would
break. RedTube thumbnails can load directly. **Unmeasured:** whether proxied
Eporner thumbnails feel fast enough for a full row plus hover snapshots,
given 3–7/15 per connection. The disk cache and loading on hover only are the
mitigations; measure it in Phase 1.

### 4. Real-Debrid cached check: not run

Community sources say Real-Debrid withdrew its instant-availability endpoint in
November 2024. The add → select → status → delete check needs your RD token,
which only the app holds, so it gets tested from the Shell in Phase 2.
`api.real-debrid.com` is reachable 15/15.

### 5. Sources

| Source | Key | Use |
|---|---|---|
| Eporner API | none | Tube catalog: rows, search, tags, 15 snapshots, direct streams |
| RedTube API | none | Tube catalog: rows, search, tags, thumbnails, direct streams up to 1080p |
| Torrent sources (apibay, Knaben, Torrents-CSV, Prowlarr) | none | Studio scenes: rows built from releases; RD and P2P streams |
| ThePornDB | your free token | Artwork, performers and descriptions for studio scenes (Phase 1; anonymous requests get 403) |
| StashDB | invite | dropped |

## Title kinds

| | Tube video | Studio scene |
|---|---|---|
| Comes from | Eporner, RedTube | Torrent releases, grouped by studio + date + performers |
| Artwork | Site thumbnail and snapshots | ThePornDB when you have a token; otherwise the current tinted card |
| Streams | Each site's own files, one row per quality; the same video on both sites is merged | Every release of the scene: RD cached, RD download, P2P with seeders |
| Plays through | Addon relay → Player | Existing `/rd/resolve` or the magnet path |

A **favorite performer row** mixes both kinds, newest first.

### Title (canonical item)

```
id          inc:tube:<site>:<siteId>   |   inc:scene:<studio>:<yymmdd>:<performersSlug>
kind        tube | scene
name        cleaned title
thumbnail   landscape image (proxied for Eporner)
snapshots   [url, …]                   (Eporner: 15; scenes: only with ThePornDB)
duration    seconds (tube)
performers  [name, …]
tags        [name, …]
studio      scene; tube when the title names it
date        scene release date; tube upload date
alsoOn      [{ site, siteId }]         same tube video on another site
releases    [torrent items]            scene only
```

**Merging tube videos across sites.** Two videos are treated as the same when
their normalized titles match, durations are within ±3 s, and at least one
performer is shared.

**Grouping releases into a scene.**

1. Parse each release name as `<Studio> <yy mm dd> <Performers…> <Title> <tags>`,
   with a second pattern for a trailing `dd mm yyyy` date.
2. Group by studio + date + the set of performers + title words. Studio +
   date alone merges different scenes.
3. Releases without a date are grouped by studio + performers + title words.
   When unsure, keep them as separate titles rather than merge them.
4. When a scene's title page opens, run one targeted search
   (`<studio> <performers>`) to collect the releases the row search cut off.

Splitting performers from the title needs a much larger name list than
`pornstars.js`, whose 722 names matched none of the 40 sample titles. Take
names from ThePornDB when available. Otherwise, treat words that repeat
across a studio's releases as names.

## Architecture

All network traffic goes through the bundled addon (`stremio-adult-addon`,
`127.0.0.1:7000`). The UI only talks to the addon. Thumbnails are the one
exception: RedTube's load straight from its CDN.

```
UI (Incognito tab)
  ├─ home rows       GET /inc/rows             → row list
  ├─ row contents    GET /inc/row/<rowId>      → titles
  ├─ title page      GET /inc/title/<id>       → full meta
  ├─ stream list     GET /inc/streams/<id>     → stream candidates
  ├─ play (direct)   GET /inc/play/<token>     → relayed video bytes
  ├─ images          GET /inc/img?u=…          → proxied + disk-cached thumbnails (allowlisted hosts)
  ├─ favorites       GET|POST /inc/favorites
  └─ Claude          GET /claude/picks, POST /claude/taste

addon
  ├─ src/sources/eporner.js, redtube.js   list / search / get / directStreams / tags
  ├─ src/scenes.js                        release-name parser + scene grouping
  ├─ src/relay.js                         play relay + image proxy (retry, Referer, re-resolve)
  ├─ src/net.js                           shared fetch with retry-on-reset for blocked hosts
  ├─ existing                             hybridSearch, rd.js
  └─ data dir                             dirname(PROWLARR_DATA_DIR)/incognito/
```

**Source adapter interface.** Each adapter fails on its own: an error or
timeout yields `[]`, the same rule `directSources.js` already follows.

```
list({ sort, tag, performer, page }) → Title[]
search(query, page)                  → Title[]
get(siteId)                          → Title
directStreams(siteId)                → StreamCandidate[]
tags()                               → string[]
```

**Relay tokens.** A token maps to `{ site, siteId, quality }`. The real file
URL is never sent to the UI and never logged, because these URLs embed the
caller's IP.

## Stream list page

> **Superseded (2026-11-22):** the revised build replaces this. See *Revised direction* and *Revised build: results*. Kept for history.


New route `#/incognito/title/<id>`. The existing `details` route stays for the
old torrent cards.

**Layout:**

- **Hero:** title, duration, date, studio, and the snapshot strip (click to
  enlarge).
- **Chips:** performers and categories. Tapping a chip opens its row; ★ adds
  it to favorites.
- **♥ Favorite** button.
- **Auto-pick banner,** when auto-pick is on: "Playing best: RedTube 1080p…"
  with **Cancel**.
- **Stream list,** one row per candidate. It fills in progressively: direct
  streams arrive in about 1–3 s (retries included), torrent releases within
  the existing 6 s search deadline.

**Each stream row shows:**

- **Kind badge:** `Direct · RedTube`, `Direct · Eporner`, `RD cached`,
  `RD download`, or `P2P`.
- **Details:** quality, size, seeders/peers and release group (torrents),
  measured speed (direct, after one play).
- **Verdict:** `✓ played before`, `✗ failed <date>`, or `⏳ RD still
  downloading`.
- **Actions:** Play, and the multi-file picker for multi-video torrents.

**Play paths to reuse:**

- **RD and P2P** go through `useIncognitoPlay`: RD first, magnet fallback, no
  library entry.
- **The multi-file picker** lives in `src/routes/Torrent/Torrent.js` today
  (`/rd/files`, then a choice of file). Lift it into a shared component so the
  stream list and `Torrent.js` both use it.
- **Direct** streams send the relay URL to the Player as a plain HTTP stream.

## Auto-pick

> **Superseded (2026-11-22):** the revised build replaces this. See *Revised direction* and *Revised build: results*. Kept for history.


Incognito gets its own config (`incognito_autopick_config`), separate from the
main one. The main auto-pick behaviour is not touched.

**Settings:**

- On/off toggle (default on).
- Preferred quality order. Default: 1080p → 720p → 4K → lower.
- Source order:
  - Tube videos: the site with the best measured speed at the preferred
    quality, RedTube first until speeds are known.
  - Studio scenes: RD cached → RD download → P2P.
- Minimum seeders for P2P (default 5). Maximum size (optional).

**Ranking.** Reuse `detectQuality` and the ranking shape from
`src/common/autoPick.js`, using incognito source buckets. If a shared function
needs changing, pass options in rather than changing what it does by default.

**Flow:**

1. **Start.** Opening a title (or a card with auto-pick on) starts it.
2. **Wait.** Auto-pick starts once the top enabled source has answered or the
   6 s deadline passes, whichever comes first.
3. **Preflight the top candidate:**
   - **direct:** the relay does a 1-byte Range GET through its retry path and
     needs 206 and a video content type.
   - **rd:** the RD cached check (below), then the unrestricted link goes
     through the existing `streamPreflight` stub check.
   - **p2p:** seeders must be at or above the minimum.
4. **Play.** A failed preflight is marked `✗` and the next candidate is
   tried. A pass plays after the same 0.8 s cancellable delay the main
   auto-pick uses.
5. **Retry after a Player failure.** If the Player fails on an incognito
   auto-pick, it returns to `#/incognito/title/<id>?retry=<ts>`. The failure
   is recorded and the next candidate is tried. After **3** failures it stops
   and shows the list with the reasons.
6. **Remember.** The last stream that played is stored per title and tried
   first next time.

**Rules carried over from the main auto-pick** (these broke before):

- Readiness is keyed to the title id and waits for the meta to load.
- Cleanup cancels a pending jump *and* clears the trigger.
- `history.state.incognitoAutoPickPlayed` is set on the entry it navigated
  from. Going back to that entry never auto-plays again.
- Cancellation is never loosened. Test the stale-key and back-navigation
  cases before shipping.

**Player hook.** Incognito plays today open `#/player/<encoded>` with no type
or id, so the Player's retry logic never fires for them. The plan:

- Write an `incognitoAutoPick` record (title id, candidate key) to
  sessionStorage before navigating.
- `Player.onError` checks for that record and redirects back to the title page.
- Keep the current isolation: no `metaRequest`, so Incognito plays never reach
  Library or Continue Watching.

**RD cached check (Phase 2, to test from the Shell):**

- Call `addMagnet`, then `selectFiles`, then read the torrent status.
- `downloaded` means it is cached. Anything else is deleted
  (`DELETE /torrents/delete/<id>`), unless the user picks that stream by hand.
- Only the top 3 RD candidates are checked, and verdicts are cached for 24 h.
- **Side effect:** `selectFiles` starts a real download on your RD account
  when the torrent isn't cached. The check therefore runs only when auto-pick
  is about to play, never just because a title page opened.
- **Cache:** the delete must also evict the `listingCache` entry in `rd.js`
  that holds that `torrentId` for 30 minutes. Today's `rd.js` never deletes
  torrents.

## Favorites

| What | How it's added | Row |
|---|---|---|
| **Titles** (tube videos and studio scenes) | ♥ on cards (hover or long-press) and on the title page | **Favorites**, the first row on the home page, newest first, with a "see all" grid |
| **Performers** | ★ on a performer chip, from search, or in Settings | One row per performer: tube videos + studio scenes, newest first |
| **Categories** | ★ on a category chip, or a picker in Settings built from each site's `tags()` | One row per category |

- **Storage:** `dirname(PROWLARR_DATA_DIR)/incognito/favorites.json`, written
  by the addon. The launcher sets `PROWLARR_DATA_DIR` to
  `<appRoot>/shared/prowlarr-data` (`StremioLauncherFULL.cs:189`, `:254`,
  `:1145`), and `shared/` survives addon re-extracts and launcher updates.
  A localStorage mirror lets the page paint instantly.
- **Snapshot:** each favorite title stores a copy of its meta (name,
  thumbnail, ids), so the row still renders when a site is down.
- **Settings:** a Favorites section for reordering and removing favorite
  performers and categories, and for hiding or reordering rows.
- **Saved-search rows:** kept as they are.

## Home page rows (top to bottom)

> **Superseded (2026-11-22):** the revised build replaces this. See *Revised direction* and *Revised build: results*. Kept for history.


1. **Favorites**
2. **Claude picks for you**, only when a picks file exists
3. **More like what you like**, the local fallback recommender
4. One row per **favorite performer**
5. One row per **favorite category**
6. **Trending this week · Latest · Top rated**, tube videos merged across sites
7. **Latest studio scenes**, grouped torrent releases
8. **Saved-search rows** (existing)

Each row paints from the existing stale-while-revalidate cache pattern and
refreshes in the background, which also hides the retry latency.

## Cards

- **Shape:** landscape 16:9 thumbnail. Studio scenes without ThePornDB keep
  the tinted style.
- **Badges:** duration or release count, best quality, and the number of
  sites or releases.
- **Hover:** cycles through the snapshots every ~600 ms. Snapshots load only
  on hover, through the image proxy where needed.
- **Actions:** ♥ favorite and 👎 not interested (hides the title and feeds
  recommendations).
- **Click:** opens the title page. Auto-pick takes over from there if it is
  on.

## Recommendations

**Claude picks.** The same pattern as the Board's "Claude recommended" row
(commit 320abc963), but served by the addon, so the launcher isn't involved:

- **Taste snapshot,** `POST /claude/taste`, at most once a day: favorite
  titles, performers and categories; the last 200 plays (name, performers,
  tags, % watched); and not-interested titles. Names and tags only.
- **Picks file,** written by a weekly Claude run (a scheduled task like the
  Board one): rows such as `{ title, reason, performer | tag | query }` plus
  up to 30 suggested titles. Claude suggests performers, categories, studios
  and search queries, and the addon turns them into real titles. That way a
  pick always resolves to something playable.
- **Opt-in:** with no picks file, the row never shows and no snapshot is
  stored.

**Local fallback ("More like what you like").** Counts which performers and
tags appear together across favorites and plays, keeps the top 5, and queries
the sources.

## Privacy

- Sites see this PC's IP, the same as browsing them.
- Eporner thumbnails and all direct video go through the local addon. RedTube
  thumbnails load straight from its CDN.
- File URLs embed the caller's IP, so the addon keeps them server-side and
  never logs them.
- No account names or tokens leave the PC.
- Favorites, plays and the taste snapshot stay in the local shared folder.

## Phases

Each phase ships on its own.

**Phase 0: spike. Ran 2026-11-21; results above.**

- [x] Torrent match rate by title: 0/40 and 2/50. Performer-pair linking is
  untested.
- [x] Release-name parsing: 63% studio + date; 6% of scenes have more than
  one release in the row sample.
- [x] Blocked domains: retrying in the addon is enough for API, page and
  video traffic.
- [x] Eporner direct stream: works through the retrying relay (ffmpeg).
- [x] RedTube direct stream: works through the relay with a Referer header,
  up to 1080p (ffmpeg).
- [ ] Playback in the Shell's mpv: moved to the start of Phase 1.
- [ ] RD cached check: moved to Phase 2 (needs your token, tested from the
  Shell).
- [x] **ThePornDB now or later:** now (option A).

**Phase 1: catalog, title page and favorites. Built; see *Phase 1
results*.**

1. **Prove playback:** play one relayed Eporner and one RedTube file in the
   Shell's mpv.
2. **ThePornDB check:** once the token file exists, confirm the API's real
   responses (search, parse, performers, images, limits).
3. **Addon:**
   - `net.js` (retry) and `relay.js` (play relay + image proxy).
   - `sources/eporner.js`, `sources/redtube.js`, `sources/theporndb.js`.
   - `scenes.js` (releases → scenes, linked to ThePornDB scenes by studio +
     date + performers).
   - The `/inc/*` endpoints and favorites storage.
4. **UI:**
   - New home rows and landscape cards with hover snapshots.
   - The title page with the stream list (manual play).
   - ♥ and ★ everywhere.
   - The Settings sections: Favorites, and the ThePornDB token field.

**Phase 2: auto-pick.** Mostly covered now: the title page uses Stremio's own StreamsList, whose auto-pick runs unchanged. Still open: the Player retry route back to the Incognito page.

**Phase 2 (original plan):**

- Incognito auto-pick config and ranker, preflight per kind, Player retry
  hook, remembering what played, the RD cached check tested from the Shell.

**Phase 3: recommendations. Built 2026-11-22** (`src/inc/taste.js`, the
`claude` and `foryou` rows in `catalog.js`, `POST /inc/played`).

- **Play log.** The Player posts `/inc/played` once an Incognito title
  shows its first frame. The addon keeps the last 200 plays in `plays.json`:
  name, studio, performers, tags and time only. A replay within 6 h updates
  the entry.
- **Opt-in, as on the Board.** `claude-picks.json` in the Incognito data
  folder turns it on. Without that file:
  - no taste snapshot is written;
  - the "Claude picks" row doesn't exist.
- **Taste snapshot.** `claude-taste.json` holds favorites and plays, names
  only. It is rewritten after every play and favorites change, and whenever
  the Claude row loads.
- **"Claude picks" row.**
  - Each pick names a performer, studio, category, search or exact scene.
  - It becomes up to 3 real titles, playable first, each showing the pick's
    reason on the card.
  - Picks are interleaved in the file's order.
  - Titles you favorited or played are left out.
- **"More like what you like"** (when there are no picks). It counts the
  performers, studios and categories that recur in favorites (weight 2) and
  plays (weight 1), skips ones you already follow, and needs a score of 2.
- **Privacy.** Both rows and `/inc/played` answer only the app's own
  origins (a foreign origin got 403).
- **Speed.** Each pick's torrent search gets 6 s. Past that, the row answers
  with ThePornDB titles and reports itself pending, while the search
  finishes in the background (cached 3 h).
  - Measured with cold searches: first load went from about 80 s to
    12–18 s.
  - Follow-up fetches take 2 s.
  - The Claude row went from 3 to 7 of 9 titles playable as the searches
    landed.
- **Weekly task.** The prompt is in `docs/incognito-claude-picks-task.md`,
  for a scheduled task like the Board's Friday one. It reads only the taste
  and picks files. It isn't created yet: it would send your Incognito taste
  to Claude every week, so it waits for your OK.
- **Not built:** 👎 "not interested".

**Shipping.**

- Every addon change bumps `ADDON_VERSION`, which lives in
  `StremioLauncherFULL.cs`. An installed FULL only replaces itself when the
  deployed `StremioNeo.version` differs from its `LAUNCHER_VERSION`
  (`StremioLauncherFULL.cs:612-615`), so `LAUNCHER_VERSION` moves too.
- `BASE_LAUNCHER_VERSION` (and `WEB_UI_CACHE_VERSION`) only move when
  `StremioLauncher.cs` itself changes.
- Web changes go out through `deploy.sh`.
- Test in the Shell (the launcher branch), not only in the browser.

## Testing

- **Unit tests:** release-name parser and scene grouping, tube dedup, the
  incognito ranker, relay retry (simulated resets), and the favorites store.
  The jest baseline isn't green, so compare per file.
- **Manual tests in the Shell:**
  - Direct streams play and seek.
  - Auto-pick plays the top candidate.
  - A forced failure moves on to the next candidate.
  - Back-navigation never auto-plays.
  - Cancel works.
  - Favorites survive an addon update and a localStorage clear.

## Open questions

1. Should auto-pick be on by default?
2. Should the old torrent rows go away once "Latest studio scenes" exists?
