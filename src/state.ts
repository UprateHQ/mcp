import { createHmac, timingSafeEqual } from "node:crypto";

function base64urlEncode(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function base64urlDecode(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString();
}

function hmacSign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export interface StatePayload {
  /** Original state from the MCP client */
  s: string;
  /** Original redirect_uri from the MCP client */
  r: string;
}

/**
 * Wraps the client's state and redirect_uri into an HMAC-signed string.
 * Format: <base64url_payload>.<hmac_signature>
 */
export function wrapState(
  originalState: string,
  originalRedirectUri: string,
  secret: string
): string {
  const payload: StatePayload = { s: originalState, r: originalRedirectUri };
  const encoded = base64urlEncode(JSON.stringify(payload));
  const signature = hmacSign(encoded, secret);
  return `${encoded}.${signature}`;
}

/**
 * Verifies the HMAC signature and extracts the original state and redirect_uri.
 * Returns null if the signature is invalid or the payload is malformed.
 */
export function unwrapState(
  wrappedState: string,
  secret: string
): StatePayload | null {
  const dotIndex = wrappedState.indexOf(".");
  if (dotIndex === -1) return null;

  const encoded = wrappedState.slice(0, dotIndex);
  const signature = wrappedState.slice(dotIndex + 1);

  const expectedSignature = hmacSign(encoded, secret);

  // Timing-safe comparison to prevent timing attacks
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const json = base64urlDecode(encoded);
    const payload = JSON.parse(json) as StatePayload;
    if (typeof payload.s !== "string" || typeof payload.r !== "string") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
