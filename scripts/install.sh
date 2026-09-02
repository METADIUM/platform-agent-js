#!/bin/sh
# metapass-agent 단일 바이너리 설치 (doc26 §2-6) — Node 설치 불필요.
#   curl -fsSL https://github.com/METADIUM/platform-agent-js/releases/latest/download/install.sh | sh
# 무결성(fail-closed): SHA256SUMS의 minisign 서명을 검증한 뒤에만 설치한다.
set -eu

REPO="METADIUM/platform-agent-js"
# ⚠ 릴리스 게이트: 첫 릴리스 전에 minisign 키쌍을 생성해 아래를 실제 공개키로 교체할 것.
#   생성: minisign -G  → 비밀키는 CI secret(MINISIGN_SECRET_KEY), 공개키는 여기+문서에 게시.
MINISIGN_PUB="__REPLACE_WITH_MINISIGN_PUBKEY__"

VERSION="${METAPASS_AGENT_VERSION:-$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)}"
[ -n "$VERSION" ] || { echo "오류: 최신 릴리스를 찾지 못했습니다"; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64) TARGET=linux-arm64 ;;
  *) echo "오류: 지원하지 않는 플랫폼 $(uname -s)-$(uname -m)"; exit 1 ;;
esac

case "$MINISIGN_PUB" in
  __REPLACE_*) echo "오류(fail-closed): 이 install.sh에 배포 공개키가 설정되지 않았습니다 — 서명 없는 채널로는 설치하지 않습니다"; exit 1 ;;
esac
command -v minisign >/dev/null || {
  echo "오류(fail-closed): minisign이 필요합니다 — brew install minisign / dnf·apt install minisign"; exit 1; }

BASE="https://github.com/$REPO/releases/download/$VERSION"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "↓ $VERSION ($TARGET)"
curl -fsSL "$BASE/metapass-agent-$TARGET" -o "$TMP/metapass-agent"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"
curl -fsSL "$BASE/SHA256SUMS.minisig" -o "$TMP/SHA256SUMS.minisig"

# 1) 체크섬 파일 서명 검증 → 2) 바이너리 체크섬 대조 (둘 다 통과해야 설치)
minisign -Vm "$TMP/SHA256SUMS" -P "$MINISIGN_PUB" -x "$TMP/SHA256SUMS.minisig" >/dev/null
EXPECTED="$(grep " metapass-agent-$TARGET\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)"
ACTUAL="$(shasum -a 256 "$TMP/metapass-agent" 2>/dev/null | cut -d' ' -f1 || sha256sum "$TMP/metapass-agent" | cut -d' ' -f1)"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "오류(fail-closed): 체크섬 불일치"; exit 1; }

DEST="${METAPASS_AGENT_BIN_DIR:-$HOME/.metapass-agent/bin}"
mkdir -p "$DEST"
install -m 0755 "$TMP/metapass-agent" "$DEST/metapass-agent"
echo "✅ 설치: $DEST/metapass-agent ($VERSION, 서명 검증됨)"
echo "다음:"
echo "  $DEST/metapass-agent add <RP_URL> --code <CODE>"
echo "  $DEST/metapass-agent up --install    # OS 데몬 등록(재부팅 자동 기동)"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "  (PATH 추가 권장: export PATH=\"\$PATH:$DEST\")" ;; esac
