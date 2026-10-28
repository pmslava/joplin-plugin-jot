#!/usr/bin/env bash
#
# Downloads and extracts the Joplin desktop AppImage used by the real-app E2E tests, and downloads the
# released Note Tabs plugin (.jpl) that the Note Tabs spec installs beside Jot.
# Idempotent: skips each download/extract when its result already exists.
#
# Override the versions with JOPLIN_E2E_VERSION (must be >= the plugin's app_min_version) and
# NOTE_TABS_E2E_VERSION (a Note Tabs release whose tabsPinNote takes an array of note ids: 1.1.0 or later).
#
set -euo pipefail

JOPLIN_VERSION="${JOPLIN_E2E_VERSION:-3.6.14}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$REPO_ROOT/.e2e-cache"
APPIMAGE="$CACHE_DIR/Joplin.AppImage"
BINARY="$CACHE_DIR/squashfs-root/joplin"
URL="https://github.com/laurent22/joplin/releases/download/v${JOPLIN_VERSION}/Joplin-${JOPLIN_VERSION}.AppImage"
NOTE_TABS_VERSION="${NOTE_TABS_E2E_VERSION:-1.4.0}"
# The version is in the file name, so a bumped NOTE_TABS_E2E_VERSION fetches its own archive rather than keeping the old one (e2e/launch.ts reads the same name).
NOTE_TABS_JPL="$CACHE_DIR/joplin.plugin.note.tabs-${NOTE_TABS_VERSION}.jpl"
NOTE_TABS_URL="https://github.com/benji300/joplin-note-tabs/releases/download/v${NOTE_TABS_VERSION}/joplin.plugin.note.tabs.jpl"

mkdir -p "$CACHE_DIR"

# Note Tabs first, because the Joplin half below exits early once the AppImage is extracted, which on a
# developer machine is every run but the first.
if [ ! -f "$NOTE_TABS_JPL" ]; then
  echo "[setup-e2e] Downloading Note Tabs $NOTE_TABS_VERSION ..."
  # Same rules as the AppImage below: fail on an HTTP error, retry blips, never cache a partial file. The download
  # lands in a .part file and takes its final name only once it has passed the checks, so a download killed halfway
  # (Ctrl-C, a cancelled CI job) is never found and trusted by the next run.
  rm -f "$NOTE_TABS_JPL.part"
  if ! curl -fSL --retry 3 --retry-delay 2 -o "$NOTE_TABS_JPL.part" "$NOTE_TABS_URL"; then
    echo "[setup-e2e] ERROR: failed to download Note Tabs $NOTE_TABS_VERSION from $NOTE_TABS_URL" >&2
    rm -f "$NOTE_TABS_JPL.part"
    exit 1
  fi
  # A .jpl is a tar of the built plugin, about 47 KB for 1.4.0; a few KB is an error page that slipped through, and a
  # tar without the plugin's manifest is not a plugin.
  if [ "$(stat -c%s "$NOTE_TABS_JPL.part" 2>/dev/null || echo 0)" -lt 20000 ]; then
    echo "[setup-e2e] ERROR: downloaded Note Tabs plugin is implausibly small — treating as a failed download" >&2
    rm -f "$NOTE_TABS_JPL.part"
    exit 1
  fi
  if ! tar -tf "$NOTE_TABS_JPL.part" manifest.json >/dev/null 2>&1; then
    echo "[setup-e2e] ERROR: downloaded Note Tabs plugin is not a plugin archive (no manifest.json in the tar)" >&2
    rm -f "$NOTE_TABS_JPL.part"
    exit 1
  fi
  mv "$NOTE_TABS_JPL.part" "$NOTE_TABS_JPL"
else
  echo "[setup-e2e] Note Tabs already at $NOTE_TABS_JPL — nothing to do."
fi

if [ -x "$BINARY" ]; then
  echo "[setup-e2e] Joplin already extracted at $BINARY — nothing to do."
  exit 0
fi

if [ ! -f "$APPIMAGE" ]; then
  echo "[setup-e2e] Downloading Joplin $JOPLIN_VERSION ..."
  # -f: fail (non-zero exit) on an HTTP error such as a 404 for a mistyped/withdrawn version, rather
  # than silently saving the error page as "Joplin.AppImage" and failing confusingly at extract time.
  # --retry: ride out transient network/CDN blips. The download lands in a .part file and takes its final name only
  # once it has passed the size check, so neither a failed nor an interrupted download is ever cached.
  rm -f "$APPIMAGE.part"
  if ! curl -fSL --retry 3 --retry-delay 2 -o "$APPIMAGE.part" "$URL"; then
    echo "[setup-e2e] ERROR: failed to download Joplin $JOPLIN_VERSION from $URL" >&2
    rm -f "$APPIMAGE.part"
    exit 1
  fi
  # A valid AppImage is well over 100 MB; anything tiny is an error page that slipped through.
  if [ "$(stat -c%s "$APPIMAGE.part" 2>/dev/null || echo 0)" -lt 10000000 ]; then
    echo "[setup-e2e] ERROR: downloaded AppImage is implausibly small — treating as a failed download" >&2
    rm -f "$APPIMAGE.part"
    exit 1
  fi
  mv "$APPIMAGE.part" "$APPIMAGE"
  chmod +x "$APPIMAGE"
fi

echo "[setup-e2e] Extracting AppImage (no FUSE required) ..."
( cd "$CACHE_DIR" && "$APPIMAGE" --appimage-extract >/dev/null )

if [ ! -x "$BINARY" ]; then
  echo "[setup-e2e] ERROR: expected Electron binary not found at $BINARY" >&2
  exit 1
fi

echo "[setup-e2e] Ready: $BINARY"
