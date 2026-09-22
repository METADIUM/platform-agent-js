#!/usr/bin/env node
/**
 * SEA(단일 실행 파일) 빌드 — doc26 §2-6. 재작성 없이 기존 코드를 공식 node 바이너리에 주입.
 *
 *   node scripts/build-sea.mjs                 # 현재 플랫폼용 1개 (로컬 스모크)
 *   node scripts/build-sea.mjs --all           # 4타깃 (CI — 타깃 node 바이너리 다운로드)
 *
 * 절차: esbuild로 dist/cli.js를 단일 CJS 번들 → sea-prep.blob 생성(useCodeCache=false —
 * 교차 타깃 주입 가능) → node 바이너리 복사 후 postject 주입 → (darwin) ad-hoc 재서명.
 * 산출물: dist-bin/metapass-agent-<plat>-<arch>[.tar.gz] + SHA256SUMS
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "dist-bin");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
}

// 1) 단일 CJS 번들 (SEA main은 CommonJS 단일 파일이어야 함)
mkdirSync(OUT, { recursive: true });
// 🔴 **판을 번들에 박는다.** SEA 에는 읽을 package.json 이 없어 `--version` 이 exit 1 로
//    «판을 읽지 못했다» 를 냈다(v0.5.1 실측). npx 사용자는 명령의 핀으로 아는데 설치형
//    사용자는 **재설치 말고는 확인할 방법이 없었다** — 거기가 `--version` 이 가장 필요한 자리다.
// ⚠️ 여기 박는 값과 package.json 이 갈리면 바이너리가 **거짓 판**을 말한다. 아래 esbuild 는
//    같은 `version` 변수를 쓰고, CI 는 빌드 뒤 `--version` 을 실제로 돌려 대조한다(release-binaries.yml).
run("npx", ["esbuild", "src/cli.ts", "--bundle", "--platform=node", "--format=cjs",
  "--outfile=dist-bin/sea-bundle.cjs", "--define:import.meta.url=__sea_meta_url",
  `--define:__AGENT_VERSION__=${JSON.stringify(version)}`,
  "--banner:js=const __sea_meta_url = require('url').pathToFileURL(__filename).href;"]);

// 2) SEA blob (교차 주입 가능: useCodeCache/useSnapshot 비활성)
writeFileSync(join(OUT, "sea-config.json"), JSON.stringify({
  main: "dist-bin/sea-bundle.cjs",
  output: "dist-bin/sea-prep.blob",
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
}));
run(process.execPath, ["--experimental-sea-config", "dist-bin/sea-config.json"]);
const blob = join(OUT, "sea-prep.blob");

const HOST = `${process.platform}-${process.arch}`;
const TARGETS = process.argv.includes("--all")
  ? ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]
  : [HOST];

const sums = [];
for (const target of TARGETS) {
  const [plat, arch] = target.split("-");
  const name = `metapass-agent-${target}`;
  const bin = join(OUT, name);
  rmSync(bin, { force: true });

  // 타깃 node 바이너리 확보 — 호스트 타깃은 자기 자신, 그 외는 공식 배포판 다운로드
  if (target === HOST) {
    copyFileSync(process.execPath, bin);
  } else {
    const nodeVer = process.version; // 개발 node와 동일 버전 고정
    const ext = "tar.gz";
    const dist = `node-${nodeVer}-${target}`;
    const url = `https://nodejs.org/dist/${nodeVer}/${dist}.${ext}`;
    console.log(`↓ ${url}`);
    run("bash", ["-c", `curl -fsSL ${url} | tar -xz -C "${OUT}" ${dist}/bin/node && mv "${OUT}/${dist}/bin/node" "${bin}" && rm -rf "${OUT}/${dist}"`]);
  }
  chmodSync(bin, 0o755);
  if (plat === "darwin") run("codesign", ["--remove-signature", bin]);
  run("npx", ["postject", bin, "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(plat === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])]);
  if (plat === "darwin") run("codesign", ["-s", "-", bin]); // ad-hoc 재서명(주입 후 필수)

  const sha = createHash("sha256").update(readFileSync(bin)).digest("hex");
  sums.push(`${sha}  ${name}`);
  console.log(`✅ ${name} (${(readFileSync(bin).length / 1e6).toFixed(0)}MB)`);
}
writeFileSync(join(OUT, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(`\nSHA256SUMS 작성 — v${version}. 릴리스 서명(P2 게이트): minisign -Sm dist-bin/SHA256SUMS`);
