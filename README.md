# @metadium-did/platform-agent-js

A Node/TypeScript **holder client and CLI** that lets an AI agent (Claude Code, for example)
**authenticate to a service with a delegation VC**. It replaces static API keys with
**scoped, time-bound, revocable delegation** (scenario #8 in `samples/docs/22`).

- **did:jwk keys** (ES256 / P-256) — generation and storage
- **PoP JWTs** (proof of possession) — registration, retrieval, session exchange
- **SD-JWT VC presentation + KB-JWT** (holder binding) — builds the delegation VP
- Client for the **Briefick delegated-authentication contract** (register → retrieve → exchange)
- **Automatic bearer refresh** — short-lived session tokens are re-exchanged before they expire,
  so a client that only supports a fixed header keeps working

> **Why cryptography lives in Node here.** The agent is the **holder** of the delegation VC, so it
> has to sign KB-JWTs and PoPs **locally with its own private key** — delegating that signing to a
> remote service would break holder binding. Unlike a verifier (RP), holder cryptography cannot be
> offloaded, so it has to run where the agent runs (Node / MCP). The surface is kept small on
> purpose: **holder presentation path only, ES256 only**, and the wire format is cross-checked
> against `platform-java` (see below).

## CLI (one `npx` line, no clone needed)

```bash
# Register (once — pairing code from Briefick /publish)
npx @metadium-did/platform-agent-js register --url <BRIEFICK_URL> --code <PAIRING_CODE>

npx @metadium-did/platform-agent-js did                                     # print this agent's did:jwk
npx @metadium-did/platform-agent-js session --url <BRIEFICK_URL>            # issue one session bearer to stdout
npx @metadium-did/platform-agent-js credentials clear --url <BRIEFICK_URL>  # drop the cached delegation VC
```

**Recovering from server/local state drift (0.2.4).** After an RP revokes a registration, or the
user revokes the delegation, the CLI guides recovery instead of failing opaquely:

1. `register` with `--code` registers against the server regardless of a local "already registered"
   record, so re-registration after a revocation works.
2. A 401 on session exchange fails with guidance to run `register --force` with a fresh pairing code.
3. If a session is refused because the delegation is no longer valid, the cached credential is
   **discarded automatically**, the client switches to waiting for wallet re-approval, and retries once.
4. A pending-session timeout points at `credentials clear`.

**Telling expiry apart from waiting (0.2.5).** If a request expires while re-issuance is pending —
either the RP reports `status: "expired"` or `lastRequest.expiresAt` has passed (kept for backward
compatibility) — the CLI says **"the request expired; issue the delegation again from /publish"**
rather than "waiting for approval". The transition is detected even if it happens mid-wait. The 401
message also carries the server's own reason (`error`) when the RP sends one.

`--url` and `--code` can also be supplied as `BRIEFICK_URL` and `PAIRING_CODE`.

`did`, `register` and `proxy` also print the agent's **fingerprint** (first 10 hex characters of
`sha256(did:jwk)`). Every did:jwk starts with the same prefix, so they cannot be told apart by eye;
compare the fingerprint with the one Briefick shows on `/publish` to confirm **which agent** a
delegation is being issued to. While a delegation is being retrieved, the RP's finer-grained signals
select the guidance: `no_request` (no delegation was issued to this agent — check the fingerprint on
`/publish`) or `pending` with `lastRequest` (a request exists and is waiting for wallet approval and
delivery; on timeout, suspect that the wallet callback failed to arrive).

**Key persistence (register once, reuse afterwards).** The key is stored in
`~/.metapass-agent/key.json` (file mode 0600, directory 0700). Re-running reuses the same did:jwk,
so **the agent is not re-registered as a new one every time**. `register` **skips re-registration
automatically** for a URL that is already registered — use `--force` to do it anyway. Change the
path with `--key-file <PATH>` or `METAPASS_AGENT_KEY_FILE`. The private key stays in that store and
is never sent over the network.

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

## Local proxy mode — using this with Claude Code

Claude Code, as an MCP client, supports only a **fixed `Authorization` header**, while a delegation
bearer is short-lived and refreshed. A local proxy bridges the two: the fixed header goes to the
proxy, and the proxy injects the current bearer.

```text
Claude Code ──(fixed header, localhost)──▶ proxy ──(current bearer)──▶ https://…/api/mcp
```

```bash
# 1) Run the proxy in the foreground — it refreshes and injects the session bearer
npx @metadium-did/platform-agent-js proxy --url <BRIEFICK_URL> [--port 8787]

# 2) Register that local proxy with Claude Code as an MCP server (in another terminal)
claude mcp add --transport http briefick http://127.0.0.1:8787/mcp
```

- **Binds 127.0.0.1 only.** Default port **8787** (`--port`); default upstream MCP path `/api/mcp`
  (`--mcp-path`).
- **Transparent forwarding**: method, body, headers and the response stream (**including SSE**) pass
  through unchanged; only `Authorization` is overwritten with the current bearer.
- **Expiry and revocation**: a 401 or refusal from the RP is **passed straight through** — the proxy
  makes no judgement of its own. The bearer keeps refreshing, so the next request carries a new one.
- **Runs in the foreground** (Ctrl+C to stop). Wrap it in `launchd`, `pm2` or similar to keep it
  resident. On first run it retrieves the delegation VC (after wallet approval) and saves it to
  `~/.metapass-agent/key.json`, so a restart does not need approval again.

## Install (as a library)

```bash
npm install @metadium-did/platform-agent-js
```

## Quick start

```ts
import { AgentKey, BriefickAgentClient, AgentAuth } from "@metadium-did/platform-agent-js";

// 1) Agent key — generate once, then persist it so the did:jwk stays the same
const key = await AgentKey.generate();
console.log("this agent's DID:", key.did);       // did:jwk:...  (register this in the Briefick UI)
// fs.writeFileSync("agent-key.json", JSON.stringify(key.exportPrivateJwk()));
// const key = await AgentKey.fromPrivateJwk(JSON.parse(fs.readFileSync("agent-key.json","utf8")));

const client = new BriefickAgentClient({ baseUrl: process.env.BRIEFICK_URL!, key });

// 2) Register — bind with the pairing code the user issued from Briefick /publish (PoP)
await client.register(process.env.PAIRING_CODE!);

// 3) Once the user approves the delegation in their wallet, retrieve the VC (polling)
const credential = await client.waitForDelegation();

// 4) Exchange for a session bearer and keep it refreshed before expiry
const auth = new AgentAuth({
  client,
  credential,
  onRefresh: (bearer) => console.log("new session bearer:", bearer), // push into the fixed MCP header
});
await auth.start();

// 5) From here on, MCP calls always carry a valid bearer
await fetch(process.env.BRIEFICK_URL + "/api/mcp", { headers: auth.authHeader() });
```

## Library API — importing it to get a bearer

The programmatic entry point is **ESM `dist/index.js` with types in `dist/index.d.ts`**. Get a bearer
either from `AgentAuth` (refreshed automatically) or from `AgentClient.exchange` (one-shot).

```ts
import { AgentKey, AgentClient, AgentAuth, loadStore, defaultKeyFile } from "@metadium-did/platform-agent-js";

// Reuse the key and delegation VC the CLI already stored
const store = loadStore(defaultKeyFile())!;
const key = await AgentKey.fromPrivateJwk(store.privateJwk);
const client = new AgentClient({ baseUrl: "https://briefick.cplabs.io", key });
const credential = store.credentials!["https://briefick.cplabs.io"]; // the retrieved, stored delegation VC

// (a) Automatic refresh — bearer() / authHeader()
const auth = new AgentAuth({ client, credential });
await auth.start();
auth.bearer();        // string  — the current session bearer
auth.authHeader();    // { Authorization: "Bearer …" }
auth.stop();

// (b) One-shot exchange
const r = await client.exchange(credential);  // { status:"issued", bearer, expiresAt, scope }
```

### Service-neutral (other RPs)

`AgentClient` takes its endpoint paths and PoP `aud` values **from configuration**, defaulting to the
Briefick contract. For another service, pass `service`:

```ts
new AgentClient({ baseUrl, key, service: {
  registerPath: "/v2/agents/enroll",
  retrievePath: "/v2/agents/delegation",
  sessionStartPath: "/v2/agents/session/start",
  sessionCompletePath: "/v2/agents/session/complete",
  popAudience: { register: "acme-enroll", retrieve: "acme-retrieve", session: "acme-session" },
  mcpPath: "/v2/mcp",
}});
```

`BriefickAgentClient` is an alias for the preset defaults (`=== AgentClient`), kept for backward
compatibility. The holder cryptography (`AgentKey`, `presentVpToken`), `AgentAuth` and `startProxy`
are service-independent.

## The flow (Briefick's default contract)

```text
register   POST /api/agent/register             {didJwk, code, pop(aud=briefick-agent-register)}
retrieve   POST /api/agent/delegation/retrieve  {didJwk, pop(aud=briefick-agent-retrieve)}  → {credential}
session    POST /api/agent/session/start        {didJwk, pop(aud=briefick-agent-session)}   → {state, nonce, responseUri}
           (present the delegation VP to the sso responseUri)  POST {vpToken}
           POST /api/agent/session/complete     {state, didJwk, pop}                        → {bearer, expiresAt, scope}
```

A PoP is an **ES256 JWT signed with the private key of the did:jwk being registered**, scoped by
`aud` and carrying `iat`. Session bearers are short-lived, so `AgentAuth` re-exchanges before expiry.
An MCP client keeps one fixed header and updates only its value, from `onRefresh`.

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
