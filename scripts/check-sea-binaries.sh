#!/usr/bin/env bash
# Checks the built SEA binaries in dist-bin/ (after `node scripts/build-sea.mjs --all`):
# `--version` on the host binary, called by full path and by name, and for all four targets the
# architecture, the embedded package version, the embedded Node (`.nvmrc`) and SHA256SUMS.
# Run by release-binaries.yml (on release) and sea-check.yml (on pull requests), from the repo root.
set -euo pipefail
expected=$(node -p "require('./package.json').version")

# 🔴 **레포 안에서 돌리면 안 된다.** `dist-bin/../package.json` 이 실재해서
#    박지 않아도 **파일 폴백이 성공**한다 — 게이트가 조용히 초록이 된다(개악으로 확인).
#    사용자의 조건(옆에 package.json 이 없다)을 만들어서 재야 한다.
probe=$(mktemp -d)
cp dist-bin/metapass-agent-darwin-arm64 "$probe/"
(cd "$probe" && ./metapass-agent-darwin-arm64 --version) > /tmp/sea-version.txt
actual=$(cat /tmp/sea-version.txt)
test "$actual" = "$expected" || {
  echo "🔴 바이너리가 말하는 판($actual)이 package.json($expected)과 다르다"; exit 1; }
echo "🟢 판 일치: v$actual"

# 🔴 **사용자 자리에서 한 번 더 부른다** — **경로 구분자 없이** + **bin 밖 cwd**.
#    ⚠️ 「이름으로 부르면 깨진다」가 아니다 — `cd <bin> && metapass-agent` 는 **산다**
#    (argv[1] 이 cwd 기준으로 풀려 우연히 일치). 실패는 **둘이 동시에** 성립할 때뿐이고,
#    아래가 그 둘을 동시에 만드는 유일한 형태다(metapass-saas 가 여섯 형태로 좁혔다).
#    v0.5.2 까지 이 경로가 **조용히 아무것도 안 했다**(진입 가드가 argv[1] 을 cwd
#    기준으로 풀었다). 못 잡은 이유는 우리 측정이 **전부 전체 경로**였기 때문이다.
#    ⇒ 위 검사(전체 경로)와 **다른 것을 잰다.** 둘 다 있어야 한다.
byname=$(mktemp -d)
cp dist-bin/metapass-agent-darwin-arm64 "$byname/metapass-agent"
elsewhere=$(mktemp -d)
got=$(cd "$elsewhere" && PATH="$byname:$PATH" metapass-agent --version)
test "$got" = "$expected" || {
  echo "🔴 PATH 로 **이름만** 불렀을 때 판이 안 나온다(받은 값: '$got')"
  echo "   진입 가드가 argv[1] 에 기대고 있다 — SEA 면 argv 와 무관하게 돌아야 한다."
  exit 1; }
echo "🟢 이름으로 호출해도 판을 말한다: $got"

# ── 층①: **4타깃 전수** · 실행 불필요 (metapass-saas 제안) ─────────────────
# 🔴 배포는 4타깃인데 위 실행 검사는 **1타깃**이다. `--define` 이 한 타깃에만
#    들어가는 개악은 위 검사로 초록이다. 아래는 실행 없이 넷을 다 잰다.
# ⚠️ 판 검사는 **따옴표를 포함한 고정문자열**이어야 한다. 실측으로 셋을 갈랐다:
#      정확행 `grep -x '0.5.2'`   판을 박아도 **0건** → 거짓 빨강
#                                 (번들에서 `return "0.5.2"` 로 접혀 독립된 줄이 아니다)
#      정규식 `grep '0.5.2'`      안 박은 바이너리에서 **8건** → 거짓 초록
#                                 (`.` 가 와일드카드라 base64 잡음에 맞는다)
#      `grep -F '"0.5.2"'`        박음 1 · 안 박음 0 (네 바이너리 대조) → 이것을 쓴다
# ⚠️ `file` 문자열은 추측하지 않고 v0.5.1 자산 헤더를 받아 **실측**했다:
#    darwin 은 `x86_64`, linux 는 `x86-64` 로 표기가 다르다.
fail=0
for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  bin="dist-bin/metapass-agent-$t"
  if [ ! -f "$bin" ]; then echo "🔴 $t: 자산이 없다"; fail=1; continue; fi
  desc=$(file -b "$bin")
  case "$t" in
    darwin-arm64) want="Mach-O 64-bit executable arm64" ;;
    darwin-x64)   want="Mach-O 64-bit executable x86_64" ;;
    linux-x64)    want="ELF 64-bit LSB executable, x86-64" ;;
    linux-arm64)  want="ELF 64-bit LSB executable, ARM aarch64" ;;
  esac
  case "$desc" in
    *"$want"*) : ;;
    *) echo "🔴 $t: 아키텍처가 이름과 다르다 — $desc"; fail=1 ;;
  esac
  n=$(strings -a "$bin" | grep -cF -- "\"$expected\"" || true)
  if [ "$n" -lt 1 ]; then echo "🔴 $t: 판 '$expected' 이 번들에 안 박혔다"; fail=1; fi
  # The embedded Node is the one .nvmrc names (0.11.3 binaries carried v22.23.2).
  nodev="v$(cat .nvmrc)"
  # Count, not `grep -q`: -q exits at the first match, `strings` dies of SIGPIPE, and pipefail
  # turns the match into a failure (red on three good binaries, measured).
  m=$(strings -a "$bin" | grep -cxF -- "$nodev" || true)
  if [ "$m" -lt 1 ]; then echo "🔴 $t: embedded Node is not $nodev"; fail=1; fi
  if ! grep -q "  metapass-agent-$t$" dist-bin/SHA256SUMS; then
    echo "🔴 $t: SHA256SUMS 에 없다"; fail=1; fi
done
[ "$fail" -eq 0 ] || { echo "🔴 층① 전수 검사 실패"; exit 1; }
echo "🟢 층① 4타깃 전수 통과 (아키텍처 · 박힌 판 · SHA256SUMS)"
