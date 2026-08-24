import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function base64urlEncode(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function base64urlDecode(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString();
}

function hmacSign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function hashBinding(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function signPayload(payload: unknown, secret: string): string {
  const encoded = base64urlEncode(JSON.stringify(payload));
  return `${encoded}.${hmacSign(encoded, secret)}`;
}

export function verifyPayload(value: string, secret: string): unknown | null {
  const dotIndex = value.indexOf(".");
  if (dotIndex <= 0 || dotIndex !== value.lastIndexOf(".")) return null;

  const encoded = value.slice(0, dotIndex);
  const signature = value.slice(dotIndex + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return null;
  }

  const expectedSignature = hmacSign(encoded, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    return JSON.parse(base64urlDecode(encoded)) as unknown;
  } catch {
    return null;
  }
}

export interface StatePayload {
  /** Original state from the MCP client */
  s: string;
  /** Original redirect_uri from the MCP client */
  r: string;
  /** SHA-256 binding to the registered proxy client_id */
  c: string;
  /** S256 PKCE challenge forwarded to the upstream authorization server */
  q: string;
  /** Issued-at timestamp in milliseconds */
  t: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;

/**
 * Wraps the client's state and redirect_uri into an HMAC-signed string.
 * Format: <base64url_payload>.<hmac_signature>
 */
export function wrapState(
  originalState: string,
  originalRedirectUri: string,
  clientId: string,
  codeChallenge: string,
  secret: string,
  now = Date.now()
): string {
  return signPayload(
    {
      s: originalState,
      r: originalRedirectUri,
      c: hashBinding(clientId),
      q: codeChallenge,
      t: now,
    } satisfies StatePayload,
    secret,
  );
}

/**
 * Verifies the HMAC signature and extracts the original state and redirect_uri.
 * Returns null if the signature is invalid or the payload is malformed.
 */
export function unwrapState(
  wrappedState: string,
  secret: string,
  now = Date.now()
): StatePayload | null {
  const payload = verifyPayload(wrappedState, secret);
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const candidate = payload as Partial<StatePayload>;
  if (
    typeof candidate.s !== "string" ||
    typeof candidate.r !== "string" ||
    typeof candidate.c !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.c) ||
    typeof candidate.q !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.q) ||
    typeof candidate.t !== "number" ||
    !Number.isSafeInteger(candidate.t) ||
    candidate.t > now + CLOCK_SKEW_MS ||
    now - candidate.t > STATE_TTL_MS
  ) {
    return null;
  }

  return candidate as StatePayload;
}
