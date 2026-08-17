// 크로스검증 헬퍼: 개인JWK+VC+nonce+aud → vp_token(stdout). did:jwk는 stderr.
import { readFileSync } from "node:fs";
import { AgentKey, presentVpToken } from "../dist/index.js";
const [, , privFile, vcFile, nonce, aud] = process.argv;
const priv = JSON.parse(readFileSync(privFile, "utf8"));
const vc = readFileSync(vcFile, "utf8").trim();
const key = await AgentKey.fromPrivateJwk(priv);
process.stderr.write(key.did + "\n");
const vp = await presentVpToken(vc, key, { audience: aud, nonce });
process.stdout.write(vp);
