/**
 * OS 데몬화(doc26 §2-3) — `up --install` / `down --uninstall` / `upgrade`.
 *
 * | OS | 방식 |
 * | macOS | ~/Library/LaunchAgents/io.metapass.agent-proxy.plist (RunAtLoad+KeepAlive) |
 * | Ubuntu/RHEL·Rocky | ~/.config/systemd/user/metapass-agent-proxy.service + loginctl enable-linger |
 *
 * 실행 라인은 **절대경로만** 사용(로그인 셸 PATH 비의존): SEA 바이너리면 그 경로 하나,
 * npm 실행이면 `<node 절대경로> <cli 절대경로> up`. **비밀은 유닛에 싣지 않는다** — 토큰·키는
 * 데몬이 런타임에 0600 파일에서 읽는다.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const LAUNCHD_LABEL = "io.metapass.agent-proxy";
const SYSTEMD_UNIT = "metapass-agent-proxy.service";

export interface InstallResult {
  kind: "launchd" | "systemd";
  unitPath: string;
  notes: string[];
}

/** SEA 바이너리로 실행 중인지 — 맞으면 execPath 하나가 곧 실행 라인. */
function isSeaBinary(): boolean {
  try {
    // Node 20+ 내장 모듈 — SEA 밖에서도 로드되며 isSea()가 false를 반환
    const sea = require("node:sea") as { isSea?: () => boolean };
    return typeof sea.isSea === "function" && sea.isSea();
  } catch {
    return false;
  }
}

/** 유닛 실행 라인(절대경로) — [프로그램, ...인자]. */
export function execLine(): { args: string[]; volatile: boolean } {
  if (isSeaBinary()) {
    return { args: [process.execPath, "up"], volatile: false };
  }
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  // npx 캐시 경로는 정리될 수 있어 재부팅 후 유닛이 깨질 수 있다 — 경고 대상
  const volatile = cli.includes("_npx") || cli.includes(".npm");
  return { args: [process.execPath, cli, "up"], volatile };
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

/** 실패해도 조용히 무시하는 실행(사전 정리용) — stderr를 터미널에 흘리지 않는다. */
function runQuiet(cmd: string, args: string[]): void {
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
  } catch {
    // 무시 (예: 미로드 상태 bootout)
  }
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The systemctl calls that make a freshly written unit file the running process.
 *
 * 🔴 `restart`, not `enable --now`. `--now` starts a unit that is **stopped** and does nothing
 * to one that is already running — so replacing the binary and re-running `up --install` left the
 * OLD process serving, silently. Measured on pmvm-02 (2026-10-01, `[Briefick]`): after installing
 * 0.5.8 the journal showed only "Reloading", the PID from 03:01 kept running, and sessions went on
 * reporting `cliVersion 0.5.7` until someone ran `systemctl --user restart` by hand.
 *
 * ⚠️ macOS never had this: it does `bootout` then `bootstrap`, an unconditional reload. **The
 * asymmetry is why testing on a Mac could not see it** — the same command on the two platforms
 * meant "reload" on one and "start if stopped" on the other.
 *
 * 📌 Returned as data so the sequence is testable: what matters is which commands run and in
 * what order, and `install()` only executes them.
 */
export function systemdActivation(): string[][] {
  return [
    ["--user", "daemon-reload"],
    ["--user", "enable", SYSTEMD_UNIT],
    ["--user", "restart", SYSTEMD_UNIT],
  ];
}

export function install(logFile: string): InstallResult {
  const { args, volatile } = execLine();
  const notes: string[] = [];
  if (volatile) {
    notes.push(
      "⚠ npx 캐시 경로에서 실행 중 — 캐시가 정리되면 유닛이 깨집니다. `npm i -g @metadium-did/platform-agent-js` " +
        "또는 단일 바이너리 설치 후 `upgrade`를 권장합니다.",
    );
  }
  if (process.platform === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xmlEscape(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>
</dict></plist>
`;
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath, plist);
    const domain = `gui/${process.getuid?.() ?? 501}`;
    runQuiet("launchctl", ["bootout", domain, plistPath]);   // 기존 로드 정리(미로드면 무시)
    run("launchctl", ["bootstrap", domain, plistPath]);
    return { kind: "launchd", unitPath: plistPath, notes };
  }

  if (process.platform === "linux") {
    try {
      run("systemctl", ["--user", "--version"]);
    } catch {
      throw new Error(
        "systemd --user를 쓸 수 없는 환경입니다 — supervisor에 다음을 직접 등록하세요:\n  " + args.join(" "),
      );
    }
    const unitDir = join(homedir(), ".config", "systemd", "user");
    const unitPath = join(unitDir, SYSTEMD_UNIT);
    const unit = `[Unit]
Description=metapass agent proxy daemon (doc26)

[Service]
ExecStart=${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(unitPath, unit);
    for (const argv of systemdActivation()) {
      run("systemctl", argv);
    }
    // linger — 로그아웃 후에도 유지(서버 필수). polkit 정책으로 거부될 수 있음(doc26 검토 ④).
    try {
      run("loginctl", ["enable-linger", process.env.USER ?? ""]);
      notes.push("linger 설정됨 — 로그아웃 후에도 데몬이 유지됩니다.");
    } catch (e) {
      notes.push(
        "⚠ linger 설정 실패(조직 정책일 수 있음) — 로그아웃하면 데몬이 종료됩니다. 관리자에게 다음을 요청하세요:\n" +
          `    sudo loginctl enable-linger ${process.env.USER ?? "<user>"}\n` +
          "  (또는 관리자가 시스템 유닛으로 전환: 위 ExecStart를 /etc/systemd/system 유닛에 User= 지정으로)",
      );
    }
    notes.push(`로그: journalctl --user -u ${SYSTEMD_UNIT} -f`);
    return { kind: "systemd", unitPath, notes };
  }

  throw new Error(`지원하지 않는 플랫폼: ${process.platform} (macOS/Linux 지원)`);
}

export function uninstall(): string[] {
  const done: string[] = [];
  if (process.platform === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try {
      run("launchctl", ["bootout", domain, plistPath]);
      done.push("launchd 언로드");
    } catch {
      // 미로드 — 무시
    }
    if (existsSync(plistPath)) {
      rmSync(plistPath);
      done.push(`삭제: ${plistPath}`);
    }
    return done;
  }
  if (process.platform === "linux") {
    try {
      run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
      done.push("systemd 유닛 중지·비활성");
    } catch {
      // 미설치 — 무시
    }
    const unitPath = join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
    if (existsSync(unitPath)) {
      rmSync(unitPath);
      run("systemctl", ["--user", "daemon-reload"]);
      done.push(`삭제: ${unitPath}`);
    }
    return done;
  }
  throw new Error(`지원하지 않는 플랫폼: ${process.platform}`);
}
