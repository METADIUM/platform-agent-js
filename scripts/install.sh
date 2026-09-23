#!/bin/sh
# metapass-agent 단일 바이너리 설치 (doc26 §2-6) — Node 설치 불필요.
#   curl -fsSL https://github.com/METADIUM/platform-agent-js/releases/latest/download/install.sh | sh
# 무결성(fail-closed): SHA256SUMS의 minisign 서명을 검증한 뒤에만 설치한다.
set -eu

REPO="METADIUM/platform-agent-js"

DEST="${METAPASS_AGENT_BIN_DIR:-$HOME/.metapass-agent/bin}"

# 🔴 **갈아끼우기인지 최초 설치인지를 여기서 정한다.** 종전에는 이 감지가 77행(설치 직전)에
#    있었고, 거부 문구는 그보다 앞이라 **이미 있는 파일을 못 봤다** — 갈아끼우다 멈춘 사람에게
#    「아무것도 설치되지 않았습니다」라고 **거짓**을 말했다(briefick 이 s249 에서 겪은 경우다:
#    0.4.x 가 깔린 상태에서 minisign 부재로 멈춤).
# ⚠️ 방향이 특히 나쁘다 — 그 사람은 **「최신으로 올렸다」고 믿는데 옛 판이 계속 돈다.**
#    「아무것도 안 됐다」는 **안심시키는 문장**이고, 여기서는 안심시키면 안 된다.
HAD_OLD=0; [ -e "$DEST/metapass-agent" ] && HAD_OLD=1

# 중단 시 **지금 상태**를 말한다 — 사용자마다 다르므로 한 자리에서만 만든다(사본 금지).
# 🔴 **함수명은 ASCII 여야 한다.** 한글 이름은 `bash` 에서는 되지만 **POSIX `sh` 가 거부**한다
#    (`설치상태: not a valid identifier`). 이 스크립트는 `curl … | sh` 로 실행되는 것이 정본이다.
# ⚠️ 그리고 `bash -n` 은 **통과했다** — 검사기와 실행기가 달라 못 잡았다(실측).
state_now() {   # 중단 시 «지금 상태» — 함수명은 **ASCII**여야 한다(아래 주석)
  if [ "$HAD_OLD" = 1 ]; then
    echo "  ⚠️ 판은 **안 바뀌었습니다** — \`$DEST/metapass-agent\` 에 **옛 판이 그대로** 있고,"
    echo "     상주 데몬을 돌리고 있었다면 **옛 판으로 계속 돕니다.** 올린 것이 아닙니다."
  else
    echo "  ⚠️ **아무것도 설치되지 않았습니다** — \`$DEST/metapass-agent\` 는 만들어지지 않았습니다."
    echo "     이 뒤에 그 명령이 \`command not found\` 로 죽으면 **경로 문제가 아니라 설치가 안 된 것**입니다."
  fi
}

# 🟢 **실제 배포 공개키다**(placeholder 아님) — v0.4.0 이후 모든 릴리스의 `SHA256SUMS.minisig`
#    가 이 키로 검증된다. 비밀키는 CI secret(`MINISIGN_SECRET_KEY`)에만 있다.
# ⚠️ 종전에 여기 「첫 릴리스 전에 실제 공개키로 교체할 것」이 **세 판째 남아 있었다.**
#    자기 완료를 지시하는 문장이 완료 뒤에도 남으면, 읽는 사람이 **「검증이 아직 가짜」로 오독**하고
#    fail-closed 를 우회할 **명분**을 얻는다(metapass-saas 지적).
# 📌 이 키는 `minisign.pub` · `README.md` 에도 게시된다 — **신뢰의 뿌리는 검증 대상 밖**에 있어야
#    한다. 릴리스만 받은 사람이 대조할 곳이 릴리스 안뿐이면 자산 손상만 막고 위조는 못 막는다.
MINISIGN_PUB="RWT8kUm/J8uyqoOFON5wRNBUCOUtn4+nX0YeyYMItdo2J6iVNYd4uUAX"

# 비공개 레포 지원: gh CLI(인증)가 있으면 그것으로, 없으면 익명 curl(공개 레포 전용).
if command -v gh >/dev/null 2>&1; then
  FETCH=gh
  VERSION="${METAPASS_AGENT_VERSION:-$(gh release view -R "$REPO" --json tagName -q .tagName)}"
else
  FETCH=curl
  VERSION="${METAPASS_AGENT_VERSION:-$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)}"
fi
[ -n "$VERSION" ] || { echo "오류: 최신 릴리스를 찾지 못했습니다 (비공개 레포는 gh CLI 로그인 필요: gh auth login)"; state_now; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64) TARGET=linux-arm64 ;;
  *) echo "오류: 지원하지 않는 플랫폼 $(uname -s)-$(uname -m)"; state_now; exit 1 ;;
esac

case "$MINISIGN_PUB" in
  __REPLACE_*) echo "오류(fail-closed): 이 install.sh에 배포 공개키가 설정되지 않았습니다 — 서명 없는 채널로는 설치하지 않습니다"; state_now; exit 1 ;;
esac
# 🔴 **거부는 맞는데 하는 말이 반쪽이었다**(briefick, s249 실사용). 종전 문구는 «설치 방법» 만
#    알려 주고 **왜 필요한지**를 안 말해서, 처음 보는 사람이 「의존성이 하나 더 있네」로 읽고
#    **서명 검증을 건너뛰는 우회로**(바이너리를 직접 받아 복사)를 찾을 수 있었다.
#    ⇒ 무엇을 위한 것인지 · 없이 설치하면 무엇을 잃는지를 같이 말한다.
# 🔵 **거부 문구가 이 값을 쓰므로 여기서 먼저 정한다.** 아래로 두면 `set -eu` 에서
#    `DEST: unbound variable` 로 죽어 **안내 대신 셸 오류**가 나간다(실측).

command -v minisign >/dev/null || {
  echo "오류(fail-closed): minisign이 없습니다."
  echo "  이 스크립트는 SHA256SUMS의 **서명**을 검증한 뒤에만 설치합니다 — minisign은 그 검증에 씁니다."
  echo "  건너뛰고 바이너리를 직접 받아 복사하면 **서명 없는 채널**이 됩니다(체크섬만으로는"
  echo "  배포물이 바뀌었는지 알 수 없습니다 — 체크섬 파일도 같이 바뀔 수 있습니다)."
  echo "  설치: brew install minisign  /  apt install minisign  /  dnf install minisign"
  state_now
  exit 1; }

BASE="https://github.com/$REPO/releases/download/$VERSION"
# 🔴 **`trap` 은 같은 신호에 누적이 아니라 교체다.** 종전에는 여기서 `$TMP` 를 걸고
#    아래(설치 직전)에서 `_staged` 를 또 걸어 **이 줄이 통째로 덮였다** — 설치 한 번마다
#    `$TMP` 가 통째로 남았고 그 안에 바이너리 **119MB** 가 들어 있다(briefick 실측).
#    ⚠️ 이 스크립트는 **다시 실행하도록 안내되는** 것이라(갈아끼우기·복구) **누적된다.**
#    `/tmp` 가 tmpfs 면 메모리다.
# 📌 「중단 시 상태를 말한다」를 넣으면서 **정상 종료의 뒷정리를 잃었다** — 새 안전장치가
#    있던 것을 지웠다. ⇒ 치울 것을 **한 함수**로 모으고 `trap` 은 **한 번만** 건다.
# ⚠️ macOS `sh`·`bash`·`zsh`, linux `sh`·`bash`·`dash` 전부 교체다(양쪽 실측).
_staged=""
TMP="$(mktemp -d)"
_cleanup() { rm -rf "$TMP"; [ -n "$_staged" ] && rm -f "$_staged"; return 0; }
trap _cleanup EXIT
trap '_cleanup; exit 130' INT
trap '_cleanup; exit 143' TERM
# 🔴 **두 갈래 중 `gh` 쪽에만 실패 핸들러가 없었다.** `set -e` 로 죽기는 하는데
#    `state_now` 가 **안 돌아** 사용자는 한 줄짜리 원인만 보고 **「지금 어떤 상태인가」를 못 받는다**.
# ⚠️ 이 결함이 실제로 났다(2026-09-23): `v0.5.3` 을 자른 직후 GitHub 의 **읽기 캐시 불일치**로
#    `releases/tags/v0.5.3` 이 자산 0 을 돌려줬고(`by-id`·`latest` 는 7), `gh release download` 가
#    *"no assets to download"* 만 찍고 끝났다. 자산은 **있는데** 그 경로만 못 본 것이다.
# 📌 왜 `#10` 에서 못 잡았나 — 실패를 **두 번** 주입했는데 **`FETCH` 열이 하나**였다
#    (minisign 부재 = fetch 이전 · curl 실패 = curl 갈래). **행은 둘인데 열이 하나**였다
#    (metapass-saas 자기 진단). ⇒ 갈래가 둘이면 **갈래마다** 실패를 넣어 본다.
fetch() {
  if [ "$FETCH" = gh ]; then
    gh release download "$VERSION" -R "$REPO" -p "$1" -O "$2" --clobber || {
      echo "오류: $1 을 $VERSION 에서 받지 못했습니다."
      echo "  gh 로 받는 중입니다 — 로그인(\`gh auth login\`)과 그 릴리스에 **자산이 있는지**를 보십시오:"
      echo "    gh release view $VERSION -R $REPO"
      echo "  ⚠️ 자산이 있는데도 «no assets to download» 가 나오면 GitHub 쪽 목록이 **일시적으로"
      echo "     낡은** 것일 수 있습니다. 그때는 판을 고정해 우회합니다:"
      echo "    METAPASS_AGENT_VERSION=<이전 태그> sh install.sh"
      state_now
      exit 1
    }
  else
    curl -fsSL "$BASE/$1" -o "$2" || {
      echo "오류: $1 다운로드 실패 — 비공개 레포면 gh CLI 설치·로그인 후 재실행"
      state_now
      exit 1
    }
  fi
}
echo "↓ $VERSION ($TARGET, via $FETCH)"
fetch "metapass-agent-$TARGET" "$TMP/metapass-agent"
fetch "SHA256SUMS" "$TMP/SHA256SUMS"
fetch "SHA256SUMS.minisig" "$TMP/SHA256SUMS.minisig"

# 1) 체크섬 파일 서명 검증 → 2) 바이너리 체크섬 대조 (둘 다 통과해야 설치)
minisign -Vm "$TMP/SHA256SUMS" -P "$MINISIGN_PUB" -x "$TMP/SHA256SUMS.minisig" >/dev/null
EXPECTED="$(grep " metapass-agent-$TARGET\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)"
ACTUAL="$(shasum -a 256 "$TMP/metapass-agent" 2>/dev/null | cut -d' ' -f1 || sha256sum "$TMP/metapass-agent" | cut -d' ' -f1)"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "오류(fail-closed): 체크섬 불일치"; state_now; exit 1; }

mkdir -p "$DEST"
# 🔴 **덮어쓰다 죽으면 옛 판이 깨진다** — 그러면 「최신도 아니고 옛 판도 아닌」 상태가 남는다.
#    briefick 이 linux 에서 실측: `ulimit -f` 로 중간에 끊으니 대상이 27B → 1,048,576B 가 됐다.
# ⚠️ 플랫폼에 따라 다르다(제 실측):
#      BSD install(macOS)  임시 파일에 쓰고 rename — 대상은 **무사**하나 **잔재가 남는다**
#      직접 쓰기(GNU 계열)  대상을 잘라 쓰므로 **깨진다**
#    ⇒ `install` 의 구현에 기대지 않는다. **같은 디렉터리 임시 이름 → `mv`** 로 못박는다.
#      같은 파일시스템이라 `mv` 는 `rename(2)` 이고 **원자적**이다 — 성공 아니면 옛 판 그대로다.
# ⚠️ **변수·함수 이름은 ASCII 여야 한다.** 한글 이름은 POSIX `sh` 가 거부하는데
#    `sh -n` 은 **통과시킨다**(문법상 유효한 명령 호출로 읽힌다). 실행해야 잡힌다.
_staged="$DEST/.metapass-agent.new.$$"   # 위 `_cleanup` 이 치운다 — 여기서 trap 을 다시 걸지 않는다
install -m 0755 "$TMP/metapass-agent" "$_staged"
mv -f "$_staged" "$DEST/metapass-agent"
echo "✅ 설치: $DEST/metapass-agent ($VERSION, 서명 검증됨)"
if [ "$HAD_OLD" = 1 ]; then
  cat <<'NOTE'
  ⚠️ 상주 데몬을 돌리고 있었다면 launchctl/systemctl 에
     last exit reason = OS_REASON_CODESIGNING 이 보일 수 있습니다 — **정상입니다.**
     돌던 옛 프로세스를 OS 가 정리한 기록이고 KeepAlive 가 곧바로 되살립니다.
     판정은 그 줄이 아니라 **state = running · 포트 LISTEN** 으로 하십시오.
NOTE
fi
echo "다음:"
echo "  $DEST/metapass-agent add <RP_URL> --code <CODE>"
echo "  $DEST/metapass-agent up --install    # OS 데몬 등록(최초 1회 · 재부팅 자동 기동)"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "  (PATH 추가 권장: export PATH=\"\$PATH:$DEST\")" ;; esac
