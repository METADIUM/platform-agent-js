# @metadium-did/platform-agent-js

A Node/TypeScript **holder client and CLI** that lets an AI agent (Claude Code, for example)
**authenticate to a service with a delegation VC**. It replaces static API keys with
**scoped, time-bound, revocable delegation** (scenario #8 in `platform-docs/22`).

- **did:jwk keys** (ES256 / P-256) — generation and storage
- **agent-delegation `/1`**: pairing (§7), pickup of approved delegations (§8), the session-token
  exchange at the verifier (§9) and a request proof (`Agent-Proof`) on every call to the RP (§10–§11)
- **SD-JWT VC presentation + KB-JWT** (holder binding) — builds the delegation VP
- **A local daemon** that serves each RP to MCP clients on `127.0.0.1`, so a client that only
  supports a fixed header keeps working while session tokens are refreshed underneath

> **v0 was removed on 2026-10-17** (spec §20). The `register`, `session` and `proxy` commands and the
> `AgentClient`/`BriefickAgentClient`/`AgentAuth` library API are gone, and every RP has removed its v0
> endpoints. An RP added with an older version without `--verifier` is reported by `up` and `status`
> with the command that re-adds it over `/1`.

> **Why cryptography lives in Node here.** The agent is the **holder** of the delegation VC, so it
> has to sign KB-JWTs and request proofs **locally with its own private key** — delegating that
> signing to a remote service would break holder binding. Unlike a verifier (RP), holder
> cryptography cannot be offloaded, so it has to run where the agent runs (Node / MCP). The surface
> is kept small on purpose: **holder presentation path only, ES256 only**, and the wire format is
> cross-checked against `platform-java` (see below).

## CLI (one `npx` line, no clone needed)

```bash
# Add an RP and pair with it (pairing code from the RP's agents page)
npx @metadium-did/platform-agent-js add <RP_URL> --verifier <VERIFIER_URL> --code <PAIRING_CODE>

npx @metadium-did/platform-agent-js up --install   # run the daemon as an OS service
npx @metadium-did/platform-agent-js status         # delegations, sessions, and the `claude mcp add` lines
npx @metadium-did/platform-agent-js did            # print this agent's did:jwk and fingerprint
```

`add` reads the RP's legs (pairing, pickup, MCP paths) from the verifier's signed registry entry
(`GET <verifier>/rp/<alias>`, §17) and refuses an RP the verifier registers at another URL. Use
`--verifier-rp <alias>` when the RP's alias at the verifier differs from the one derived from its URL.
After the wallet approves a delegation, the daemon picks it up by itself; each delegation gets a
route `127.0.0.1:<port>/<alias>/<route>/mcp` (§15).

`did` prints the agent's **fingerprint** (first 10 hex characters of `sha256(did:jwk)`). Every
did:jwk starts with the same prefix, so they cannot be told apart by eye; compare the fingerprint
with the one the RP shows to confirm **which agent** a delegation is issued to.

**Key persistence.** The key is stored in `~/.metapass-agent/key.json` (file mode 0600, directory
0700), so the agent keeps the same did:jwk across runs. Change the path with `--key-file <PATH>` or
`METAPASS_AGENT_KEY_FILE`. The private key stays in that store and is never sent over the network.

**Key storage security.** On load, file permissions are checked, and anything readable beyond the
owner (not 0600) is **refused**, the way ssh does, with a `chmod 600` hint. If you would rather not
have a plaintext file, use an **OS keychain backend**:

```bash
npx @metadium-did/platform-agent-js did --key-backend keychain   # or METAPASS_AGENT_KEY_BACKEND=keychain
```

This stores the key in the macOS Keychain (`security`) or in libsecret on Linux (`secret-tool`), and
leaves no plaintext file behind. An existing `key.json` is migrated into the keychain once,
automatically; deleting the file afterwards is recommended. Even if the key leaks, what the holder
of it gets is a short-lived session within the delegated scope, and revoking the delegation from the
wallet invalidates it immediately — keeping scope and lifetime small at issuance time is the most
effective defence.

## The daemon — using this with Claude Code

Claude Code, as an MCP client, supports only a **fixed `Authorization` header**, while a delegation
session token is short-lived and every call to the RP carries a fresh request proof. The daemon
bridges the two: Claude Code sends its fixed local token to the daemon, and the daemon adds the
session token and proof for the RP.

```text
Claude Code ──(local token, 127.0.0.1)──▶ daemon ──(Delegation token + Agent-Proof)──▶ RP /mcp
```

- **Binds 127.0.0.1 only.** Default port **8787** (`--port`). Every request except `GET /healthz`
  needs the local token printed by `add` and `status`.
- **Transparent forwarding**: method, body and the response stream (**including SSE**) pass through;
  only the authorization headers are set by the daemon.
- **Limits the RP enforces** (§11.1) are kept: a delegation the RP cannot use is dropped, and one
  whose limits the RP does not understand yet is held until `credentials unhold`.

## Install the CLI (single binary)

`install.sh` downloads the signed binary for your platform, verifies it against the release
signing key below, and installs it to `~/.metapass-agent/bin` (override with
`METAPASS_AGENT_BIN_DIR`). Pin a release with `METAPASS_AGENT_VERSION=v0.5.5`.

This repository is **private**, so the unauthenticated `raw.githubusercontent.com` URL returns
404. Use an authenticated path - a logged-in [GitHub CLI](https://cli.github.com) covers both:

```sh
# From main
gh api repos/METADIUM/platform-agent-js/contents/scripts/install.sh \
   -H "Accept: application/vnd.github.raw" > install.sh && sh install.sh

# Or from the latest release's assets
gh release download -R METADIUM/platform-agent-js --pattern install.sh -O install.sh && sh install.sh
```

The installer requires `minisign`, and refuses to install without it rather than falling back to
an unsigned channel. Without `gh`, the script falls back to anonymous `curl`, which also needs
`python3` - but anonymous access cannot reach a private repository, so `gh` is the supported path
here.

Every refusal states **what state you are now in**: whether nothing was installed, or whether a
previous version is still in place and still running.

## Install (as a library)

```bash
npm install @metadium-did/platform-agent-js
```

The npm package (library or `npx`) runs on **your** Node. Use a Node with the October 2026 security
fixes, **22.23.4+ or 24.22.1+**: the client talks to remote servers through `fetch`, which
decompresses Brotli responses (CVE-2026-111497). The single binary embeds Node 22.23.4 from 0.11.4.

## Library API — a session token for a stored delegation

The programmatic entry point is **ESM `dist/index.js` with types in `dist/index.d.ts`**.

```ts
import { AgentKey, exchangeSessionToken, loadStore, defaultKeyFile } from "@metadium-did/platform-agent-js";

// Reuse the key and a delegation VC the CLI already stored
const store = loadStore(defaultKeyFile())!;
const key = await AgentKey.fromPrivateJwk(store.privateJwk);
const vc = Object.values(store.credentials ?? {})[0];

// §9: present the VC at the verifier and receive a short-lived session token for one RP
const t = await exchangeSessionToken({ verifierUrl: "https://sso.cplabs.io", vc, rp: "briefick", key });
t.accessToken;   // sent as `Authorization: Delegation <token>`, with an Agent-Proof per call (§10–§11)
```

## The `/1` requests

`src/wire-surface.ts` (`WIRE_SURFACE`) declares every request this CLI sends — method, body fields
and the headers it sets — and `test/wire-surface.test.ts` drives the real calls and compares, so a
wire change cannot go unnoticed.

## Deployment-side values (Briefick env)

- `METAPASS_DELEGATION_VCT` = `https://sso.cplabs.io/creds/delegation/worklog/v1` — the registered
  delegation vct.
- `METAPASS_DELEGATION_ADMIN_KEY` = the `PLATFORM_SECURITY_API_KEY` set when sso.cplabs.io was
  deployed. This is a secret belonging to that verifier instance; it is not a value New-Platform
  issues.

## Release signing key

Release assets are verified against this minisign public key. `install.sh` refuses to install
without a successful signature check.

```text
RWT8kUm/J8uyqoOFON5wRNBUCOUtn4+nX0YeyYMItdo2J6iVNYd4uUAX
```

The same key is in `minisign.pub` in this repository. Verify a release yourself with:

```sh
minisign -Vm SHA256SUMS -P 'RWT8kUm/J8uyqoOFON5wRNBUCOUtn4+nX0YeyYMItdo2J6iVNYd4uUAX' \
         -x SHA256SUMS.minisig
```

Checking the SHA256 sums alone is not enough: an attacker who can replace an asset can replace
the sums file with it. The signature is what ties the sums to the publisher, so the key has to
come from somewhere other than the release you are checking — that is why it is published here.

## Wire-format parity

did:jwk (canonical JWK member order), SD-JWT VC presentation
(`core = issuerJwt~disc~…~`, `sd_hash = base64url(SHA-256(ASCII(core)))`) and KB-JWT
(`typ=kb+jwt`, `{iat,aud,nonce,sd_hash}`) must be **byte-identical to `platform-java`**.

- Self-check: `npm test`
- Cross-check: `AgentJsParityTest` in `platform-java` takes a delegation VC issued by Java, has this
  client present it, and confirms that `VerifierCore.verify` accepts it — the holder-presentation
  invariant across the three runtimes. It runs automatically when `node` is installed.

## Scope

ES256 / P-256, holder **presentation** path only; issuance and verification belong to the platform.
Other curves and issuance logic are not supported.
