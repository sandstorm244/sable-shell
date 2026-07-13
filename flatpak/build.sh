#!/bin/sh
# Build the flatpak bundle in a container (flatpak-builder needs bubblewrap,
# hence --privileged; everything else is unprivileged).
# Prereq: dist/linux-unpacked exists (README step 2 builds it).
# Output: dist/sable-shell.flatpak — install with:
#   flatpak install --user ./dist/sable-shell.flatpak
set -e
cd "$(dirname "$0")/.."

# The named volume caches flathub runtimes across runs (~1.5GB)
docker run --rm --privileged -v "$PWD":/w -v sable-flatpak-cache:/var/lib/flatpak \
  -w /w/flatpak debian:trixie bash -c '
  set -e
  apt-get update -qq && apt-get install -y -qq flatpak flatpak-builder ca-certificates >/dev/null
  flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
  flatpak install -y --noninteractive flathub \
    org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 \
    org.electronjs.Electron2.BaseApp//24.08
  flatpak-builder --force-clean --disable-rofiles-fuse --state-dir=/tmp/fb-state \
    --repo=/tmp/repo /tmp/build moe.sable.Shell.yml
  flatpak build-bundle \
    --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
    /tmp/repo /w/dist/sable-shell.flatpak moe.sable.Shell
  chown '"$(id -u):$(id -g)"' /w/dist/sable-shell.flatpak
'
echo "done: dist/sable-shell.flatpak"
