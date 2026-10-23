import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { StoreError } from "./errors.js";

const ITERATIONS = 4_096;
const SALT_BYTES = 16;
// SASLprep leaves printable ASCII unchanged, so a verifier built from such a
// password is the one Postgres builds itself. Anything wider would need
// SASLprep here too, and is refused instead.
const PRINTABLE_ASCII = /^[\x21-\x7E]{1,1024}$/;

/**
 * The exact shape scramVerifier produces: 4096 iterations, a 16-byte salt and
 * two 32-byte keys, all standard base64. Its alphabet has no quote,
 * backslash, space or semicolon, which is what lets a verifier sit inside a
 * SQL string literal.
 */
export const SCRAM_VERIFIER = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;

// The only roles the ops scripts set a password for. A role name is an
// identifier in the SQL text, so it is matched exactly, never quoted.
const PASSWORD_ROLES = ["vasal_app", "vasal_owner"] as const;
export type PasswordRole = (typeof PASSWORD_ROLES)[number];

const hmac = (key: Buffer, text: string): Buffer => createHmac("sha256", key).update(text).digest();

/**
 * Builds a Postgres SCRAM-SHA-256 password verifier locally, so the password
 * itself never reaches the server or its statement log:
 * `SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>`, where the salted
 * password is PBKDF2-SHA256 at 4096 iterations, ClientKey is HMAC(salted,
 * "Client Key"), StoredKey is SHA256(ClientKey) and ServerKey is HMAC(salted,
 * "Server Key"). The salt is 16 random bytes unless one is given. Throws
 * StoreError("STORE_BAD_INPUT") for a password that is not 1 to 1024
 * printable ASCII characters or a salt that is not 16 bytes; the message
 * never holds either.
 */
export function scramVerifier(password: string, salt: Uint8Array = randomBytes(SALT_BYTES)): string {
  if (typeof password !== "string" || !PRINTABLE_ASCII.test(password)) throw new StoreError("STORE_BAD_INPUT");
  if (!(salt instanceof Uint8Array) || salt.byteLength !== SALT_BYTES) throw new StoreError("STORE_BAD_INPUT");
  const salted = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest();
  const serverKey = hmac(salted, "Server Key");
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  return `SCRAM-SHA-256$${ITERATIONS}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

/**
 * The one statement that sets a role's password: ALTER ROLE <role> PASSWORD
 * '<verifier>'. Postgres takes no bound parameter in ALTER ROLE, so this is
 * the single place a value enters SQL text, and only after the role matches
 * one of PASSWORD_ROLES exactly and the verifier matches SCRAM_VERIFIER.
 * Throws StoreError("STORE_BAD_INPUT") otherwise; the message never holds
 * either value.
 */
export function rolePasswordSql(role: PasswordRole, verifier: string): string {
  if (!(PASSWORD_ROLES as readonly string[]).includes(role)) throw new StoreError("STORE_BAD_INPUT");
  if (typeof verifier !== "string" || !SCRAM_VERIFIER.test(verifier)) throw new StoreError("STORE_BAD_INPUT");
  return `ALTER ROLE ${role} PASSWORD '${verifier}'`;
}
