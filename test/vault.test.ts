import { describe, it, expect, vi } from "vitest";
import { createVault, type Run, type RunResult } from "../src/auth/vault";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "err"): RunResult => ({ code: 1, stdout: "", stderr });

describe("SecretVault — OS-native at-rest with a universal plaintext floor", () => {
  it("darwin: seals into the Keychain (no secret in the file) and round-trips", async () => {
    const store = new Map<string, string>();
    const run: Run = vi.fn(async (cmd, args, opts) => {
      expect(cmd).toBe("security");
      if (args[0] === "add-generic-password") {
        // Account is the -a value; secret is the -w value.
        const acct = args[args.indexOf("-a") + 1];
        const secret = args[args.indexOf("-w") + 1];
        store.set(acct, secret);
        return ok();
      }
      if (args[0] === "find-generic-password")
        return ok((store.get(args[args.indexOf("-a") + 1]) ?? "") + "\n");
      if (args[0] === "delete-generic-password") {
        store.delete(args[args.indexOf("-a") + 1]);
        return ok();
      }
      return fail();
    });
    const v = createVault("darwin", run);
    expect(v.scheme()).toBe("keychain");
    const env = await v.seal("cid-1", "RT-secret");
    expect(env.startsWith("keychain:1:")).toBe(true);
    expect(env).not.toContain("RT-secret");          // secret NOT in the envelope
    expect(await v.open(env)).toBe("RT-secret");
    await v.clear(env);
    expect(await v.open(env)).toBeNull();             // gone => honest signed-out
  });

  it("win32: DPAPI-encrypts the blob into the file and round-trips", async () => {
    // Model ProtectedData as reversible base64 wrapping; secret arrives via env,
    // never argv.
    // Model ProtectedData as base64 (reversible, non-identity — so the
    // "no plaintext in the envelope" rule is actually testable).
    const run: Run = vi.fn(async (cmd, _args, opts) => {
      expect(/powershell|pwsh/i.test(cmd)).toBe(true);
      const script = _args.join(" ");
      const inp = opts?.env?.VIBE_ADS_SECRET ?? "";
      // PS_UNPROTECT runs FromBase64String first, so order matters: a value
      // that is valid base64 is treated as ciphertext to decrypt.
      if (/Unprotect/.test(script)) {
        try { return ok(Buffer.from(inp, "base64").toString("utf8") + "\n"); }
        catch { return fail(); }
      }
      if (/Protect/.test(script))
        return ok(Buffer.from(inp, "utf8").toString("base64") + "\n");
      return fail();
    });
    const v = createVault("win32", run);
    expect(v.scheme()).toBe("dpapi");
    const env = await v.seal("cid-2", "RT-win");
    expect(env.startsWith("dpapi:1:")).toBe(true);
    expect(env).not.toContain("RT-win");              // ciphertext only
    expect(await v.open(env)).toBe("RT-win");
  });

  it("linux: secret-tool via stdin (no argv leak); round-trips", async () => {
    const store = new Map<string, string>();
    const run: Run = vi.fn(async (cmd, args, opts) => {
      expect(cmd).toBe("secret-tool");
      const acct = args[args.indexOf("account") + 1];
      if (args[0] === "store") {
        expect(opts?.input).toBe("RT-lin");           // secret on stdin, not argv
        store.set(acct, opts!.input!);
        return ok();
      }
      if (args[0] === "lookup")
        return store.has(acct) ? ok(store.get(acct)!) : fail();
      if (args[0] === "clear") { store.delete(acct); return ok(); }
      return fail();
    });
    const v = createVault("linux", run);
    const env = await v.seal("cid-3", "RT-lin");
    expect(env.startsWith("libsecret:1:")).toBe(true);
    expect(env).not.toContain("RT-lin");
    expect(await v.open(env)).toBe("RT-lin");
  });

  it("linux without a Secret Service: falls straight through to the plaintext floor", async () => {
    const run: Run = vi.fn(async () => fail("No such service"));
    const v = createVault("linux", run);
    const env = await v.seal("cid-4", "RT-floor");
    expect(env).toBe("plain:1:RT-floor");
    expect(await v.open(env)).toBe("RT-floor");        // floor still works
  });

  it("any OS tool throwing never escapes: seal degrades to plain", async () => {
    const run: Run = vi.fn(async () => { throw new Error("ENOENT"); });
    for (const p of ["darwin", "win32", "linux"] as const) {
      const v = createVault(p, run);
      const env = await v.seal("cid", "S");
      expect(env).toBe("plain:1:S");
      expect(await v.open(env)).toBe("S");
    }
  });

  it("opening an OS envelope whose entry was wiped externally => null, not throw", async () => {
    const run: Run = vi.fn(async (_c, args) =>
      args[0] === "find-generic-password" || args[0] === "lookup"
        ? fail() : ok());
    expect(await createVault("darwin", run).open("keychain:1:gone")).toBeNull();
    expect(await createVault("linux", run).open("libsecret:1:gone")).toBeNull();
  });

  it("plain envelopes need no exec at all (works with a throwing runner)", async () => {
    const run: Run = vi.fn(async () => { throw new Error("must not be called"); });
    const v = createVault("linux", run);
    expect(await v.open("plain:1:abc")).toBe("abc");
    await v.clear("plain:1:abc");                      // no-op, no exec
    expect(run).not.toHaveBeenCalled();
  });

  it("unknown/garbage envelope => null (forward/back-compat safe)", async () => {
    const v = createVault("linux", vi.fn(async () => ok()));
    expect(await v.open("")).toBeNull();
    expect(await v.open("bogus")).toBeNull();
    expect(await v.open("future:9:xyz")).toBeNull();
  });
});
