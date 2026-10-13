/**
 * Spec agent-delegation §15: several live delegations at one RP, each a separate daemon route
 * `127.0.0.1:<port>/<alias>/<route>/mcp`. A route is named by the delegation's first scope unless the user renamed it,
 * and a newer delegation on the same route replaces the older one.
 */

/** Separates the RP URL from the route in store keys (`credentials`, `held`). A URL has no `|` unescaped. */
const SEP = "|";

/** Route names are path segments: letters, digits, `.`, `_`, `-`; anything else becomes `-`. */
export function sanitizeRoute(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (s === "" || s === "." || s === "..") return "default";
  return s === "mcp" ? "mcp-route" : s;   // `/<alias>/mcp/mcp` would read as the RP-level path
}

/** The default route of a delegation: its first scope (§15). */
export function defaultRoute(scope: readonly string[] | undefined): string {
  return sanitizeRoute(scope?.[0] ?? "");
}

/** The route a delegation goes to: the user's name for its default route, else the default. */
export function routeFor(scope: readonly string[] | undefined, names: Record<string, string> | undefined): string {
  const d = defaultRoute(scope);
  return names?.[d] ?? d;
}

export function slotKey(url: string, route: string): string {
  return `${url}${SEP}${route}`;
}

/** The routes stored for `url`, from a map keyed by {@link slotKey}. */
export function slotsOf<T>(map: Record<string, T> | undefined, url: string): Array<{ route: string; value: T }> {
  const prefix = url + SEP;
  return Object.entries(map ?? {})
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, value]) => ({ route: k.slice(prefix.length), value }));
}

/**
 * A VC's `scope`: the plain claim (§5.1, new issuance), else a disclosed `scope`. Empty when neither is readable —
 * the VC then goes to the `default` route.
 */
export function vcScope(vc: string): string[] {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const [jwt, ...disclosures] = vc.split("~");
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { scope?: unknown };
    if (Array.isArray(payload.scope)) return strings(payload.scope);
  } catch {
    // fall through to the disclosures
  }
  for (const d of disclosures) {
    if (!d) continue;
    try {
      const arr = JSON.parse(Buffer.from(d, "base64url").toString("utf8")) as unknown[];
      if (Array.isArray(arr) && arr.length === 3 && arr[1] === "scope") return strings(arr[2]);
    } catch {
      // not a disclosure
    }
  }
  return [];
}
