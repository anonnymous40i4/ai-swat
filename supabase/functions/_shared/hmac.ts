// HMAC-SHA256 dla kanałów service-to-service Supabase <-> Abacus.
// Format podpisu: hex(HMAC_SHA256(secret, `${unix_seconds}.${raw_body}`)).

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySwarmHmac(
  req: Request,
  rawBody: string,
  secret: string,
  maxSkewSeconds = 300,
): Promise<boolean> {
  const timestamp = req.headers.get("x-swarm-timestamp");
  const signature = req.headers.get("x-swarm-signature");
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (skew > maxSkewSeconds) return false;
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return timingSafeEqualHex(expected, signature.toLowerCase());
}
