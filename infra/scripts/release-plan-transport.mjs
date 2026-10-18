#!/usr/bin/env node
/** Existing saved-plan encryption transport, independent of retired diagnostics. */
import { createHash, createPublicKey, createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt, randomBytes, constants } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
function seal(planPath, manifestPath, publicPath, fingerprint, output) {
  const plan = readFileSync(planPath);
  const manifest = readFileSync(manifestPath);
  if (read(manifestPath).planSha256 !== sha(plan))
    throw new Error("plan_changed");
  const pem = readFileSync(publicPath, "utf8");
  if (!pem.startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("public_key_required");
  const recipient = createPublicKey(pem);
  if (
    recipient.export({ type: "spki", format: "pem" }).toString().trim() !==
    pem.trim()
  )
    throw new Error("public_key_required");
  if (
    recipient.asymmetricKeyType !== "rsa" ||
    recipient.asymmetricKeyDetails.modulusLength < 3072 ||
    sha(recipient.export({ type: "spki", format: "der" })) !== fingerprint
  )
    throw new Error("recipient_mismatch");
  const key = randomBytes(32),
    nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(manifest);
  const ciphertext = Buffer.concat([cipher.update(plan), cipher.final()]);
  const wrapped = publicEncrypt(
    {
      key: recipient,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    key,
  );
  write(output, {
    version: "fss.encrypted-plan.v1",
    algorithm: "RSA-OAEP-SHA256+A256GCM",
    manifestSha256: sha(manifest),
    recipientPublicKeySha256: fingerprint,
    wrappedKey: wrapped.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  key.fill(0);
}
function decrypt(envelopePath, manifestPath, privatePath, output) {
  const packet = read(envelopePath),
    manifest = readFileSync(manifestPath);
  if (
    readFileSync(envelopePath, "utf8") !==
    `${JSON.stringify(packet, null, 2)}\n`
  )
    throw new Error("invalid_envelope");
  if (
    Object.keys(packet).sort().join() !==
      [
        "version",
        "algorithm",
        "manifestSha256",
        "recipientPublicKeySha256",
        "wrappedKey",
        "nonce",
        "tag",
        "ciphertext",
      ]
        .sort()
        .join() ||
    packet.version !== "fss.encrypted-plan.v1" ||
    packet.algorithm !== "RSA-OAEP-SHA256+A256GCM" ||
    packet.manifestSha256 !== sha(manifest)
  )
    throw new Error("envelope_changed");
  const privateKey = readFileSync(privatePath);
  const recipient = createPublicKey(privateKey);
  if (
    sha(recipient.export({ type: "spki", format: "der" })) !==
    packet.recipientPublicKeySha256
  )
    throw new Error("wrong_recipient");
  const key = privateDecrypt(
    {
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(packet.wrappedKey, "base64"),
  );
  const nonce = Buffer.from(packet.nonce, "base64"),
    tag = Buffer.from(packet.tag, "base64");
  if (key.length !== 32 || nonce.length !== 12 || tag.length !== 16)
    throw new Error("invalid_envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(manifest);
  decipher.setAuthTag(tag);
  const plan = Buffer.concat([
    decipher.update(Buffer.from(packet.ciphertext, "base64")),
    decipher.final(),
  ]);
  if (sha(plan) !== read(manifestPath).planSha256)
    throw new Error("plan_changed");
  writeFileSync(output, plan, { mode: 0o600, flag: "wx" });
  key.fill(0);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'seal' && args.length === 5) seal(...args);
    else if (command === 'decrypt' && args.length === 4) decrypt(...args);
    else throw new Error('invalid_command');
  } catch (error) {
    const allowed = ['public_key_required', 'recipient_mismatch', 'plan_changed', 'envelope_changed', 'wrong_recipient', 'invalid_envelope', 'invalid_command'];
    console.error(`diagnostic plan refused: ${allowed.includes(error.message) ? error.message : 'operation_failed'}`);
    process.exitCode = 1;
  }
}
