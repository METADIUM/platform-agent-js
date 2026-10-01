#!/bin/sh
# metapass-agent single-binary install (doc26 §2-6) — no Node required.
#   curl -fsSL https://github.com/METADIUM/platform-agent-js/releases/latest/download/install.sh | sh
# Integrity (fail-closed): installs only after minisign verifies the signature over SHA256SUMS.
set -eu

REPO="METADIUM/platform-agent-js"

DEST="${METAPASS_AGENT_BIN_DIR:-$HOME/.metapass-agent/bin}"

# 🔴 **Decide here whether this is a replacement or a first install.** This detection used to live
#    at line 77, just before the install, while the refusal messages came earlier — so they could
#    not see a file that was already there, and told someone whose upgrade had stopped that
#    "nothing was installed", which was FALSE. (briefick hit this in s249: 0.4.x installed,
#    stopped on a missing minisign.)
# ⚠️ The direction is what makes it bad — that person believes they are on the latest version
#    while the old one keeps running. "Nothing happened" is a REASSURING sentence, and this is not
#    a place to reassure.
HAD_OLD=0; [ -e "$DEST/metapass-agent" ] && HAD_OLD=1

# On abort, say what the state IS. It differs per user, so it is built in one place only — no copies.
# 🔴 **The function name must be ASCII.** A non-ASCII name works in `bash` but POSIX `sh` REFUSES
#    it (`설치상태: not a valid identifier`), and `curl … | sh` is the canonical way to run this.
# ⚠️ `bash -n` PASSED it — the checker and the runtime were different programs, so it went unseen.
state_now() {
  if [ "$HAD_OLD" = 1 ]; then
    echo "  ⚠️ The version did NOT change — \`$DEST/metapass-agent\` still holds the OLD binary,"
    echo "     and if you were running the daemon it KEEPS RUNNING the old one. Nothing was upgraded."
  else
    echo "  ⚠️ NOTHING was installed — \`$DEST/metapass-agent\` was not created."
    echo "     If that command now fails with \`command not found\`, it is not a PATH problem:"
    echo "     the install did not happen."
  fi
}

# 🟢 **This is the real release public key** (not a placeholder) — every release since v0.4.0 has
#    its `SHA256SUMS.minisig` verified with it. The secret key exists only as a CI secret
#    (`MINISIGN_SECRET_KEY`).
# ⚠️ A note saying "replace with the real public key before the first release" survived here for
#    THREE releases. An instruction to complete something, left in place after it is complete,
#    reads as "verification is still fake" and hands the reader a REASON to bypass fail-closed
#    (raised by metapass-saas).
# 📌 The key is also published in `minisign.pub` and `README.md` — **the root of trust has to live
#    outside the thing being verified.** If the only place to compare it against is inside the
#    release, this stops corruption but not forgery.
MINISIGN_PUB="RWT8kUm/J8uyqoOFON5wRNBUCOUtn4+nX0YeyYMItdo2J6iVNYd4uUAX"

# 🔴 **The tag lookup path is not used** (measured 2026-09-23). `releases/tags/<tag>` returned a
#    DIFFERENT asset list per replica — at the same moment, 4 of 30 calls saw 7 assets and the rest
#    saw 0. `gh release view` and `gh release download` use that path, so installs failed ~87% of
#    the time.
#    ⚠️ The assets WERE there (re-upload returned `422 already exists`). Reads diverged, not writes.
# 🟢 Only the three paths confirmed stable are used (10/10 agreement each):
# ```
# releases/latest        10/10   ← when no version is pinned
# releases (list) → id   10/10   ← tag to id, when a version is pinned
# releases/<id>/assets   10/10   ← asset list and download URLs
# ```
# ⇒ **Assets are found by release id, never by tag.**
# Private-repo support: use the gh CLI (authenticated) when present, else anonymous curl
# (public repos only).
# Pull one value out of the release JSON — via `python3` when available, otherwise nothing.
_json_pick() {   # $1 = python expression over `d` (the parsed value) · stdin = JSON
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys,os;d=json.load(sys.stdin);print($1)" 2>/dev/null
  else
    cat >/dev/null; echo ""
  fi
}

# Private-repo support: gh CLI (authenticated) when present, else anonymous curl (public only).
if command -v gh >/dev/null 2>&1; then
  FETCH=gh
  if [ -n "${METAPASS_AGENT_VERSION:-}" ]; then
    VERSION="$METAPASS_AGENT_VERSION"
    REL_ID="$(gh api "repos/$REPO/releases" --paginate \
              --jq ".[]|select(.tag_name==\"$VERSION\")|.id" 2>/dev/null | head -1)"
  else
    _rel="$(gh api "repos/$REPO/releases/latest" 2>/dev/null)"
    REL_ID="$(printf '%s' "$_rel" | _json_pick "d['id']")"
    VERSION="$(printf '%s' "$_rel" | _json_pick "d['tag_name']")"
  fi
else
  FETCH=curl
  # 🔴 **Say it HERE, first.** Without python3, `REL_ID` used to come back quietly empty and the
  #    run died on *"could not find the release id"* — which made a missing python3 and a
  #    mistyped tag INDISTINGUISHABLE (metapass-saas). Refuse up front, the same shape as the
  #    minisign check below.
  command -v python3 >/dev/null 2>&1 || {
    echo "Error: python3 is not installed."
    echo "  There is no gh CLI, so this is falling back to anonymous curl, and that path needs"
    echo "  python3 to read the release JSON."
    echo "  ⇒ Install and log in to the **gh CLI** (recommended - it also works for private repos),"
    echo "     or install python3."
    state_now
    exit 1
  }
  # 🔴 **This branch had no failure handler either.** The `gh` branch was fixed and this one was
  #    left out (= the OTHER COLUMN of the same defect `#10` had pointed at), so `set -e` simply
  #    died on curl's status (56, 22) and the user saw the raw curl error with NO `state_now`
  #    (measured: exit=56, 0 lines of guidance).
  #    ⚠️ A failing command substitution dies BEFORE reaching the `[ -n "$VERSION" ]` guard — so
  #    having the guard does not help.
  _api() {   # $1 = path · on failure, speak here and stop
    curl -fsSL "https://api.github.com/repos/$REPO/$1" || {
      # 🔴 **Write to stderr.** This function is called inside a command substitution, as in
      #    `REL_ID="$(_api …)"` — anything on stdout is SWALLOWED BY THE VARIABLE and the user
      #    sees none of it (measured: only curl's own error appeared, all 3 guidance lines gone).
      #    ⚠️ For the same reason `exit 1` ends only the SUBSHELL; the outer script stops because
      #    `set -e` sees the substitution's status.
      { echo "Error: could not read the GitHub API ($1, anonymous curl)."
        echo "  **A private repo returns 404 to anonymous access.** ⇒ Install the gh CLI and log in:"
        echo "     gh auth login"
        state_now
      } >&2
      exit 1
    }
  }
  if [ -n "${METAPASS_AGENT_VERSION:-}" ]; then
    VERSION="$METAPASS_AGENT_VERSION"
    REL_ID="$(_api releases | TAG="$VERSION" _json_pick "next((r['id'] for r in d if r['tag_name']==os.environ['TAG']),'')")"
  else
    _rel="$(_api releases/latest)"
    REL_ID="$(printf '%s' "$_rel" | _json_pick "d['id']")"
    VERSION="$(printf '%s' "$_rel" | _json_pick "d['tag_name']")"
  fi
fi
[ -n "$VERSION" ] || { echo "Error: could not find the latest release (a private repo needs a gh CLI login: gh auth login)"; state_now; exit 1; }
[ -n "${REL_ID:-}" ] || {
  echo "Error: could not find the id of release \`$VERSION\`."
  echo "  Check that the tag exists: gh release view $VERSION -R $REPO"
  state_now; exit 1; }

# 🔴 **Do not trust the id — check it** (metapass-saas). The response the id came from was the very
#    response whose asset list was wrong, so trusting its other fields is an uncomfortable call.
#    ⚠️ And a wrong id installs the WRONG RELEASE SILENTLY — it passes as long as the asset names
#    match.
#    ⇒ Look the id up again and compare `tag_name` against the version we chose.
if [ "$FETCH" = gh ]; then
  _tag_check="$(gh api "repos/$REPO/releases/$REL_ID" --jq .tag_name 2>/dev/null)"
else
  _tag_check="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/$REL_ID" | _json_pick "d['tag_name']" || true)"
fi
[ "$_tag_check" = "$VERSION" ] || {
  echo "Error: the release id points at a different version."
  echo "  chosen: $VERSION · what id $REL_ID points at: ${_tag_check:-(could not read)}"
  echo "  ⇒ This was about to install the wrong release. Check the tag and run again."
  state_now
  exit 1
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64) TARGET=linux-arm64 ;;
  *) echo "Error: unsupported platform $(uname -s)-$(uname -m)"; state_now; exit 1 ;;
esac

case "$MINISIGN_PUB" in
  __REPLACE_*) echo "Error (fail-closed): this install.sh has no release public key configured - refusing to install over an unsigned channel"; state_now; exit 1 ;;
esac
# 🔴 **The refusal was right but only said half of it** (briefick, real use in s249). The old text
#    gave only the INSTALL COMMAND and never said WHY it is needed, so a first-time reader took it
#    for "one more dependency" and could go looking for a way around it — downloading the binary
#    directly, which skips signature verification entirely.
#    ⇒ Say what it is for, and what is lost by installing without it.
# 🔵 **The refusal text uses $DEST, so it is set above.** Defining it below this point makes
#    `set -eu` die with `DEST: unbound variable`, and the user gets a SHELL ERROR instead of
#    guidance (measured).

command -v minisign >/dev/null || {
  echo "Error (fail-closed): minisign is not installed."
  echo "  This script installs only after verifying the **signature** over SHA256SUMS, and"
  echo "  minisign is what performs that verification."
  echo "  Skipping it and copying the binary in by hand makes this an **unsigned channel**: a"
  echo "  checksum alone cannot tell you the release was changed, because the checksum file can"
  echo "  be changed with it."
  echo "  Install: brew install minisign  /  apt install minisign  /  dnf install minisign"
  state_now
  exit 1; }

BASE="https://github.com/$REPO/releases/download/$VERSION"
# 🔴 **`trap` REPLACES a handler for the same signal, it does not accumulate.** `$TMP` used to be
#    registered here and `_staged` registered again further down, which overwrote this line
#    wholesale — so every install left `$TMP` behind, with a 119MB binary inside it
#    (measured by briefick).
#    ⚠️ This script is one users are TOLD TO RE-RUN (upgrades, recovery), so it ACCUMULATES.
#    Where `/tmp` is tmpfs, that is memory.
# 📌 The cleanup was lost while ADDING "say what the state is" — a new safeguard deleted an
#    existing one. ⇒ Everything to clean up lives in ONE function and `trap` is set ONCE.
# ⚠️ Replacement is the behaviour on macOS `sh`/`bash`/`zsh` and linux `sh`/`bash`/`dash`
#    (measured on both).
_staged=""
TMP="$(mktemp -d)"
_cleanup() { rm -rf "$TMP"; [ -n "$_staged" ] && rm -f "$_staged"; return 0; }
trap _cleanup EXIT
trap '_cleanup; exit 130' INT
trap '_cleanup; exit 143' TERM
# 🔴 **Of the two branches, only `gh` had no failure handler.** `set -e` does stop the run, but
#    `state_now` never runs, so the user gets a one-line cause and NOT "what state am I in now".
# ⚠️ This actually happened (2026-09-23): right after cutting `v0.5.3`, a GitHub READ CACHE
#    INCONSISTENCY made `releases/tags/v0.5.3` return 0 assets (while `by-id` and `latest` returned
#    7), and `gh release download` printed *"no assets to download"* and stopped. The assets EXISTED
#    — only that path could not see them.
# 📌 Why `#10` did not catch it — failure was injected TWICE but only in ONE `FETCH` column
#    (missing minisign = before fetch · curl failure = curl branch). TWO ROWS, ONE COLUMN
#    (metapass-saas, diagnosing their own review). ⇒ When there are two branches, inject a failure
#    in EACH branch.
# Fetch one asset. $1 = asset name · $2 = destination path
# 🔴 **The tag path (`gh release download`) is not used** — that is the unstable place described
#    above. The asset URL is obtained by release id and fetched directly.
fetch() {
  _name="$1"; _dest="$2"; _u=""
  if [ "$FETCH" = gh ]; then
    _u="$(gh api "repos/$REPO/releases/$REL_ID/assets" \
          --jq ".[]|select(.name==\"$_name\")|.url" 2>/dev/null | head -1)"
    [ -n "$_u" ] && gh api "$_u" -H "Accept: application/octet-stream" > "$_dest" 2>/dev/null
  else
    ASSET_NAME="$_name"; export ASSET_NAME
    _u="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/$REL_ID/assets" \
          | _json_pick "next((a['url'] for a in d if a['name']==os.environ['ASSET_NAME']),'')")"
    [ -n "$_u" ] && curl -fsSL -H "Accept: application/octet-stream" "$_u" -o "$_dest"
  fi || {
    echo "Error: could not fetch $_name from $VERSION."
    if [ "$FETCH" = gh ]; then
      echo "  Fetching via gh - check your login (\`gh auth login\`) and whether that release"
      echo "  **has the assets**:"
      echo "    gh api repos/$REPO/releases/$REL_ID/assets --jq '.[].name'"
    else
      echo "  Fetching via anonymous curl - **a private repo cannot be read this way.**"
      echo "  Install the gh CLI and log in."
    fi
    echo "  ⚠️ If the assets are clearly there and it still fails, pin the version to work around it:"
    echo "    METAPASS_AGENT_VERSION=<previous tag> sh install.sh"
    state_now
    exit 1
  }
  [ -s "$_dest" ] || {
    echo "Error: $_name was fetched but is **empty**."
    state_now
    exit 1
  }
}
echo "↓ $VERSION ($TARGET, via $FETCH)"
fetch "metapass-agent-$TARGET" "$TMP/metapass-agent"
fetch "SHA256SUMS" "$TMP/SHA256SUMS"
fetch "SHA256SUMS.minisig" "$TMP/SHA256SUMS.minisig"

# 1) verify the signature over the checksum file → 2) compare the binary's checksum.
#    Both must pass before anything is installed.
minisign -Vm "$TMP/SHA256SUMS" -P "$MINISIGN_PUB" -x "$TMP/SHA256SUMS.minisig" >/dev/null
# 🔴 **In `a | b || c`, the `||` looks at the PIPELINE's status (that is, `b`'s), not `a`'s.**
#    The old one-liner: `shasum -a 256 f 2>/dev/null | cut -d' ' -f1 || sha256sum f | cut -d' ' -f1`
#    Where `shasum` is ABSENT the left side produces nothing, `cut` SUCCEEDS (0) on empty input,
#    and the fallback after `||` NEVER RUNS. `ACTUAL` becomes the empty string and the comparison
#    fails.
#    ⚠️ And the message it then printed was **"checksum mismatch"** — so **"there is no hashing
#    tool" and "the binary you received was altered" were the same screen.** For an integrity
#    check, that is the worst possible failure mode.
#    Measured 2026-09-28, Rocky Linux 10.2: no `shasum`, `sha256sum` present → installs failed 100%.
#    📌 No test ever ran this line — there was no test that ran install.sh at all.
# sha256_of FILE — hash to stdout. If no tool is available, SAY SO and stop.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    { echo "Error: no tool available to compute SHA-256 (neither \`sha256sum\` nor \`shasum\`)."
      echo "  This is **not an integrity failure** - the check could not be PERFORMED."
      echo "  ⇒ Install coreutils:  dnf install -y coreutils   (or apt install coreutils)"
    } >&2
    return 1
  fi
}

EXPECTED="$(grep " metapass-agent-$TARGET\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)"
# 🔴 The same shape, one line up: if `grep` finds nothing, `EXPECTED` is empty and the comparison
#    below still reports **"checksum mismatch"** — indistinguishable from "this platform's line is
#    not in SHA256SUMS".
[ -n "$EXPECTED" ] || {
  echo "Error: SHA256SUMS has no \`metapass-agent-$TARGET\` line."
  echo "  Either the release you fetched ($VERSION) does not ship this platform, or its assets"
  echo "  were uploaded wrongly."
  echo "  What it does contain:"; sed 's/^/    /' "$TMP/SHA256SUMS"
  state_now; exit 1; }

ACTUAL="$(sha256_of "$TMP/metapass-agent")" || { state_now; exit 1; }
[ "$EXPECTED" = "$ACTUAL" ] || {
  echo "Error (fail-closed): checksum mismatch"
  echo "  expected: $EXPECTED"
  echo "  actual:   $ACTUAL"
  state_now; exit 1; }

mkdir -p "$DEST"
# 🔴 **Dying partway through an overwrite BREAKS the old version** — leaving a state that is
#    neither the new one nor the old one. briefick measured this on linux: interrupting with
#    `ulimit -f` took the target from 27B to 1,048,576B.
# ⚠️ It differs by platform (measured here):
#      BSD install (macOS)   writes a temp file and renames — the target SURVIVES but LEAVES DEBRIS
#      direct write (GNU)    truncates the target, so it BREAKS
#    ⇒ Do not depend on `install`'s implementation. Pin it down: **temp name in the same directory,
#      then `mv`.** Same filesystem, so `mv` is `rename(2)` and ATOMIC — either it succeeds or the
#      old version is untouched.
# ⚠️ **Variable and function names must be ASCII.** POSIX `sh` refuses non-ASCII names, but
#    `sh -n` PASSES them (they read as a syntactically valid command invocation). Only running
#    catches it.
_staged="$DEST/.metapass-agent.new.$$"   # `_cleanup` above removes it — do not set another trap here
install -m 0755 "$TMP/metapass-agent" "$_staged"
mv -f "$_staged" "$DEST/metapass-agent"
echo "✅ Installed: $DEST/metapass-agent ($VERSION, signature verified)"
# ⚠️ Platform-specific. `OS_REASON_CODESIGNING` and `KeepAlive` are **launchd** words; printing
#    them on Linux warns about something that cannot happen there and names a mechanism systemd
#    does not have (`[Briefick]`, after installing on pmvm-02). Each platform gets its own note.
if [ "$HAD_OLD" = 1 ]; then
  case "$TARGET" in
    darwin-*)
      cat <<'NOTE'
  ⚠️ If you were running the daemon, launchctl may show
     last exit reason = OS_REASON_CODESIGNING — **this is normal.**
     It records the OS cleaning up the old running process, and KeepAlive restarts it immediately.
     Judge by **state = running and the port LISTENing**, not by that line.
NOTE
      ;;
    linux-*)
      cat <<'NOTE'
  ⚠️ Replacing the binary does not restart a running service by itself.
     Run `metapass-agent up --install` to pick it up — from 0.5.9 that restarts the unit.
     Check with: systemctl --user status metapass-agent-proxy.service
NOTE
      ;;
  esac
fi
echo "Next:"
echo "  $DEST/metapass-agent add <RP_URL> --code <CODE>"
echo "  $DEST/metapass-agent up --install    # register the OS daemon (once; starts on reboot)"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "  (recommended, add to PATH: export PATH=\"\$PATH:$DEST\")" ;; esac
