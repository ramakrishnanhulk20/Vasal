// Covers the SCRAM-SHA-256 verifier and the one ALTER ROLE statement built
// from it: the format, the RFC 7677 example, a full handshake run by pg's own
// SCRAM client against the verifier, and Postgres (PGlite) storing it as a
// verifier rather than hashing it again. It does not log in over a network,
// because PGlite has no password authentication.
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { StoreError } from "../src/store/errors.js";
import { rolePasswordSql, SCRAM_VERIFIER, scramVerifier } from "../src/store/scram.js";

const HEX_PASSWORD = "0123456789abcdef".repeat(4);
const SALT = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

type ScramSession = { clientNonce: string; response: string };
type Sasl = {
  startSession(mechanisms: string[]): ScramSession;
  continueSession(session: ScramSession, password: string, serverData: string): Promise<void>;
  finalizeSession(session: ScramSession, serverData: string): void;
};
const sasl = createRequire(import.meta.url)("pg/lib/crypto/sasl.js") as Sasl;

function partsOf(verifier: string): { salt: string; storedKey: Buffer; serverKey: Buffer } {
  const match = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (match === null) throw new Error("not a verifier");
  return { salt: match[1]!, storedKey: Buffer.from(match[2]!, "base64"), serverKey: Buffer.from(match[3]!, "base64") };
}

const hmac = (key: Buffer, text: string) => createHmac("sha256", key).update(text).digest();

// The server's half of SCRAM (RFC 5802): recover ClientKey from the proof and
// check it hashes to StoredKey, then sign with ServerKey for the client.
function proofHolds(storedKey: Buffer, authMessage: string, proof: Buffer): boolean {
  const signature = hmac(storedKey, authMessage);
  const clientKey = Buffer.from(proof.map((byte, i) => byte ^ (signature[i] ?? 0)));
  return createHash("sha256").update(clientKey).digest().equals(storedKey);
}

async function pgClientHandshake(verifier: string, password: string): Promise<{ proofOk: boolean; serverTrusted: boolean }> {
  const { salt, storedKey, serverKey } = partsOf(verifier);
  const session = sasl.startSession(["SCRAM-SHA-256"]);
  const nonce = `${session.clientNonce}c2VydmVyLW5vbmNl`;
  const serverFirst = `r=${nonce},s=${salt},i=4096`;
  await sasl.continueSession(session, password, serverFirst);
  const [withoutProof, proof] = session.response.split(",p=");
  const authMessage = `n=*,r=${session.clientNonce},${serverFirst},${withoutProof}`;
  const proofOk = proofHolds(storedKey, authMessage, Buffer.from(proof ?? "", "base64"));
  let serverTrusted = true;
  try {
    sasl.finalizeSession(session, `v=${hmac(serverKey, authMessage).toString("base64")}`);
  } catch {
    serverTrusted = false;
  }
  return { proofOk, serverTrusted };
}

describe("scramVerifier", () => {
  it("has the Postgres verifier format: 4096 iterations, a 16-byte salt and two 32-byte keys", () => {
    const verifier = scramVerifier(HEX_PASSWORD);
    expect(verifier).toMatch(SCRAM_VERIFIER);
    const { salt, storedKey, serverKey } = partsOf(verifier);
    expect(Buffer.from(salt, "base64")).toHaveLength(16);
    expect(storedKey).toHaveLength(32);
    expect(serverKey).toHaveLength(32);
    expect(verifier).not.toContain(HEX_PASSWORD);
  });

  it("is deterministic for an injected salt and uses a fresh random salt otherwise", () => {
    expect(scramVerifier(HEX_PASSWORD, SALT)).toBe(scramVerifier(HEX_PASSWORD, SALT));
    expect(scramVerifier(HEX_PASSWORD, SALT).startsWith(`SCRAM-SHA-256$4096:${SALT.toString("base64")}$`)).toBe(true);
    expect(scramVerifier(HEX_PASSWORD)).not.toBe(scramVerifier(HEX_PASSWORD));
    expect(scramVerifier(HEX_PASSWORD, SALT)).not.toBe(scramVerifier("f".repeat(64), SALT));
  });

  it("matches the RFC 7677 SCRAM-SHA-256 example", () => {
    const { storedKey, serverKey } = partsOf(scramVerifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64")));
    const nonce = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
    expect(proofHolds(storedKey, authMessage, Buffer.from("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=", "base64"))).toBe(true);
    expect(hmac(serverKey, authMessage).toString("base64")).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
  });

  it("lets pg's own SCRAM client log in with the right password and only that one", async () => {
    const verifier = scramVerifier(HEX_PASSWORD);
    expect(await pgClientHandshake(verifier, HEX_PASSWORD)).toEqual({ proofOk: true, serverTrusted: true });
    expect((await pgClientHandshake(verifier, "f".repeat(64))).proofOk).toBe(false);
  });

  it("refuses a password outside printable ASCII and a salt that is not 16 bytes", () => {
    for (const password of ["", "has space", "café", "tab\there", "x".repeat(1025)]) {
      expect(() => scramVerifier(password), password).toThrow(StoreError);
    }
    expect(() => scramVerifier(HEX_PASSWORD, Buffer.alloc(15))).toThrow(StoreError);
    expect(() => scramVerifier(HEX_PASSWORD, Buffer.alloc(17))).toThrow(StoreError);
  });
});

describe("rolePasswordSql", () => {
  it("builds the one ALTER ROLE statement for a known role", () => {
    const verifier = scramVerifier(HEX_PASSWORD, SALT);
    expect(rolePasswordSql("vasal_app", verifier)).toBe(`ALTER ROLE vasal_app PASSWORD '${verifier}'`);
    expect(rolePasswordSql("vasal_owner", verifier)).toBe(`ALTER ROLE vasal_owner PASSWORD '${verifier}'`);
  });

  it("refuses a verifier with a quote or anything else outside the strict shape", () => {
    const verifier = scramVerifier(HEX_PASSWORD, SALT);
    for (const bad of [
      `${verifier}'`,
      `${verifier}'; DROP ROLE postgres; --`,
      `${verifier.slice(0, 30)}'${verifier.slice(31)}`,
      `'${verifier.slice(1)}`,
      `${verifier}\n`,
      verifier.replace("$4096:", "$1:"),
      HEX_PASSWORD,
      "",
    ]) {
      expect(() => rolePasswordSql("vasal_app", bad)).toThrow(StoreError);
    }
  });

  it("refuses any role but vasal_app and vasal_owner", () => {
    const verifier = scramVerifier(HEX_PASSWORD, SALT);
    for (const role of ["postgres", "vasal_app; DROP ROLE x", "VASAL_APP", ""]) {
      expect(() => rolePasswordSql(role as never, verifier)).toThrow(StoreError);
    }
  });
});

describe("Postgres reading the verifier", () => {
  let pg: PGlite | undefined;

  afterEach(async () => {
    await pg?.close();
  });

  it("stores it unchanged, so it was read as a SCRAM verifier and not hashed again", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    pg = await PGlite.create();
    await pg.query("CREATE ROLE vasal_app WITH LOGIN");
    const verifier = scramVerifier(HEX_PASSWORD);

    await pg.query(rolePasswordSql("vasal_app", verifier));

    const { rows } = await pg.query<{ rolpassword: string }>("SELECT rolpassword FROM pg_authid WHERE rolname = 'vasal_app'");
    expect(rows[0]?.rolpassword).toBe(verifier);
  });
});
