import { describe, it, expect } from "vitest";
import { systemdActivation } from "../src/install.js";

describe("making a freshly installed binary the running process (Linux)", () => {
  const flat = () => systemdActivation().map((a) => a.join(" "));

  it("🔴 restarts unconditionally — `enable --now` leaves a running unit alone", () => {
    // Measured on pmvm-02 (`[Briefick]`, 2026-10-01): with `enable --now`, installing 0.5.8 over a
    // running 0.5.7 left the old PID serving and sessions reporting cliVersion 0.5.7. The journal
    // showed only "Reloading". Nothing failed — which is the whole problem.
    expect(flat(), "no restart: a running unit keeps the old binary").toContain(
      "--user restart metapass-agent-proxy.service",
    );
    expect(flat().join(" | "), "`enable --now` is back — it does not restart a running unit")
      .not.toContain("enable --now");
  });

  it("🔴 reloads the unit file before acting on it", () => {
    // Without daemon-reload systemd acts on the unit it already has, so a rewritten ExecStart
    // is ignored and the restart relaunches the OLD command line.
    const seq = flat();
    expect(seq[0], "daemon-reload must come first").toBe("--user daemon-reload");
    expect(seq.indexOf("--user daemon-reload")).toBeLessThan(
      seq.findIndex((c) => c.includes("restart")),
    );
  });

  it("enables the unit so it survives a reboot", () => {
    expect(flat().some((c) => c.startsWith("--user enable "))).toBe(true);
  });
});

describe("a key store that can't be read stops the service instead of looping (metapass-saas, #47)", async () => {
  const { EXIT_CONFIG, systemdUnit } = await import("../src/install.js");
  const { exitCodeFor } = await import("../src/cli.js");
  const { KeyStoreUnreadable } = await import("../src/keystore.js");

  it("the CLI exits with the code the unit doesn't restart on", () => {
    const code = exitCodeFor(new KeyStoreUnreadable("x"));
    expect(code).not.toBe(1);
    expect(systemdUnit(["/bin/agent", "up"]), "the unit restarts on the unreadable-store exit")
      .toContain(`RestartPreventExitStatus=${code}`);
    expect(code).toBe(EXIT_CONFIG);
  });

  it("other failures still exit 1, which the unit restarts on", () => {
    expect(exitCodeFor(new Error("network"))).toBe(1);
    expect(systemdUnit(["/bin/agent", "up"])).toContain("Restart=on-failure");
  });
});
