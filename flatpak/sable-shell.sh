#!/bin/sh
# The runtime ships only the C.UTF-8 glibc locale; a host LANG like
# en_US.UTF-8 leaves the process in plain "C" locale, which breaks
# libX11's text-property conversion — SDL/CEF windows (WM_NAME typed
# "UTF-8", e.g. Steam games) then silently vanish from the screen-share
# picker. Pin a UTF-8 locale that actually exists in the runtime.
export LC_ALL=C.UTF-8 LANG=C.UTF-8

# zypak (from the Electron base app) runs Chromium's sandbox inside flatpak
exec zypak-wrapper /app/sable-shell/sable-shell "$@"
