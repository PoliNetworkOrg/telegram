import { createHash, createHmac } from "node:crypto"
import { urlAlphabet } from "nanoid"

/**
 * Cryptographically secure, was it needed? no. was it fun? not really.
 * @param seed the seed to use for generating the id
 * @param size the size of the id in characters, default 16
 * @returns a unique, deterministic id based on the seed
 */
export function nanohash(seed: string, size: number = 16): string {
  const nextBytes = () => {
    const bytes = createHash("sha256").update(seed).digest()
    seed = bytes.toString("base64")
    return bytes
  }
  let bytes = nextBytes()
  let i = 0
  const nextByte = () => {
    if (i >= bytes.length) {
      bytes = nextBytes()
      i = 0
    }
    return bytes[i++]
  }
  const id: string[] = []
  const len = urlAlphabet.length
  // rejection cutoff to avoid bias:
  const threshold = 256 - (256 % len)

  while (id.length < size) {
    const r = nextByte()
    if (r < threshold) {
      id.push(urlAlphabet[r % len])
    }
  }

  return id.join("")
}

/** Returns a deterministic, URL-safe HMAC truncated to the requested length. */
export function keyedHash(seed: string, secret: string, size: number = 24): string {
  if (secret.length === 0) throw new TypeError("keyedHash requires a non-empty secret")
  return createHmac("sha256", secret).update(seed).digest("base64url").slice(0, size)
}
