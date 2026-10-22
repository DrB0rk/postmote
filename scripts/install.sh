#!/bin/sh
set -eu

REPOSITORY="DrB0rk/postmote"
RELEASE_BASE="${POSTMOTE_RELEASE_BASE_URL:-https://github.com/${REPOSITORY}/releases/latest/download}"
INSTALL_DIR="${POSTMOTE_INSTALL_DIR:-${HOME:?HOME must be set}/.local/bin}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_CYAN='\033[36m'; C_GREEN='\033[32m'; C_RED='\033[31m'; C_DIM='\033[2m'; C_RESET='\033[0m'
else
  C_CYAN=''; C_GREEN=''; C_RED=''; C_DIM=''; C_RESET=''
fi

say() { printf '%b%s%b\n' "$C_CYAN" "$1" "$C_RESET"; }
ok() { printf '%b  ✓%b %s\n' "$C_GREEN" "$C_RESET" "$1"; }
fail() { printf '%b  ✗%b %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }

printf '\n%b  POSTMOTE%b  %s\n' "$C_CYAN" "$C_RESET" '────────────────────────────'
printf '  %bLocal mail bridge installer%b\n\n' "$C_DIM" "$C_RESET"

command -v curl >/dev/null 2>&1 || fail "curl is required. Install curl, then run this command again."
command -v mktemp >/dev/null 2>&1 || fail "mktemp is required to verify downloads safely."

os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]') || fail "Could not detect this operating system."
arch=$(uname -m 2>/dev/null | tr '[:upper:]' '[:lower:]') || fail "Could not detect this processor architecture."
case "$os" in
  linux) platform=linux ;;
  darwin) platform=macos ;;
  *) fail "Unsupported operating system: $os. Supported: Linux and macOS." ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail "Unsupported processor architecture: $arch." ;;
esac
asset="postmote-${platform}-${arch}"
if [ "$platform" = linux ] && [ "$arch" = arm64 ]; then
  : # Linux ARM64 is published as a separate release target.
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/postmote-install.XXXXXX") || fail "Could not create a temporary download directory."
staged=''
trap 'rm -rf "$tmp"; if [ -n "$staged" ]; then rm -f "$staged"; fi' EXIT
trap 'exit 1' HUP INT TERM
binary="$tmp/$asset"
checksums="$tmp/checksums.txt"

say "Platform  ${platform} / ${arch}"
say "Download  latest verified release"
if [ -t 1 ]; then
  curl --fail --location --silent --show-error --progress-bar --retry 3 --connect-timeout 15 "$RELEASE_BASE/$asset" --output "$binary" || fail "Download failed. Check your network and try again."
else
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 "$RELEASE_BASE/$asset" --output "$binary" || fail "Download failed. Check your network and try again."
fi
curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 "$RELEASE_BASE/checksums.txt" --output "$checksums" || fail "Could not download the release checksum list."
[ -s "$binary" ] || fail "The downloaded release file is empty."
ok "Release downloaded"

expected=$(awk -v wanted="$asset" '$2 == wanted { print $1; found=1; exit } END { if (!found) exit 1 }' "$checksums") || fail "No checksum was published for $asset."
case "$expected" in *[!0-9a-fA-F]*|'') fail "The release checksum entry is invalid." ;; esac
[ "${#expected}" -eq 64 ] || fail "The release checksum entry is invalid."
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$binary" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$binary" | awk '{print $1}')
else
  fail "A SHA-256 utility (sha256sum or shasum) is required to verify this release."
fi
[ "$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" ] || fail "Checksum verification failed. The existing installation was left untouched."
ok "SHA-256 checksum verified"

mkdir -p "$INSTALL_DIR" || fail "Could not create install directory: $INSTALL_DIR"
chmod 755 "$binary" || fail "Could not mark the downloaded app executable."
target="$INSTALL_DIR/postmote"
staged="$INSTALL_DIR/.postmote.$$"
cp "$binary" "$staged" || fail "Could not stage Postmote in $INSTALL_DIR"
chmod 755 "$staged" || fail "Could not mark the staged app executable."
mv -f "$staged" "$target" || fail "Could not install Postmote to $target"
staged=''
ok "Installed to $target"

if version=$("$target" --version 2>/dev/null); then
  ok "Ready: $version"
else
  fail "The downloaded app did not start. The file was installed at $target."
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf '\n  Add it to your PATH:\n  %bexport PATH="%s:$PATH"%b\n' "$C_DIM" "$INSTALL_DIR" "$C_RESET" ;;
esac
printf '\n  Start your local dashboard with:  %bpostmote serve%b\n\n' "$C_GREEN" "$C_RESET"
