# Stremio Neo guide

[Setup](#setup) · [Auto-Pick](#auto-pick) · [Trakt](#trakt) · [Mac](#mac) · [iPhone and iPad](#iphone-and-ipad) · [Troubleshooting](#troubleshooting) · [Privacy](#privacy)

## Setup

About ten minutes. Steps 1 to 3 must be done on a computer, even if you mainly want Neo on your iPhone.

1. **Install Stremio** from [stremio.com/downloads](https://www.stremio.com/downloads). This is the official app; Neo runs inside it.
2. **Create a Stremio account** (Sign up, or Log in). It stores your library, add-ons and settings.
3. **Add your add-ons.** Stremio has nothing to play on its own. Open **Add-ons**, install the ones you trust, and click **Configure** on any that need a key. Add-ons are saved to your account, so you only do this once.
4. **Download [`StremioNeo.exe`](https://github.com/jeromenicholas07/stremio-neo/releases/latest/download/StremioNeo.exe)** and save it somewhere permanent.
5. **Double-click it.** Windows shows a blue "Windows protected your PC" box the first time because the file isn't code-signed: click **More info**, then **Run anyway**.

Keep the launcher running while you watch; closing it closes Stremio. Neo updates itself on every start.

## Auto-Pick

**Settings → Modern UI → Playback → Auto-Pick Stream.**

- Drag **Sources** (Real-Debrid cached, other debrid services, P2P) and **Quality** (4K HDR, 4K, 1080p, 720p) into your preferred order. Switch off any you never want.
- If a stream is dead, Neo plays the next best one.
- Real-Debrid sometimes serves a short error clip in place of a removed file. Neo recognises those and skips them.
- When an episode ends, the next one is picked and played.
- Each show's streams page lets you keep the global order or set a custom one, or turn Auto-Pick off for that show.

The stream list is always there if you want to choose by hand.

## Trakt

1. Create a free account at [trakt.tv](https://trakt.tv).
2. In Neo: **Settings → Modern UI → Connect to Trakt**.
3. Paste the code shown into trakt.tv/activate and approve.
4. Click **Sync Now**.

You get watchlist, rating and history sync, scrobbling, and home rows such as Recommended, Trending, IMDb Top 250, Oscar Best Picture, A24 and Studio Ghibli. The **Advanced** fields and TMDB key are pre-filled; leave them unless you have your own.

## Mac

1. Install Stremio into Applications and sign in once.
2. Download [`StremioNeo-mac.zip`](https://github.com/jeromenicholas07/stremio-neo/releases/latest/download/StremioNeo-mac.zip) and unzip it.
3. Right-click **Stremio Neo**, choose **Open**, then **Open** again (macOS asks because the app isn't notarised).

The Mac build opens Stremio with the Neo interface. It doesn't include the helper services the Windows launcher runs, so the subtitle-sync speed-up, blocked-file check and optional extras are Windows only. It is new and lightly tested; please [open an issue](https://github.com/jeromenicholas07/stremio-neo/issues) if it doesn't start.

## iPhone and iPad

Nothing to install from the App Store. First do Setup steps 1 to 3 on a computer.

1. In **Safari**, open [jeromenicholas07.github.io/stremio-neo](https://jeromenicholas07.github.io/stremio-neo/#/).
2. Tap **Share → Add to Home Screen → Add**.
3. Open **Stremio Neo** from the Home Screen and log in.
4. Leave **Settings → Streaming** server URL empty.
5. Install [Infuse](https://apps.apple.com/app/infuse-7/id1136220934) or VLC. When Safari can't play a format (MKV, HEVC, AC3, 4K HDR), the player offers a button to open it there.

Peer-to-peer streams don't work on iPhone; you need an add-on backed by a service such as Real-Debrid. More detail in [IOS.md](IOS.md).

## Optional extras

Off by default, under **Settings → Modern UI**: torrent search results in Search, and a PIN-locked private section. Windows only; they download extra components when switched on.

## Troubleshooting

| Problem | Fix |
|---|---|
| Stremio opens blank | Close everything and run Stremio Neo again. The interface loads from the web, so check your connection. |
| Launcher closes at once, or "port in use" | An old copy is running. In Task Manager, end `Stremio` and `StremioLauncher` tasks, then retry. |
| Nothing plays | That's the add-on side. Check your add-ons are still installed and configured. |
| Auto-Pick chose the wrong stream | Reorder or switch off sources and qualities, or turn Auto-Pick off for that show. |
| I had the older "Stremio Custom UI" launcher | It updates itself to Neo on its next start. If it opens blank, download `StremioNeo.exe`. |
| Start over | Delete `%LOCALAPPDATA%\StremioLauncherFULL`. The next launch rebuilds it. |
| Remove it | Delete that folder, `StremioNeo.exe` and the **Stremio Neo** Start Menu entry. Stremio itself is untouched. |
| iPhone: no "Add to Home Screen" | You're not in Safari. |
| iPhone: sound but no picture | Tap the **Infuse** or **VLC** button in the player. |

## Privacy

- Neo talks to the same services Stremio does, plus Trakt and TMDB if you use those features.
- Page views are counted anonymously with [GoatCounter](https://www.goatcounter.com): no cookies, no personal data.
- Shared Trakt and TMDB app keys are included so things work out of the box; you can enter your own. Connecting Trakt signs in to your own account.
- Subtitle sync runs entirely on your device. The speech model (about 75 MB) downloads once.
