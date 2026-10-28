/**
 * platform-agent CLI (agent-delegation `/1`): pair with an RP, pick up delegations (§8), and serve them to MCP
 * clients through the local daemon. v0 (`register`/`session`/`proxy`) was removed on 2026-10-17 (spec §20).
 *
 *   npx @metadium-did/platform-agent-js add <RP_URL> --verifier <VERIFIER_URL> --code <PAIRING_CODE>
 *   npx @metadium-did/platform-agent-js up --install
 *   npx @metadium-did/platform-agent-js status
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MINISIGN_PUBLIC_KEYS } from "./release-key.js";
import { downloadVerified, freeBytes, latestTag, planUpgrade, type UpgradeIo } from "./upgrade.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { hostname } from "node:os";
import { AgentKey, groupFingerprint } from "./key.js";
import { DelegationSessionAuth, type SessionState } from "./delegation-session.js";
import { exchangeSessionToken } from "./session.js";
import { fetchRpEntry, pairV1, requireV1, RpEntryError, type RpEntry } from "./rp-entry.js";
import { DEFAULT_POLL_INTERVAL_S, isNewer, latest, pickup, pickupMessage, type PickedDelegation, type PickupResult } from "./pickup.js";
import { defaultRoute, routeFor, sanitizeRoute, slotKey, slotsOf, vcScope } from "./routes.js";
import { defaultKeyFile, KeyStoreUnreadable, loadStore, openStore, type AgentStore, type DroppedVc, type HeldCredential, type KeyStore } from "./keystore.js";
import {
  aliasFromUrl, configDir, DEFAULT_RP_PATHS, ensureToken, loadConfig, mcpAddCommand, mcpAddRouteCommand, rotateToken, saveConfig, tokenRef, prepareLogFile, readToken,
  type DaemonConfig, type DaemonRp,
} from "./config.js";
import { startDaemon, type DaemonTarget } from "./daemon.js";
import { EXIT_CONFIG, install as installUnit, uninstall as uninstallUnit } from "./install.js";

interface Args {
  /** 등록 시 서버에 보내는 표시 이름. 미지정이면 호스트 이름. */
  label?: string;
  cmd?: string;
  /** `upgrade --check`: compare versions and print, download nothing. */
  check?: boolean;
  /** 서브커맨드 (예: credentials clear / add·remove의 URL·alias). */
  sub?: string;
  url?: string;
  code?: string;
  keyFile: string;
  keyBackend?: string;
  /** Accepted and ignored: it converted a v0 RP, and v0 is gone. Kept so older commands still run. */
  force: boolean;
  port?: number;
  mcpPath?: string;
  alias?: string;
  /** `add --verifier`: the RP serves `/1`, and this verifier issues its session tokens (§9). */
  verifier?: string;
  verifierRp?: string;
  /** The third positional, e.g. the file in `credentials import`. */
  arg2?: string;
  /** The fourth positional, e.g. the new name in `route rename`. */
  arg3?: string;
  /** §15: the daemon route a delegation goes to (`credentials import`/`unhold`, `route rename`). */
  route?: string;
  install: boolean;
  uninstallFlag: boolean;
  /**
   * 인식하지 못한 `-`/`--` 인자. **비어 있지 않으면 실행하지 않는다.**
   *
   * 🔴 종전에는 이것이 `rest` 로 떨어져 **두 자리 중 하나**에 앉았다(`out.cmd ??= rest[0]`):
   * ```
   * status --bogus   → rest[1] = sub 자리 → status 는 sub 를 안 본다 → **조용히 무시**
   * --version        → rest[0] = cmd 자리 → 「알 수 없는 명령」 → 시끄럽게 죽음
   * ```
   * ⚠️ 앞쪽이 위험하다 — `up --install` 을 `--install` 없는 판(0.3.0)에서 돌리면 **그냥 `up`** 이
   * 되고, 프록시는 떠서 «된 것처럼» 보이는데 **상주 등록만 빠진다.** 드러나는 시점이
   * **재부팅 뒤**라 원인과 증상이 가장 멀다(metapass-saas 실측).
   */
  unknownFlags?: string[];
  /** `--port` 에 쓸 수 없는 값이 왔다. 비어 있지 않으면 실행하지 않는다. */
  badPort?: string[];
}

function parse(argv: string[]): Args {
  const out: Args = { keyFile: "", force: false, install: false, uninstallFlag: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    // 🟡 **`--port=8787` 도 아는 옵션이다**(briefick 리뷰). 종전에는 통째로 비교해서
    //    「알 수 없는 옵션」이라 말했고, 사용자는 **있는 이름을 오타로 의심**하러 갔다.
    //    ⚠️ 0.4.1 에서 등호형은 `rest` 로 흘러 **조용히 무시**됐다 — 이 변경이 없애려는
    //       침묵 중 하나다. 이름과 값을 갈라 두 형태를 같게 다룬다.
    const eq = raw.startsWith("-") ? raw.indexOf("=") : -1;
    const a = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    /** 값이 필요한 옵션 — `--x=v` 면 그 값을, 아니면 다음 인자를 쓴다. */
    const val = (): string => inline ?? argv[++i];
    if (a === "--url") out.url = val();
    else if (a === "--code") out.code = val();
    else if (a === "--key-file") out.keyFile = val();
    else if (a === "--key-backend") out.keyBackend = val();
    else if (a === "--port") {
      // 🟡 **빈 값·비수치를 거부한다**(briefick 리뷰). `Number("")` 는 **0** 이고
      //    `0 ?? 8787` 도 0 이라, `--port=` 하나로 **OS 임의 배정 포트**에 리슨했다.
      //    ⚠️ 그 자리에서는 출력이 실제 포트를 찍어 «된 것처럼» 보이고, 깨지는 건
      //       **다음 기동** 때다(등록된 MCP URL 은 안 바뀐다) — 증상이 원인에서 멀다.
      const raw2 = val();
      const n = Number(raw2);
      if (!Number.isInteger(n) || n < 1 || n > 65535) (out.badPort ??= []).push(`--port=${raw2}`);
      else out.port = n;
    }
    else if (a === "--mcp-path") out.mcpPath = val();
    else if (a === "--alias") out.alias = val();
    else if (a === "--verifier") out.verifier = val();
    else if (a === "--verifier-rp") out.verifierRp = val();
    else if (a === "--route") out.route = val();
    else if (a === "--label") out.label = val();
    else if (a === "--install") out.install = true;
    else if (a === "--check") out.check = true;
    else if (a === "--uninstall") out.uninstallFlag = true;
    else if (a === "--force") out.force = true;
    else if (a === "-h" || a === "--help") out.cmd = "help";
    else if (a === "-v" || a === "--version") out.cmd = "version";
    // ⚠️ `-` 로 시작하면 **위치 인자가 아니다.** rest 로 흘려보내면 명령/하위명령 자리에 앉아
    //    조용히 무시된다 — 그 침묵이 이 변경이 없애려는 것이다.
    // 🟡 **이름만 보고한다**(briefick 리뷰). 원본을 찍으면 `--cod=SECRET123` 처럼
    //    **값이 stderr 로 새어** CI 로그·이슈 붙여넣기로 간다. 페어링 코드는 붙여넣는
    //    값이라 오타가 나는 자리가 정확히 거기다. ⚠️ 값을 찍어서 **얻는 게 없다** —
    //    사용자가 방금 친 것이고 고칠 것은 **이름**이다.
    else if (a.startsWith("-")) (out.unknownFlags ??= []).push(a);
    else rest.push(raw);
  }
  out.cmd ??= rest[0];
  out.sub = rest[1];
  out.arg2 = rest[2];
  out.arg3 = rest[3];
  out.url ??= process.env.BRIEFICK_URL;
  out.code ??= process.env.PAIRING_CODE;
  out.keyFile ||= defaultKeyFile();
  return out;
}

/** 저장소 오픈 — keychain 백엔드가 비어 있고 기존 key.json이 있으면 최초 1회 이관. */
function openAgentStore(args: Args): AgentStore {
  return migrateLegacyKeyFile(openStore({ backend: args.keyBackend, keyFile: args.keyFile }), args.keyFile);
}

/** An empty keychain takes the legacy key.json once. An unreadable key.json throws: it is never "no key". */
export function migrateLegacyKeyFile(store: AgentStore, keyFile: string): AgentStore {
  if (store.backend === "keychain" && !store.load()) {
    const legacy = loadStore(keyFile);
    if (legacy) {
      store.save(legacy);
      console.error(
        `기존 키 파일을 키체인으로 가져왔습니다: ${keyFile} → ${store.location}\n` +
          `  평문 파일 삭제 권장: rm "${keyFile}"`,
      );
    }
  }
  return store;
}

async function keyFrom(store: AgentStore): Promise<{ key: AgentKey; data: KeyStore; created: boolean }> {
  const existing = store.load();
  if (existing?.privateJwk) {
    return { key: await AgentKey.fromPrivateJwk(existing.privateJwk), data: existing, created: false };
  }
  const key = await AgentKey.generate();
  const data: KeyStore = { privateJwk: key.exportPrivateJwk() };
  store.save(data);
  return { key, data, created: true };
}

/**
 * Change the store against a fresh read and mirror it into `data`, the daemon's copy. Another process
 * (`credentials import`, `unhold`) may have written since `data` was loaded; saving `data` whole would undo it.
 */
export function updateStore(store: AgentStore, data: KeyStore, change: (fresh: KeyStore) => void): void {
  const fresh = store.load() ?? data;
  change(fresh);
  store.save(fresh);
  data.credentials = fresh.credentials;
  data.held = fresh.held;
  data.dropped = fresh.dropped;
  data.routeNames = fresh.routeNames;
}

/** 캐시된 위임 VC 삭제. 있었으면 true. With `only`, deletes it only while it is still that VC. */
export function clearCredential(store: AgentStore, data: KeyStore, url: string, only?: string): boolean {
  let had = false;
  updateStore(store, data, (s) => {
    const current = s.credentials?.[url];
    if (!current || (only !== undefined && current !== only)) return;
    const { [url]: _gone, ...rest } = s.credentials!;
    s.credentials = rest;
    had = true;
  });
  return had;
}

interface DaemonSessionView {
  alias: string;
  connected: boolean;
  pendingReason?: string;
  session?: SessionState;
  routes?: Array<DaemonSessionView & { route: string }>;
}

/** Whether a daemon answers `/status` at all: any HTTP status, since a 401 after `rotate-token` is still a daemon (Briefick). */
async function daemonAnswers(port: number, token: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500),
    });
    await r.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** The running daemon's per-RP session state, or null when it can't be read (stopped, older daemon, wrong token). */
async function daemonSessions(port: number, token: string): Promise<DaemonSessionView[] | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return null;
    return ((await r.json()) as { targets?: DaemonSessionView[] }).targets ?? null;
  } catch {
    return null;
  }
}

/** One line on the session, or null when it is healthy (the delegation line already says enough). */
export function sessionLine(t: DaemonSessionView | undefined): string | null {
  if (!t) return null;
  if (!t.connected) return `⏸ 세션 미연결: ${t.pendingReason ?? "위임 대기"}`;
  // A daemon still running a pre-removal build may report a v0 session (no `status`): nothing to add for it.
  if (!t.session || !("status" in t.session)) return null;
  return v1SessionLine(t.session);
}

function v1SessionLine(s: SessionState): string | null {
  switch (s.status) {
    case "active":
      return null;
    case "starting":
      return "⏳ 세션 발급 중(/1)";
    case "ending":
      return `⚠ 위임 종료 임박 — 세션 연장 불가(${s.expiresAt}), 지갑에서 새 위임 승인 필요`;
    case "retrying":
      return `⚠ 세션 발급 재시도 중: ${s.lastError}`;
    case "dropped":
      return `✗ 위임 폐기 — 새 위임 필요: ${s.error}`;
    case "held":
      return `⏸ ${heldMessage(s)}`;
  }
}

/** 위임 VC(SD-JWT)의 만료 — `validUntil`(ISO) 우선, 없으면 `exp`(epoch 초). 파싱 실패 시 null. */
function delegationValidUntil(sdJwt: string): Date | null {
  try {
    const parts = sdJwt.split("~");
    const payload = JSON.parse(Buffer.from(parts[0].split(".")[1], "base64url").toString("utf8")) as {
      validUntil?: string;
      exp?: number;
    };
    if (payload.validUntil) return new Date(payload.validUntil);
    // validUntil이 선택공개(_sd)면 페이로드엔 다이제스트뿐 — disclosure([salt, 이름, 값])에서 찾는다
    for (const d of parts.slice(1)) {
      if (!d) continue;
      try {
        const disc = JSON.parse(Buffer.from(d, "base64url").toString("utf8")) as unknown[];
        if (Array.isArray(disc) && disc[1] === "validUntil" && typeof disc[2] === "string") {
          return new Date(disc[2]);
        }
      } catch {
        // KB-JWT 등 비disclosure 조각 — 무시
      }
    }
    if (typeof payload.exp === "number") return new Date(payload.exp * 1000);
    return null;
  } catch {
    return null;
  }
}

function formatLeft(ms: number): string {
  const h = Math.floor(ms / 3600_000);
  if (h >= 48) return `${Math.floor(h / 24)}d`;
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}


/** The `/1` target (spec §9–§11): exchange the stored VC at the verifier, and sign each call. */
export interface V1Deps {
  /** §8 pickup; when absent, a missing VC waits for `credentials import`. */
  pickup?: () => Promise<PickupResult>;
  sleep?: (ms: number) => Promise<void>;
}

/** The longest pickup interval honoured from an RP (s); anything above, non-finite or non-positive is ignored. */
const MAX_POLL_INTERVAL_S = 3600;

export function vcDigest(vc: string): string {
  return createHash("sha256").update(vc, "utf8").digest("base64url");
}

function vcExp(vc: string): number | null {
  try {
    const exp = (JSON.parse(Buffer.from(vc.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** Dropped VCs still live: an expired one can't come back from pickup anyway. */
function liveDropped(list: KeyStore["dropped"], url: string, nowS: number): DroppedVc[] {
  return (list?.[url] ?? []).filter((d) => d.exp === null || d.exp > nowS);
}

/** Entries with no readable `exp` can't expire, so only the newest of them are kept (Briefick, minipaas on #51). */
export const DROPPED_WITHOUT_EXP_KEPT = 20;

/** `list` with `entry` added for `url`: expired entries gone, `entry` last, and a cap on the ones that never expire. */
function withDropped(list: KeyStore["dropped"], url: string, entry: DroppedVc, nowS: number): KeyStore["dropped"] {
  const others = liveDropped(list, url, nowS).filter((d) => d.digest !== entry.digest);
  const noExp = others.filter((d) => d.exp === null).slice(-(DROPPED_WITHOUT_EXP_KEPT - (entry.exp === null ? 1 : 0)));
  const kept = others.filter((d) => d.exp !== null || noExp.includes(d));
  return { ...(list ?? {}), [url]: [...kept, entry] };
}

function isDropped(store: AgentStore, data: KeyStore, url: string, vc: string): boolean {
  const digest = vcDigest(vc);
  const nowS = Date.now() / 1000;
  return [store.load() ?? data, data].some((s) => liveDropped(s.dropped, url, nowS).some((d) => d.digest === digest));
}

/** A pickup `interval` the RP sent, kept only when it is a sane number; never below the 60 s floor (§8). */
function pollInterval(current: number, sent: unknown): number {
  const s = typeof sent === "number" && Number.isFinite(sent) && sent > 0 ? Math.min(sent, MAX_POLL_INTERVAL_S) : 0;
  return Math.max(DEFAULT_POLL_INTERVAL_S, current, s);
}

/** A `/1` RP's routes (§15) and its pickup loop (§8). */
export interface V1Rp {
  routes: Map<string, DaemonTarget>;
  /** Stops pickup and every route's session. */
  stop(): void;
}

/** Moves a pre-§15 `credentials[url]` (and its `held`) to the route its scope names. */
function migrateLegacyCredential(store: AgentStore, data: KeyStore, url: string): void {
  if (!data.credentials?.[url] && !store.load()?.credentials?.[url]) return;
  const move = (s: KeyStore): void => {
    const vc = s.credentials?.[url];
    if (!vc) return;
    const slot = slotKey(url, routeFor(vcScope(vc), s.routeNames?.[url]));
    const { [url]: _c, ...credentials } = s.credentials!;
    // The route may already hold a VC: after a downgrade and re-upgrade, or when an earlier run migrated only in
    // memory. Keep the newer one, never overwrite blindly (metapass-saas, #54).
    const there = credentials[slot];
    const keepLegacy = !there || isNewer({ credential: vc, exp: vcExp(vc) }, { credential: there, exp: vcExp(there) });
    s.credentials = keepLegacy ? { ...credentials, [slot]: vc } : credentials;
    const h = s.held?.[url];
    if (h) {
      const { [url]: _h, ...held } = s.held!;
      s.held = { ...held, ...(h.credential === vc && keepLegacy ? { [slot]: h } : {}) };
    }
  };
  try {
    updateStore(store, data, move);
  } catch (e) {
    // A store that can't be written must not keep the daemon from serving: migrate this process's copy (Briefick).
    console.error(`위임 저장 형식 이관 실패(이번 실행만 메모리에서): ${e instanceof Error ? e.message : String(e)}`);
    move(data);
  }
}

/** One route's `/1` session for `vc`; null when the VC is held (§11.1 `keep`). */
async function connectRoute(
  rt: DaemonTarget, slot: string, vc: string, data: KeyStore, rp: DaemonRp & { verifierUrl: string },
  store: AgentStore, key: AgentKey,
): Promise<DelegationSessionAuth | null> {
  const held = data.held?.[slot];
  if (held?.credential === vc) {
    rt.pendingReason = heldMessage(held);
    return null;
  }
  // Persisted, so a restart doesn't present a refused VC again (§11.1).
  // Re-read before writing: `credentials import`/`unhold` may have changed the store since `up` (metapass-saas).
  const persistStopped = (s: Extract<SessionState, { status: "dropped" | "held" }>): void => {
    const entry = { digest: vcDigest(vc), exp: vcExp(vc) };
    const nowS = Date.now() / 1000;
    if (s.status === "dropped") {
      // Memory first, before reading the store: if the store can't be read, the next pickup pass still must not
      // present this VC again (metapass-saas on #51: it came back once a minute).
      data.dropped = withDropped(data.dropped, rp.url, entry, nowS);
      if (data.credentials?.[slot] === vc) {
        const { [slot]: _mem, ...restMem } = data.credentials;
        data.credentials = restMem;
      }
    }
    const fresh = store.load();
    if (!fresh) return;
    if (s.status === "dropped") {
      // Remembered even when a newer VC is stored now: this one was refused, and pickup would hand it back.
      fresh.dropped = withDropped(fresh.dropped, rp.url, entry, nowS);
      data.dropped = fresh.dropped;
    }
    if (fresh.credentials?.[slot] !== vc) {
      if (s.status === "dropped") store.save(fresh);
      return;
    }
    if (s.status === "dropped") {
      const { [slot]: _gone, ...rest } = fresh.credentials;
      fresh.credentials = rest;
      console.error(`[${rt.alias}] 위임 폐기(${s.error}) — 저장된 VC 삭제, 새 위임 필요`);
    } else {
      const { status: _s, ...h } = s;
      const record = { credential: vc, ...h };
      fresh.held = { ...(fresh.held ?? {}), [slot]: record };
      console.error(`[${rt.alias}] ${heldMessage(record)}`);
    }
    store.save(fresh);
    data.credentials = fresh.credentials;
    data.held = fresh.held;
  };
  const auth = new DelegationSessionAuth({
    key,
    verifier: rp.verifierUrl,
    exchange: () => exchangeSessionToken({ verifierUrl: rp.verifierUrl, vc, rp: rp.verifierRp ?? rp.alias, key }),
    onStopped: (s) => {
      try {
        persistStopped(s);
      } catch (e) {
        // Thrown from the session's callback, this would end the daemon (Briefick).
        console.error(`[${rt.alias}] 위임 상태 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
      // A dropped route stays (status shows it) until pickup brings a new delegation for it. Pickup runs once per
      // interval, which bounds any drop → re-present cycle to one per interval (metapass-saas B1).
    },
  });
  rt.auth = auth;
  await auth.start();
  console.error(`[${rt.alias}] /1 연결 → ${rt.targetMcpUrl} (검증자 ${rp.verifierUrl})`);
  return auth;
}

/**
 * A `/1` RP: its stored delegations become routes (§15), and pickup (§8) keeps running at the RP's interval so a newly
 * approved delegation arrives without a restart; on the same route a newer one replaces the older. The first pickup
 * pass runs before this returns. With no pickup, or once the RP shows it has none (two `404`s), only stored or
 * imported VCs are served.
 */
export async function connectV1Target(
  target: DaemonTarget,
  data: KeyStore,
  rp: DaemonRp & { verifierUrl: string },
  store: AgentStore,
  key: AgentKey,
  deps: V1Deps = {},
): Promise<V1Rp> {
  const routes = new Map<string, DaemonTarget>();
  target.routes = routes;
  target.auth = null;
  const sessions = new Map<string, DelegationSessionAuth>();
  let stopped = false;
  const handle: V1Rp = {
    routes,
    stop() {
      stopped = true;
      for (const a of sessions.values()) a.stop();
    },
  };
  const connect = async (route: string, vc: string): Promise<void> => {
    sessions.get(route)?.stop();
    sessions.delete(route);
    let rt = routes.get(route);
    if (!rt) {
      rt = { alias: `${target.alias}/${route}`, targetMcpUrl: target.targetMcpUrl, auth: null };
      routes.set(route, rt);
    }
    rt.auth = null;
    const a = await connectRoute(rt, slotKey(rp.url, route), vc, data, rp, store, key);
    if (a) sessions.set(route, a);
  };

  migrateLegacyCredential(store, data, rp.url);
  // A VC this agent already saw refused is never presented again, from memory or the store (metapass-saas B1).
  for (const { route, value: vc } of slotsOf(data.credentials, rp.url)) {
    if (!isDropped(store, data, rp.url, vc)) await connect(route, vc);
  }
  if (!deps.pickup) {
    if (routes.size === 0) target.pendingReason = `위임 VC 없음 — credentials import --url ${rp.url} <파일>`;
    return handle;
  }

  const pickupNow = deps.pickup;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let interval = DEFAULT_POLL_INTERVAL_S;
  let notFound = 0;
  const say = (reason: string): void => {
    if (reason !== target.pendingReason) console.error(`[${rp.alias}] ${reason}`);
    target.pendingReason = reason;
  };
  /** One pickup pass; false when pickup should stop (the RP has none). */
  const pass = async (): Promise<boolean> => {
    try {
      const r = await pickupNow();
      if (r.ok || r.error !== "no_pickup") notFound = 0;
      if (r.ok) {
        const names = (store.load() ?? data).routeNames?.[rp.url] ?? data.routeNames?.[rp.url];
        const byRoute = new Map<string, PickedDelegation[]>();
        for (const d of r.delegations) {
          // Persisted, so a restart doesn't re-adopt a VC this agent already saw refused (minipaas, Briefick).
          if (isDropped(store, data, rp.url, d.credential)) continue;
          // One source for the route name: the VC's own scope claim, as import and migration read it; the pickup
          // body's `scope` only when the VC has none (metapass-saas, #54: two sources served one VC on two routes).
          const claimed = vcScope(d.credential);
          const route = routeFor(claimed.length > 0 ? claimed : d.scope, names);
          byRoute.set(route, [...(byRoute.get(route) ?? []), d]);
        }
        for (const [route, ds] of byRoute) {
          if (stopped) return false;
          const best = latest(ds)!;
          const slot = slotKey(rp.url, route);
          const current = data.credentials?.[slot];
          if (current === best.credential && routes.has(route)) continue;
          // A newer delegation replaces the route's; an older one still live never displaces it (§15).
          if (current && current !== best.credential && !isNewer(best, { credential: current, exp: vcExp(current) })) continue;
          updateStore(store, data, (s) => {
            s.credentials = { ...(s.credentials ?? {}), [slot]: best.credential };
          });
          console.error(`[${rp.alias}] 위임 수령(${best.delegationId}) → 경로 /${rp.alias}/${route}/mcp`);
          await connect(route, best.credential);
        }
        if (routes.size === 0) say("위임 대기 — 지갑에서 승인하면 자동으로 받습니다");
        return true;
      }
      if (r.error === "no_pickup" && ++notFound >= 2) {
        // Two in a row, an interval apart: one 404 can be a deploy in progress (Briefick).
        say(`이 RP는 §8 회수를 지원하지 않습니다 — credentials import --url ${rp.url} <파일>`);
        return false;
      }
      if (r.error === "no_pickup") {
        say(`회수 경로가 없습니다(404) — ${interval}초 후 한 번 더 확인합니다`);
      } else {
        interval = pollInterval(interval, r.interval);
        // Serving = a session with a token; a route and its auth outlive expiry, refusal, keep and a failed exchange.
        say(pickupMessage(r, rp.url, [...sessions.values()].some((a) => ["active", "ending"].includes(a.state().status))));
      }
    } catch (e) {
      notFound = 0;   // "two in a row" means two answers in a row; an error between them breaks the run
      say(`회수 실패 — ${interval}초 후 재시도: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  };

  if (await pass()) {
    void (async () => {
      while (!stopped) {
        await sleep(interval * 1000);
        if (stopped || !(await pass())) return;
      }
    })().catch((e: unknown) => say(`/1 회수 중단: ${e instanceof Error ? e.message : String(e)}`));
  }
  return handle;
}

function heldMessage(h: { reason: string; keys: string[]; keysTotal?: number }): string {
  const more = h.keysTotal !== undefined && h.keysTotal > h.keys.length ? ` 외 ${h.keysTotal - h.keys.length}개` : "";
  return `위임 보류(${h.reason}${h.keys.length ? ": " + h.keys.join(", ") + more : ""}) — RP 가 이 제약을 모른다. ` +
    "RP 갱신 후 credentials unhold --url 또는 새 위임";
}

/**
 * 사용자가 방금 친 «그 호출 형태» — 도움말과 안내 문구가 이걸로 자기를 부른다.
 *
 * 🔴 왜 있나: 설치형(SEA) 은 **npx 를 못 쓰는 머신**을 위해 존재하는데, 종전에는 그 바이너리의
 *    `help` 가 `npx …` 를 실행하라고 안내했다(briefick #33 리뷰에서 실제로 돌려 보고 나왔다).
 *    Node 가 없어서 설치형을 쓰는 사람에게 **실행할 수 없는 명령**을 준 것이다.
 * ⚠️ SEA 에서는 `process.execPath` 가 곧 그 바이너리 경로다 — 사용자가 친 것과 같은 문자열이라
 *    그대로 붙여넣어 쓸 수 있다.
 */
export function invocation(sea: boolean = isSeaBinary(), execPath: string = process.execPath): string {
  return sea ? execPath : "npx @metadium-did/platform-agent-js";
}

/**
 * The token as printed: in clear only on a terminal. Anything else (a service log, the journal, a pipe, an AI agent's
 * transcript) gets a reference to the 0600 file, which the printed command reads when it runs (metapass-saas).
 */
export function shownToken(token: string, dir: string, tty: boolean): string {
  return tty ? token : tokenRef(dir);
}

/**
 * What `up` prints for Claude Code registration. Under a service (launchd/systemd) stderr is a log file or the
 * journal, so the token is printed as a reference to its 0600 file, never in clear (metapass-saas, 2026-10-18).
 */
export function upRegistrationLines(cfg: { rps: DaemonRp[] }, port: number, token: string, dir: string, tty: boolean): string[] {
  const shown = shownToken(token, dir, tty);
  return [
    `\nClaude Code 등록(복사-실행):`,
    ...cfg.rps.map((rp) => `  ${mcpAddCommand(rp.alias, port, shown, cfg.rps.length === 1)}`),
    ...(tty ? [] : ["  (the token isn't written to this log: the command reads it from the 0600 proxy-token file)"]),
  ];
}

/** When v0 was removed from every RP (spec §20) and from this CLI. */
export const V0_REMOVED_ON = "2026-10-17";

const REMOVED_V0_COMMANDS = ["register", "session", "proxy"];

/**
 * The `/1` `add` for a URL; `--alias` only when the entry's alias isn't the URL's default. A key already paired
 * there needs no code (Briefick), so `--code` is required only for a new pairing.
 */
function readdCommand(url: string, alias: string | undefined, inv: string, newPairing = false): string {
  const named = alias !== undefined && alias !== aliasFromUrl(url) ? ` --alias ${alias}` : "";
  const line = `${inv} add ${url} --verifier <verifier-url> --verifier-rp <alias at the verifier>${named}`;
  return newPairing
    ? `${line} --code <code> (the exact line, with its code, is on the RP's agents page)`
    : `${line} (the exact line is on the RP's agents page; add --code <code> only if the RP asks for one)`;
}

/** What `up` and `status` say for a config entry without a verifier: a v0 target, which is never contacted. */
export function v0TargetMessage(rp: DaemonRp, inv: string = invocation()): string {
  return `'${rp.alias}' is a v0 target; v0 was removed (${V0_REMOVED_ON}). Re-add it with: ${readdCommand(rp.url, rp.alias, inv)}`;
}

/** `add` without `--verifier`: that was v0 pairing. */
export function addNeedsVerifier(url: string, inv: string = invocation()): string {
  return `--verifier is required: v0 pairing was removed (${V0_REMOVED_ON}). Use: ${readdCommand(url, undefined, inv, true)}`;
}

/**
 * One configured RP as a daemon target. A `/1` RP connects in the background (pickup, exchange); a v0 entry gets
 * {@link v0TargetMessage} as its 503 reason and no network call.
 */
export function daemonTargetFor(
  rp: DaemonRp, data: KeyStore, store: AgentStore, key: AgentKey,
  deps: V1Deps = { pickup: () => pickup(pickupOptionsFor(rp, key)) },
): DaemonTarget {
  const target: DaemonTarget = {
    alias: rp.alias,
    targetMcpUrl: mcpUrlFor(rp.url, rp.mcpPath),
    auth: null,
    pendingReason: "위임 미확보 — 지갑에서 승인하면 자동 연결됩니다",
  };
  if (!rp.verifierUrl) {
    target.pendingReason = v0TargetMessage(rp);
    console.error(`[${rp.alias}] ${target.pendingReason}`);
    return target;
  }
  connectV1Target(target, data, { ...rp, verifierUrl: rp.verifierUrl }, store, key, deps).catch((e: unknown) => {
    target.pendingReason = `/1 연결 실패: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[${rp.alias}] ${target.pendingReason}`);
  });
  return target;
}

export const helpText = (inv: string = invocation()): string => `metapass-agent — AI 에이전트 위임 CLI

시작하기
  ${inv} add <RP_URL> --verifier <검증자 URL> --code <페어링 코드>
  ${inv} up --install
  ${inv} status

데몬
  add <RP_URL> --verifier <URL>     RP를 데몬에 추가합니다. --code를 주면 페어링도 합니다. Claude Code 등록 명령을 출력합니다.
                                    [--verifier-rp 등록부 별칭] [--alias 이름] [--label 표시 이름]
                                    --verifier는 필수입니다(v0 페어링은 2026-10-17에 제거됐습니다).
                                    위임은 데몬이 RP에서 자동으로 받습니다(§8 회수). 위임마다 경로가 생깁니다:
                                    127.0.0.1:<포트>/<alias>/<경로>/mcp (경로 = 첫 scope, §15).
  up [--install]                    등록된 모든 RP를 127.0.0.1:<포트>/<alias>/mcp로 제공합니다.
                                    로컬 토큰이 필요합니다(GET /healthz만 예외).
                                    --install: OS 서비스(launchd, systemd --user)로 설치하고 시작합니다.
  down --uninstall                  OS 서비스를 중지하고 제거합니다.
  status                            데몬 상태, RP별 위임 상태, Claude Code 등록 명령을 보여 줍니다.
  remove <alias>                    데몬 설정에서 RP를 뺍니다. 등록과 위임 VC는 남습니다.
  rotate-token                      로컬 토큰을 바꿉니다. 모든 RP를 Claude Code에 다시 등록해야 합니다.

위임 VC
  credentials clear [--url <RP>]        저장된 위임 VC를 지웁니다. 다음 실행 때 지갑 승인을 기다립니다.
  credentials import --url <RP> <파일>  위임 VC를 파일에서 저장합니다(§8 회수가 없는 RP용).
                                        [--route <경로>] 기본은 그 위임의 첫 scope.
  credentials unhold --url <RP>         보류된 위임을 다시 씁니다(RP가 갱신된 뒤). [--route <경로>]
  route rename --url <RP> <경로> <새 이름>  위임 경로 이름을 바꿉니다. 같은 경로의 새 위임은 이전 것을 대체합니다.

에이전트
  did                                   이 에이전트의 did:jwk를 출력합니다.

업데이트
  upgrade [--check]                     최신 릴리스로 올립니다(서명 확인 후 교체, 서비스 재시작).
                                        --check: 내려받지 않고 버전만 비교합니다.

옵션
  --port <N>             up 포트(기본 8787, 127.0.0.1에서만). 이번 실행에만 적용됩니다.
  --mcp-path <경로>      RP의 MCP 경로(기본 /api/mcp)
  --key-file <경로>      키 파일(기본 ~/.metapass-agent/key.json, 환경 변수 METAPASS_AGENT_KEY_FILE)
  --key-backend <종류>   file(기본) 또는 keychain(macOS 키체인, Linux libsecret).
                         keychain을 처음 쓰면 기존 key.json을 옮겨 옵니다. 옮긴 뒤 파일은 지우세요.
  --force                효과 없음 — 이전 명령(add --verifier --force)이 그대로 돌도록 받아 둡니다.
  -v, --version          버전을 출력합니다.
  -h, --help             이 도움말을 출력합니다.
  --url·--code는 환경 변수 BRIEFICK_URL·PAIRING_CODE로도 줄 수 있습니다.

위임이 거부되면(RP의 constraint_denied)
  constraints_missing·malformed·not_atomic   그 위임은 쓸 수 없습니다. 지우고 새 승인을 기다립니다.
  constraints_unknown_key                    RP가 아직 모르는 제약입니다. 위임은 보관하고 다시 시도하지 않습니다.
                                             RP가 갱신되면 credentials unhold 후 데몬을 다시 시작하세요.

알 수 없는 옵션이 있으면 아무것도 실행하지 않고 끝납니다.`;

/**
 * The MCP endpoint for an RP, assembled in one place.
 *
 * 🔴 There were two assembly sites and no test could reach either. Every test that touches
 * `targetMcpUrl` **passes the finished value in** (`test/daemon.test.ts`, `test/proxy.test.ts`),
 * which makes them structurally unable to see how it is built — adding cases to them would never
 * reach the assembly (`[metapass-saas]`, review of #23). Consolidate first, and the test that follows is
 * reaching production code rather than its own construction.
 */
export function mcpUrlFor(baseUrl: string, mcpPath?: string): string {
  return baseUrl.replace(/\/+$/, "") + (mcpPath ?? DEFAULT_RP_PATHS.mcpPath);
}

/**
 * The two network calls `upgrade` makes. They live here, not in `upgrade.ts`, so that module stays
 * testable without a network — every decision it makes is pure and only these touch the wire.
 *
 * ⚠️ `redirect: "follow"` matters: release asset URLs are 302s to a CDN.
 */
async function httpText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "metapass-agent" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function httpBinary(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "metapass-agent" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The I/O and trust material `upgrade` hands to `downloadVerified`, in one testable place.
 *
 * 🔴 This was an inline object literal, and the line that matters most in it was untested:
 * changing `MINISIGN_PUBLIC_KEYS` to `[MINISIGN_PUBLIC_KEYS[0]]` left **all 153 tests green**
 * (`[Briefick]`, review of #22). That single subscript is the whole rotation plan — a binary that
 * trusts only the first key cannot take a release signed by the next one, which is the failure the
 * list exists to prevent, and it would first appear on a user's machine on the rotation day.
 *
 * ⚠️ An object built inline is invisible to every test that builds its own.
 */
export function upgradeIo(log: (line: string) => void = (l) => console.log(l)): UpgradeIo {
  return { fetchText: httpText, fetchBinary: httpBinary, publicKeyTexts: MINISIGN_PUBLIC_KEYS, log };
}

export async function main(argv: string[]): Promise<number> {
  const args = parse(argv);

  // 🔴 **모르는 옵션이면 아무것도 하지 않는다.** 종전엔 조용히 무시돼 «된 것처럼» 보였다.
  //    ⚠️ 파괴적 변경이다 — 여분 플래그를 넘기던 스크립트가 깨진다. 그래도 이쪽이 맞다:
  //    지금 그 스크립트는 **「되고 있다고 믿는」** 상태이고, 깨지는 쪽이 정보가 많다.
  if (args.badPort?.length) {
    return fail(`포트 값이 잘못됐다: ${args.badPort.join(" ")} — 1~65535 의 정수여야 한다.`);
  }

  if (args.unknownFlags?.length) {
    return fail(`알 수 없는 옵션: ${args.unknownFlags.join(" ")}\n\n${helpText()}`);
  }

  if (args.cmd === "version") {
    const v = packageVersion();
    // 🔴 **못 읽으면 못 읽었다고 말한다.** 종전 초안은 `"unknown"` 을 찍고 **exit 0** 이었는데,
    //    그건 이 변경의 전제(«침묵이 위험하다»)를 **이 명령 자신이** 깨는 것이었다(briefick 리뷰).
    //    ⚠️ 「0.4.0 이상 필요」를 읽고 확인하러 온 사람이 `unknown` + 성공 종료를 받으면
    //       **확인했다고 믿는다.** 스크립트도 그 값을 받는다.
    //    📌 그리고 이 분기가 실제로 걸릴 자리가 있다 — **SEA 단일 바이너리**에서
    //       `import.meta.url` 기준 상대경로가 안 설 수 있고, 그 경로가 하필
    //       **`--version` 이 가장 필요한 자리**다(npx 사용자는 명령에 박힌 핀으로 이미 안다).
    if (v === null) {
      return fail(
        // 🔴 **이 분기의 독자는 설치형 0.5.1 하나다**(실측): npm 0.5.0 이상은 판을 찍고,
        //    그 미만은 「알 수 없는 명령」으로 죽는다 ⇒ npx 사용자는 여기 못 온다.
        //    그래서 종전의 «npx 로 쓰는 중이면 …» 은 **닿지 않는 독자에게만 보이는 조언**이었고,
        //    그 조언이 하는 일은 **범위 스펙을 눈에 넣는 것**뿐이었다(metapass-saas 지적).
        // ⚠️ 게다가 그 예시(`@^0.4.0`)를 그대로 치면 0.4.1 로 풀려 **`--version` 이 또 죽는다**
        //    — 진단하러 온 사람에게 **같은 실패를 한 번 더** 주던 셈이다(실측: exit 1 + 도움말 덤프).
        // ⇒ 설치형 처방을 먼저 놓고, 범위 스펙은 **예시로도 보여 주지 않는다.**
        "판을 읽지 못했다 — 이 실행본 안에서 package.json 을 찾을 수 없다.\n" +
          "  설치형(단일 바이너리)이면 설치 명령을 다시 실행해라 — 0.5.2 부터는 판을 찍는다.\n" +
          "  (npx 로 쓰는 중이라면 명령에 박은 **정확 핀**이 답이다. 범위 스펙은 낡은 캐시를 돌린다.)",
      );
    }
    console.log(v);
    return 0;
  }

  if (!args.cmd || args.cmd === "help") {
    console.log(helpText());
    return args.cmd ? 0 : 1;
  }

  if (REMOVED_V0_COMMANDS.includes(args.cmd)) {
    return fail(`'${args.cmd}' was removed with v0 (${V0_REMOVED_ON}). Use: ${readdCommand("<RP_URL>", undefined, invocation(), true)}, then ${invocation()} up`);
  }

  if (args.cmd === "did") {
    const store = openAgentStore(args);
    const { key, created } = await keyFrom(store);
    console.log(key.did);
    // 모든 did:jwk는 앞자리가 같아 육안 구분 불가 — 에이전트 페이지가 표시하는 지문과 1:1 대조용.
    console.error(`에이전트 지문: ${groupFingerprint(key.fingerprint)} (서비스 화면의 에이전트 지문과 대조)`);
    if (created) console.error(`(신규 키 생성·저장: ${store.location})`);
    return 0;
  }

  if (args.cmd === "credentials") {
    if (args.sub === "import") {
      const url = args.url?.replace(/\/+$/, "");
      if (!url || !args.arg2) return fail("사용: credentials import --url <RP> <VC 파일> — /1 RP 의 위임 VC 저장");
      const vc = readFileSync(args.arg2, "utf8").trim();
      if (!/^[\w-]+\.[\w-]+\.[\w-]+~/.test(vc)) return fail(`SD-JWT VC 가 아닙니다: ${args.arg2}`);
      const store = openAgentStore(args);
      const { data } = await keyFrom(store);
      const route = args.route ? sanitizeRoute(args.route) : routeFor(vcScope(vc), data.routeNames?.[url]);
      data.credentials = { ...(data.credentials ?? {}), [slotKey(url, route)]: vc };
      store.save(data);
      console.log(`✅ 위임 VC 저장: ${url} 경로 ${route} — 데몬 재시작 후 사용`);
      return 0;
    }
    if (args.sub === "unhold") {
      const url = args.url?.replace(/\/+$/, "");
      if (!url) return fail("사용: credentials unhold --url <RP> [--route <경로>] — 보류한 위임을 다시 제시(RP 갱신 후)");
      const store = openAgentStore(args);
      const data = store.load();
      const keys = args.route ? [slotKey(url, sanitizeRoute(args.route))]
        : [url, ...slotsOf(data?.held, url).map((x) => slotKey(url, x.route))];
      const gone = keys.filter((k) => data?.held?.[k]);
      if (!data?.held || gone.length === 0) {
        console.log(`보류 없음: ${url}${args.route ? ` 경로 ${args.route}` : ""}`);
        return 0;
      }
      data.held = Object.fromEntries(Object.entries(data.held).filter(([k]) => !gone.includes(k)));
      store.save(data);
      console.log(`✅ 보류 해제(${gone.length}건): ${url} — 데몬 재시작 후 다시 제시합니다`);
      return 0;
    }
    if (args.sub !== "clear") return fail("사용: credentials clear|import|unhold [--url <RP>]");
    const store = openAgentStore(args);
    const data = store.load();
    if (!data?.credentials || Object.keys(data.credentials).length === 0) {
      console.log("캐시된 위임 VC 없음");
      return 0;
    }
    if (args.url) {
      const url = args.url.replace(/\/+$/, "");
      const routed = slotsOf(data.credentials, url).map((x) => slotKey(url, x.route));
      const hadPlain = clearCredential(store, data, url);
      if (routed.length > 0) {
        updateStore(store, data, (s) => {
          s.credentials = Object.fromEntries(Object.entries(s.credentials ?? {}).filter(([k]) => !routed.includes(k)));
        });
      }
      if (!hadPlain && routed.length === 0) {
        console.log(`캐시 없음: ${args.url}`);
        return 0;
      }
      console.log(`✅ 캐시 삭제: ${args.url} — 다음 실행 시 지갑 재발급 승인을 대기합니다`);
    } else {
      const urls = Object.keys(data.credentials);
      data.credentials = {};
      store.save(data);
      console.log(`✅ 캐시 전체 삭제(${urls.length}건): ${urls.join(", ")}`);
    }
    return 0;
  }

  if (args.cmd === "route") {
    const url = args.url?.replace(/\/+$/, "");
    if (args.sub !== "rename" || !url || !args.arg2 || !args.arg3) {
      return fail("사용: route rename --url <RP> <지금 경로> <새 이름> — 위임 경로(§15) 이름 바꾸기");
    }
    const from = args.arg2;
    const to = sanitizeRoute(args.arg3);
    const store = openAgentStore(args);
    const data = store.load();
    if (!data) return fail("키 저장소 없음");
    const fromSlot = slotKey(url, from);
    const toSlot = slotKey(url, to);
    const names = { ...(data.routeNames?.[url] ?? {}) };
    // Refuse a name in use: a stored route, a name given before, or a scope's default route seen here (Briefick).
    const taken = new Set<string>([
      ...slotsOf(data.credentials, url).map((x) => x.route),
      ...slotsOf(data.credentials, url).map((x) => defaultRoute(vcScope(x.value))),
      ...Object.keys(names), ...Object.values(names),
    ]);
    taken.delete(from);
    if (taken.has(to)) return fail(`이미 쓰는 경로 이름입니다: ${to}`);
    // The default route (first scope) this name stands for: renamed before, or the default itself.
    const base = Object.entries(names).find(([, v]) => v === from)?.[0] ?? from;
    names[base] = to;
    data.routeNames = { ...(data.routeNames ?? {}), [url]: names };
    const move = <T>(m: Record<string, T> | undefined): Record<string, T> | undefined => {
      if (!m?.[fromSlot]) return m;
      const { [fromSlot]: v, ...rest } = m;
      return { ...rest, [toSlot]: v };
    };
    data.credentials = move(data.credentials);
    data.held = move(data.held);
    store.save(data);
    console.log(`✅ 경로 이름 변경: ${from} → ${to} (${url}) — 데몬 재시작 후 /<alias>/${to}/mcp`);
    return 0;
  }

  // ── 데몬(doc26 P1): add / remove / up / status / rotate-token ─────────────

  if (args.cmd === "add") {
    const url = (args.sub ?? args.url)?.replace(/\/+$/, "");
    if (!url) return fail("사용: add <RP_URL> --verifier <검증자 URL> [--code <CODE>] [--verifier-rp <별칭>] [--alias <이름>]");
    if (!args.verifier) return fail(addNeedsVerifier(url));
    const store = openAgentStore(args);
    const { key } = await keyFrom(store);
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    const alias = args.alias ?? aliasFromUrl(url);
    if (cfg.rps.some((r) => r.alias === alias && r.url !== url)) {
      return fail(`alias 충돌: '${alias}' — --alias 로 다른 이름을 지정하세요`);
    }
    // An existing entry for this alias (a v0 one included) is replaced by the /1 entry below; v0 has nothing left to stop.
    const existing = cfg.rps.find((r) => r.alias === alias);
    // /1 (spec §17): the verifier's signed registry entry names the RP's legs, and its resource must be the URL typed.
    let entry: RpEntry & { pairing: string; pickup: string };
    try {
      entry = requireV1(await fetchRpEntry({ verifierUrl: args.verifier, alias: args.verifierRp ?? alias, rpUrl: url }));
      if (args.code) {
        await pairV1({ resource: entry.resource, path: entry.pairing, key, code: args.code, label: registerLabel(args),
          version: packageVersion() ?? undefined });
        console.log(`✅ /1 페어링 완료 — 에이전트 지문 ${groupFingerprint(key.fingerprint)} (RP 화면의 에이전트 지문과 대조)`);
      }
    } catch (e) {
      if (e instanceof RpEntryError) return fail(e.message);
      throw e;
    }
    const v1 = { verifierUrl: args.verifier.replace(/\/+$/, ""), verifierRp: args.verifierRp ?? alias, pickupPath: entry.pickup,
      ...(entry.mcp ? { mcpPath: entry.mcp } : {}) };
    if (!existing) {
      cfg.rps.push({ alias, url, ...(args.mcpPath ? { mcpPath: args.mcpPath } : {}), ...v1 } satisfies DaemonRp);
    } else {
      Object.assign(existing, v1);
    }
    saveConfig(dir, cfg);
    const token = ensureToken(dir);
    const port = cfg.port ?? 8787;
    console.log(`✅ RP 추가: ${alias} → ${url}\n  에이전트 지문: ${groupFingerprint(key.fingerprint)}`);
    console.log(`\nClaude Code 등록(복사-실행):`);
    console.log(`  ${mcpAddCommand(alias, port, shownToken(token, dir, Boolean(process.stdout.isTTY)), cfg.rps.length === 1)}`);
    if (cfg.rps.length > 1) {
      console.log(`\n⚠ RP가 ${cfg.rps.length}개 — 루트 /mcp 등록이 있었다면 경로형으로 재등록하세요(status가 전체 명령 출력)`);
    }
    // A running daemon keeps the config it started with: a converted RP would still poll the old path (Briefick B5).
    if (await daemonAnswers(port, token)) {
      console.log(`\n⚠ 실행 중인 데몬은 이전 설정으로 돕니다 — 재시작해야 반영됩니다: ` +
        `서비스로 설치했다면 ${invocation()} up --install, 아니면 실행 중인 up 을 멈추고 다시 실행`);
    } else {
      console.log(`\n데몬 실행: ${invocation()} up`);
    }
    return 0;
  }

  if (args.cmd === "remove") {
    const alias = args.sub ?? args.alias;
    if (!alias) return fail("사용: remove <alias>");
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    const before = cfg.rps.length;
    cfg.rps = cfg.rps.filter((r) => r.alias !== alias);
    if (cfg.rps.length === before) return fail(`알 수 없는 alias: ${alias}`);
    saveConfig(dir, cfg);
    console.log(`✅ 제거: ${alias} — 데몬 재시작 후 반영 (등록·위임 캐시는 유지: credentials clear --url 로 별도 정리)`);
    return 0;
  }

  if (args.cmd === "rotate-token") {
    const dir = configDir(args.keyFile);
    const token = rotateToken(dir);
    const cfg = loadConfig(dir);
    console.log("✅ 로컬 토큰 회전 완료");
    console.log("⚠ 토큰은 데몬당 1개 — 지금 즉시 **모든 RP의 Claude Code 등록이 401**입니다. 아래로 전부 재등록하세요:");
    for (const rp of cfg.rps) {
      console.log(`  claude mcp remove ${rp.alias}; ${mcpAddCommand(rp.alias, cfg.port ?? 8787, shownToken(token, dir, Boolean(process.stdout.isTTY)), cfg.rps.length === 1)}`);
    }
    return 0;
  }

  if (args.cmd === "status") {
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    const store = openAgentStore(args);
    const data = store.load();
    const key = data?.privateJwk ? await AgentKey.fromPrivateJwk(data.privateJwk) : null;
    const token = ensureToken(dir);
    const port = cfg.port ?? 8787;
    let daemon = "stopped (ConnectionRefused)";
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      daemon = r.ok ? `running (port ${port})` : `unhealthy (${r.status})`;
    } catch {
      // stopped
    }
    const sessions = await daemonSessions(port, token);
    console.log(`에이전트 지문 ${key ? groupFingerprint(key.fingerprint) : "(키 없음)"}  ·  daemon: ${daemon}`);
    if (cfg.rps.length === 0) {
      console.log("  등록된 RP 없음 — add <RP_URL> --verifier <검증자 URL> --code <CODE> 로 시작하세요");
      return 0;
    }
    const delegationLine = (cred: string | undefined, held: HeldCredential | undefined): string => {
      if (!cred) return "위임 없음 → 지갑 승인 필요";
      if (held?.credential === cred) return `⏸ ${heldMessage(held)}`;
      const until = delegationValidUntil(cred);
      if (!until) return "위임 보유(만료 정보 없음)";
      const leftMs = until.getTime() - Date.now();
      return leftMs <= 0
        ? `✗ 위임 만료(${until.toISOString()}) → 지갑 재승인 필요`
        : (leftMs < 24 * 3600_000 ? "⚠ 위임 만료 임박 " : "✓ 위임 유효 ") + `(${formatLeft(leftMs)} 남음)`;
    };
    for (const rp of cfg.rps) {
      if (!rp.verifierUrl) {
        console.log(`  ${rp.alias.padEnd(10)} ✗ ${v0TargetMessage(rp)}`);
        continue;
      }
      const live = sessions?.find((t) => t.alias === rp.alias);
      const routes = slotsOf(data?.credentials, rp.url);
      if (routes.length === 0) {
        console.log(`  ${rp.alias.padEnd(10)} ${delegationLine(data?.credentials?.[rp.url], data?.held?.[rp.url])}`);
        const sess = sessionLine(live);
        if (sess) console.log(`  ${"".padEnd(10)} ${sess}`);
        console.log(`  ${"".padEnd(10)} ${mcpAddCommand(rp.alias, port, shownToken(token, dir, Boolean(process.stdout.isTTY)), cfg.rps.length === 1)}`);
        continue;
      }
      // §15: one line per route; with several, each needs its own MCP registration.
      const single = routes.length === 1;
      for (const { route, value: cred } of routes) {
        const name = `${rp.alias}/${route}`;
        console.log(`  ${name.padEnd(10)} ${delegationLine(cred, data?.held?.[slotKey(rp.url, route)])}`);
        const sess = sessionLine(live?.routes?.find((r) => r.route === route));
        if (sess) console.log(`  ${"".padEnd(10)} ${sess}`);
        const shown = shownToken(token, dir, Boolean(process.stdout.isTTY));
        console.log(`  ${"".padEnd(10)} ${single ? mcpAddCommand(rp.alias, port, shown, cfg.rps.length === 1)
          : mcpAddRouteCommand(rp.alias, route, port, shown)}`);
      }
    }
    return 0;
  }

  if (args.cmd === "down") {
    if (!args.uninstallFlag) return fail("사용: down --uninstall — OS 데몬 유닛 중지·제거");
    for (const line of uninstallUnit()) console.log("✅ " + line);
    return 0;
  }

  // ⚠️ **`upgrade` 는 판을 안 바꾼다.** 유닛(plist/systemd)의 실행 라인만 갱신하고 재시작한다 —
  //    `install.ts` 는 어디서도 바이너리를 복사하지 않는다. 설치형에서 실행 라인이 이미 맞아 있으면
  //    **파일이 그대로 남아** 「업그레이드했는데 판이 그대로」가 된다(briefick 실측).
  //    ⇒ 이름이 부르는 기대와 하는 일이 달라서, 명령 자신이 그 차이를 말하게 한다.
  if (args.cmd === "upgrade") {
    // 🔴 이 명령은 한때 «판을 안 바꿨다» — 유닛만 갱신하고 파일은 그대로였다. 이제 파일을 바꾼다.
    //    검증은 minisign 바이너리가 아니라 이 런타임이 한다(`src/minisign.ts` 참조).
    const sea = isSeaBinary();
    const current = packageVersion() ?? "0.0.0";
    const tag = await latestTag({ fetchText: httpText });
    const plan = planUpgrade({ sea, currentVersion: current, latestTag: tag });

    if (plan.action === "not-a-binary") {
      console.log(plan.message);
      return 0;
    }
    if (plan.action === "up-to-date") {
      console.log(`이미 최신입니다 — ${plan.version} (릴리스 ${tag})`);
      return 0;
    }
    if (args.check) {
      console.log(`업그레이드 가능: ${plan.from} → ${plan.to} (${plan.asset})`);
      return 0;
    }

    const destination = process.execPath;
    const free = freeBytes(dirname(destination));
    if (free !== undefined && free < 300 * 1024 * 1024) {
      return fail(`여유 공간이 부족합니다 (${Math.round(free / 1048576)} MB) — 교체에 약 300 MB 필요`);
    }
    console.log(`업그레이드: ${plan.from} → ${plan.to} (${plan.target})`);
    try {
      await downloadVerified(plan, destination, upgradeIo());
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    console.log(`  ✅ 교체 완료: ${destination}`);

    // 실행 라인이 바뀌었을 수 있으므로 유닛 재설치 = 새 바이너리로 재기동
    const dir0 = configDir(args.keyFile);
    prepareLogFile(join(dir0, "daemon.log"));
    const r = installUnit(join(dir0, "daemon.log"));
    console.log(`✅ 유닛 재설치·재시작(${r.kind}): ${r.unitPath}`);
    for (const n of r.notes) console.log("  " + n);
    // ⚠️ `OS_REASON_CODESIGNING` and `KeepAlive` are launchd words. On Linux this warned about
    //    something that cannot happen and named a mechanism systemd does not have
    //    (`[Briefick]`, 2026-10-01, after installing on pmvm-02). `r.kind` already says which
    //    installer ran — the information was there and the message ignored it.
    if (r.kind === "launchd") {
      console.log("  ⚠️ launchctl 에 OS_REASON_CODESIGNING 이 찍힐 수 있다 — 정상이다.");
      console.log("     옛 프로세스를 OS 가 정리한 기록이고, state=running 과 포트 LISTEN 으로 판단한다.");
    } else {
      console.log("  확인: systemctl --user status metapass-agent-proxy.service — state=running 과 포트 LISTEN 으로 판단한다.");
    }
    return 0;
  }

  if (args.cmd === "up" && args.install) {
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    if (cfg.rps.length === 0) return fail("등록된 RP 없음 — 먼저 add <RP_URL> --verifier <검증자 URL> --code <CODE>");
    ensureToken(dir); // 유닛 기동 전에 토큰·권한 선검증(fail-closed를 설치 시점에 노출)
    prepareLogFile(join(dir, "daemon.log"));
    const r = installUnit(join(dir, "daemon.log"));
    console.log(`✅ OS 데몬 설치·시작(${r.kind}): ${r.unitPath}`);
    for (const n of r.notes) console.log("  " + n);
    console.log(`  상태: ${invocation()} status`);
    return 0;
  }

  if (args.cmd === "up") {
    const dir = configDir(args.keyFile);
    const cfg = loadConfig(dir);
    if (cfg.rps.length === 0) return fail("등록된 RP 없음 — 먼저 add <RP_URL> --verifier <검증자 URL> --code <CODE>");
    const store = openAgentStore(args);
    const { key, data } = await keyFrom(store);
    const token = ensureToken(dir);

    const targets: DaemonTarget[] = [];
    for (const rp of cfg.rps) targets.push(daemonTargetFor(rp, data, store, key));

    // 🔴 **`up` 도 `--port` 를 읽는다**(briefick 리뷰). 종전엔 `cfg.port` 만 봐서
    //    `up --port 9999` 가 **조용히 무시**됐다 — 파서가 아는 플래그라 거부망에도 안 걸린다.
    //    ⚠️ 이 PR 이 없애려는 침묵과 같은 모양인데, 그건 **판이 달라** 생긴 것이고 이건
    //       **같은 판 안에서** 나는 침묵이라 더 나쁘다. 게다가 `up` 이 권장 명령이다.
    //    📌 HELP 가 `--port` 를 「proxy 리슨 포트」로만 적어 뒀는데, `up` 설명은
    //       `127.0.0.1:<port>/…` 를 말한다 — **문서가 서로 어긋났다.** 둘 다 고친다.
    // The file, read per request: a rotation revokes the old token without a restart.
    const daemon = await startDaemon({ targets, token: () => readToken(dir), port: args.port ?? cfg.port });
    // ⚠️ 명시한 `--port` 는 **이번 실행만** — 저장은 종전처럼 «자동 배정된 포트 고정» 일 때만.
    //    안 그러면 한 번의 `--port` 가 이후 기동을 **영구히** 바꾼다.
    if (args.port == null && cfg.port !== daemon.port) {
      cfg.port = daemon.port; // 최초 자동 배정 포트 고정(다중 계정 서버에서 사용자별로 갈림)
      saveConfig(dir, cfg);
    }
    console.error(`✅ 에이전트 데몬 실행: 127.0.0.1:${daemon.port} (RP ${targets.length}개, 로컬 토큰 필수)`);
    console.error(`   에이전트 지문: ${groupFingerprint(key.fingerprint)}`);
    for (const line of upRegistrationLines(cfg, daemon.port, token, dir, Boolean(process.stderr.isTTY))) console.error(line);
    console.error("\n(Ctrl+C 로 종료 · 상태는 다른 터미널에서 `status`)");
    const stop = async () => {
      await daemon.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise<void>(() => {});
    return 0;
  }

  return fail(`알 수 없는 명령: ${args.cmd}\n\n${helpText()}`);
}

/**
 * 이 패키지의 판. `package.json` 을 **런타임에 읽는다**(빌드 시 박지 않는다).
 *
 * ⚠️ `src/`(tsx)와 `dist/`(빌드본)가 **둘 다 패키지 루트 한 칸 아래**라 같은 상대경로가 선다.
 * 📌 왜 필요한가: `--version` 이 **없어서** 사용자가 자기 판을 알 방법이 없었다. 「0.4.0 이상이
 *    필요합니다」 라는 안내를 **읽고도 확인할 수단이 없다**. 그리고 이 문제는 「모르는 플래그
 *    거부」가 들어와도 **옛 판을 쓰는 사람에겐 안 온다** — 그 사람의 CLI 는 여전히 침묵한다.
 *    그래서 둘은 독립이다(metapass-saas·briefick 실측).
 */
/**
 * 🔴 **SEA 단일 바이너리에는 읽을 `package.json` 이 없다.** 위 주석이 「걸릴 자리가 있다」고
 *    예견한 그 분기가 실제로 걸렸다 — 릴리스 `v0.5.1` 의 바이너리에서 `--version` 이
 *    exit 1 로 «판을 읽지 못했다» 를 냈다(New-Platform 실측).
 *
 * ⚠️ 그리고 그 자리가 **`--version` 이 가장 필요한 자리**다: npx 사용자는 명령에 박힌 핀으로
 *    판을 이미 알지만, **설치형 사용자는 확인할 방법이 재설치뿐**이었다.
 *
 * ⇒ 빌드 때 판을 **번들에 박는다**(`scripts/build-sea.mjs` 의 esbuild `--define`).
 *   - SEA 번들: `__AGENT_VERSION__` 이 문자열 리터럴로 치환돼 파일을 안 읽는다
 *   - npm 빌드(tsc): 그 이름이 **없는 전역**이라 `typeof` 가 `"undefined"` — 던지지 않고
 *     종전대로 `package.json` 을 읽는다. 두 경로가 서로를 안 건드린다
 */
declare const __AGENT_VERSION__: string | undefined;

/** The §8 pickup call for a configured /1 RP: the signed entry's path when stored, else the default (older configs). */
export function pickupOptionsFor(rp: DaemonRp, key: AgentKey): Parameters<typeof pickup>[0] {
  return { url: rp.url, ...(rp.pickupPath ? { path: rp.pickupPath } : {}), key, version: packageVersion() ?? undefined };
}

function packageVersion(): string | null {
  // 빌드 때 박은 값이 있으면 그것이 답이다 — 파일이 없는 실행본도 판을 말할 수 있어야 한다.
  if (typeof __AGENT_VERSION__ === "string" && __AGENT_VERSION__ !== "") return __AGENT_VERSION__;
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** 서버 등록에 실을 표시 이름의 최대 길이 — 목록 한 줄에 들어가는 폭. */
export const LABEL_MAX = 64;

/**
 * 등록 시 서버에 보낼 표시 이름 — `--label` 이 있으면 그것, 없으면 **호스트 이름**.
 *
 * 왜 기본값이 있나: 에이전트 목록에서 «어느 머신에서 도는가»가 안 보였다. 사무실 NAT 뒤에서는
 * 공인 IP 도 기기를 못 가른다(briefick #32). 이름이 없으면 목록이 전부 「AI 에이전트」다.
 *
 * ⚠️ **호스트 이름은 사람 이름을 담는 경우가 흔하다**(`jongsik-macbook` 같은). 그것이 RP 서버에
 * 저장되고 목록에 표시된다. 기본 전송은 그 비용을 알고 고른 것이고, 바꾸려면 `--label` 로 원하는
 * 이름을 주면 된다 — 끄는 스위치는 없다.
 *
 * 값이 비거나 공백뿐이거나 `hostname()` 이 실패하면 **아무것도 안 보낸다**(`undefined`) —
 * 빈 문자열을 보내면 서버가 그것을 «이름이 있다»로 저장해 기본 표시보다 나빠진다.
 */
export function registerLabel(
  args: { label?: string },
  /** 호스트 이름 조회 — 시험이 «못 알아내는 경우»를 만들 수 있게 주입받는다. */
  getHost: () => string = hostname,
): string | undefined {
  const explicit = args.label?.trim();
  if (explicit) return explicit.slice(0, LABEL_MAX);
  let host = "";
  try {
    host = getHost().trim();
  } catch {
    return undefined;   // 못 알아냈다 ≠ 빈 이름이다
  }
  return host ? host.slice(0, LABEL_MAX) : undefined;
}

function fail(msg: string): number {
  console.error("오류: " + msg);
  return 1;
}

/**
 * 🔴 **SEA(단일 실행 파일)에서는 이 가드가 유일한 진입점이다** — 번들의 entry 가 이 파일이고
 *    `bin/cli.mjs` 는 안 실린다. 그런데 아래 비교가 **`argv[1]` 을 cwd 기준으로** 풀어서,
 *    **이름으로 부르면 아무것도 안 하고 조용히 exit 0** 이었다.
 *
 * 🔴 **실패 조건은 둘이 동시에 성립할 때 하나뿐이다**(metapass-saas 가 좁혔다):
 * ```
 * argv[1] 에 경로 구분자가 **없다**   그리고   cwd 가 **bin 이 아니다**
 * ```
 * `pathToFileURL("metapass-agent")` 가 `<cwd>/metapass-agent` 로 풀리므로,
 * **cwd 가 bin 이면 우연히 일치**해서 산다. ⇒ *"이름으로 부르면 깨진다"* 는 **과대 서술**이다.
 *
 * 실측 2026-09-23 (darwin-arm64 · linux-x64 · 설치형 0.5.2, 세 세션 · 세 머신):
 * ```
 * 다른 cwd · 절대경로                       0.5.2
 * 홈      · `.metapass-agent/bin/…`         0.5.2   ← **구분자 있는 상대경로도 산다**
 * 다른 cwd · `../../…/metapass-agent`       0.5.2
 * bin     · `./metapass-agent`              0.5.2
 * bin     · `metapass-agent`(구분자 없음)   0.5.2   ← cwd 가 bin 이라 산다
 * **다른 cwd · `metapass-agent`(구분자 없음)  빈 출력 · exit 0**   ← 유일한 실패. PATH 사용법
 * ```
 * ⚠️ 그리고 그때 **`#5` 의 거부망이 통째로 우회**된다 — `zzz-nosuch` 조차 0바이트 · exit 0 이라
 *    `cmd || echo fail` 도 안 터진다(metapass-saas 지적).
 * ⚠️ **PATH 에 넣고 이름으로 부르는 것이 정상 사용법**인데 그게 안 됐다. 못 잡은 이유는
 *    우리 측정이 전부 **전체 경로**였기 때문이다 — `install.sh` 출력·화면 안내·다른 세션의
 *    검증이 모두 `$DEST/metapass-agent` 꼴이었다. **재는 자리가 사용자의 자리와 달랐다.**
 * ⇒ SEA 이면 argv 와 무관하게 **항상 돈다.** npm 경로는 `bin/cli.mjs` 가 부르므로 영향 없다.
 *
 * ⚠️ **`node:sea` 는 Node 22+ 인데 `engines` 는 `>=18` 이다.** 실질 위험은 없다 —
 *    npm 경로는 이 가드를 안 타고(`bin/cli.mjs` 가 직접 `main` 을 부른다), SEA 는 **빌드 Node**가
 *    정한다(`build-sea.mjs` 가 개발 Node 를 그대로 쓴다). 못 부르면 `catch` 로 **옛 동작**이라
 *    더 나빠지지도 않는다. ⇒ 읽는 사람이 «18 에서도 이 분기가 산다» 로 읽지 않게 적어 둔다
 *    (metapass-saas 지적).
 */
function isSeaBinary(): boolean {
  try {
    const req = createRequire(import.meta.url);
    return (req("node:sea") as { isSea?: () => boolean }).isSea?.() === true;
  } catch {
    return false;
  }
}

/** A store that can't be read won't read on a restart either: EX_CONFIG, which the service unit doesn't restart. */
export function exitCodeFor(e: unknown): number {
  // A tool failure (locked keychain, D-Bus not up yet) may pass on a restart; only bad content parks the unit.
  return e instanceof KeyStoreUnreadable && !e.retryable ? EXIT_CONFIG : 1;
}

// `node dist/cli.js` 직접 실행 지원(bin/cli.mjs와 동일 동작) — 이전엔 무동작 exit 0이라 디버깅에 혼란.
const directEntry = process.argv[1];
if (isSeaBinary() || (directEntry && import.meta.url === pathToFileURL(directEntry).href)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      console.error("오류: " + (e instanceof Error ? e.message : String(e)));
      process.exit(exitCodeFor(e));
    });
}
