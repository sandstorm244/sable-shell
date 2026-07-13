# sable-shell

A minimal desktop shell for [Sable](https://github.com/SableClient/Sable).
It loads the web client from your deployment and adds the one thing a
browser can't do: **screen sharing with application audio**.

This project is merely an implementation example and may or may not be maintained.
The application works as advertised but there is a risk of breakage and the application comes with NO WARRANTY.

License: GNU AGPLv3

| Platform | Window/screen picker | Share audio |
|---|---|---|
| Linux (X11 or Wayland, PipeWire) | graphical picker | per-application or all applications, via [venmic](https://github.com/Vencord/venmic) |
| Windows (10 2004+) | graphical picker | per-application (WASAPI process loopback) or system-wide; the call's own audio is never captured |

Only the person *sharing* needs this shell. Everyone else can stay on the
PWA — the shared audio arrives as a normal call track.

## How it works

- `src/main.js` intercepts the web app's `getDisplayMedia()` via Electron's
  `setDisplayMediaRequestHandler` and shows `src/picker/` (thumbnails of
  windows/screens + an audio selector).
- On Linux, [venmic](https://github.com/Vencord/venmic) creates a virtual
  PipeWire microphone (`vencord-screen-share`) fed by the chosen
  application's audio; `src/patch.js` (injected into every frame, including
  the embedded SableCall widget) attaches that device to the share stream.
  The shell's own audio is excluded, so no echo.
- On Windows, audio comes from Chromium's built-in WASAPI loopback
  devices — per-application (`applicationLoopback:<pid>`, the pid resolved
  by the bundled `sable-winhelper.exe`) for window shares, system-wide
  for screen shares.
- Minimized windows show up as placeholder tiles (they can't be
  thumbnailed) and are restored automatically when the share starts.
- The shell lives in the tray; closing the window keeps the call running.

No changes to Sable or SableCall are needed.

## Building

Everything builds in containers from this source tree. npm's script gate
(the `allowScripts` field in `package.json`) keeps install scripts from
running during `npm ci`, so the two native steps are explicit commands:
electron's runtime download, and venmic recompiled from its bundled C++
source (the prebuilt `.node` it ships is deleted first).

```sh
# 1. Dependencies + native pieces:
#    - electron's runtime download (install.js)
#    - venmic compiled from source and vendored into vendor/venmic/
docker run --rm -v "$PWD":/w -w /w node:24-trixie bash -c '
  apt-get update -qq && apt-get install -y -qq \
    libpipewire-0.3-dev libpulse-dev cmake build-essential ninja-build git &&
  cd /w && npm ci &&
  node node_modules/electron/install.js &&
  rm -rf node_modules/@vencord/venmic/prebuilds node_modules/@vencord/venmic/build &&
  (cd node_modules/@vencord/venmic && npx cmake-js compile --CDvenmic_addon=ON) &&
  cp node_modules/@vencord/venmic/build/Release/venmic-addon.node vendor/venmic/ &&
  chown -R '"$(id -u):$(id -g)"' /w'

# 2. Linux artifacts (AppImage + deb):
docker run --rm -v "$PWD":/w -w /w electronuserland/builder:22 \
  bash -c 'cd /w && npm run dist:linux && chown -R '"$(id -u):$(id -g)"' /w'

# 3. Windows artifacts (NSIS installer + portable exe), cross-built.
#    The window helper (win/helper.cs — HWND→PID, restore, minimized
#    listing) is compiled first with mono's C# compiler:
docker run --rm -v "$PWD":/w -w /w electronuserland/builder:wine \
  bash -c 'apt-get update -qq && apt-get install -y -qq mono-mcs &&
    cd /w && mkdir -p build-res/win &&
    mcs -optimize -out:build-res/win/sable-winhelper.exe win/helper.cs &&
    npm run dist:win && chown -R '"$(id -u):$(id -g)"' /w'

# 4. Flatpak (sandboxed; needs step 2's dist/linux-unpacked first):
./flatpak/build.sh          # → dist/sable-shell.flatpak
flatpak install --user ./dist/sable-shell.flatpak
```

Artifacts land in `dist/`. When bumping a dependency with an install
script (electron, venmic), update its pinned entry in `allowScripts` too.

## Flatpak sandbox

`flatpak/moe.sable.Shell.yml` documents every hole in the sandbox
and why it exists. The notable ones: network (the app loads from your
server), X11 (display + window capture), pulseaudio (microphone), and
`xdg-run/pipewire-0` — the single extra grant that lets venmic capture
application audio (the same permission OBS's flatpak uses). No home
filesystem access, no host D-Bus, no raw devices. Chromium's own sandbox
runs nested via zypak from the Electron base app.

## What ships

The packaged app is Electron, the files in `src/`, the source-built
`venmic-addon.node`, and one runtime npm dependency: `x11`, a pure-JS
X11 client used to resolve a picked window's process id. Windows builds
also bundle `sable-winhelper.exe` (~90 lines of C# in `win/helper.cs`,
compiled during the build) — window operations go through it rather
than PowerShell. Everything else in `node_modules` is build tooling and
stays in the build container.

The lockfile pins every package with an integrity hash, and the build
containers hold no credentials. Known `npm audit` findings: three
`node-tar` path-traversal advisories (no fix released) in cmake-js's
tree, reachable only during the build.

Bundled third-party code: venmic (MPL-2.0), x11 (MIT), Electron (MIT).

## Running

No server is hardwired by default. First launch asks for your Sable
deployment's address and saves it (File → Change server… to re-ask).
To ship builds that land straight on your deployment's login screen —
like a hosted Sable instance would — set `"defaultUrl"` in `package.json`
before building; users can still switch homeservers inside the login
form or override the whole client via File → Change server. The
`SABLE_URL` environment variable overrides everything for one-off runs:

```sh
npm start
SABLE_URL=https://other.server npm start
```

Log in once; the session persists in the Electron profile.

## Testing checklist

1. Join a call, hit share → the graphical picker should appear
   (not Chrome's built-in one).
2. Pick a window + an application's audio → the tile appears for others
   **with sound**, and your own mic keeps working independently.
3. Stop the share → `pactl list short nodes | grep vencord` (or
   `pw-cli ls Node`) should show the virtual node gone (venmic unlinked).
4. Windows: share a window with its app's audio, and a whole screen
   with "System audio" — remote listeners hear both, without effects.

## Notes

- The venmic binary is compiled on Debian 13 (trixie) — gcc 12/bookworm
  is too old (`<format>`, pipewire headers). The resulting `.node` links
  against trixie-era glibc/libstdc++, so sharers need a ~2025-or-newer
  distro. Building on an older base with a newer gcc would relax this if
  it ever matters.

- Minimized windows can be picked, but frames only flow once the window
  is restored — nothing renders a minimized window, on either OS. The
  shell restores it automatically when the share starts.
- If PipeWire is absent (plain PulseAudio), the picker still works but
  audio options are unavailable.
