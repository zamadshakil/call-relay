import { jwtVerify, SignJWT } from "jose";
import { HttpError } from "./http";
import { secretValue } from "./secrets";
import type { DeviceRow, Env, PairingRow, SignalRole } from "./types";

const SIGNAL_AUDIENCE = "call-relay-pairing-signal";
const SIGNAL_PROTOCOL = "call-relay.signal.v1";
const TICKET_PREFIX = "cr-ticket.";
const TICKET_TTL_SECONDS = 60;

export interface VerifiedSignalTicket {
  pairingId: string;
  deviceId: string;
  role: SignalRole;
  jti: string;
  expiresAt: number;
}

async function ticketKey(env: Env): Promise<Uint8Array> {
  const value = await secretValue(env.SIGNAL_TICKET_SECRET, "SIGNAL_TICKET_SECRET");
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < 32) throw new Error("SIGNAL_TICKET_SECRET must contain at least 32 UTF-8 bytes");
  return bytes;
}

export function signalRole(pairing: PairingRow, device: DeviceRow): SignalRole {
  if (pairing.device_a_id !== device.id && pairing.device_b_id !== device.id) {
    throw new HttpError(403, "device is not a member of this pairing");
  }
  return device.platform === "android" ? "android" : "peer";
}

export async function createSignalTicket(
  env: Env,
  pairing: PairingRow,
  device: DeviceRow,
): Promise<{ ticket: string; protocol: string; expiresAt: number; role: SignalRole }> {
  const role = signalRole(pairing, device);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TICKET_TTL_SECONDS;
  const ticket = await new SignJWT({
    pairingId: pairing.id,
    deviceId: device.id,
    role,
    protocolVersion: 1,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setAudience(SIGNAL_AUDIENCE)
    .setSubject(device.id)
    .setJti(crypto.randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(await ticketKey(env));
  return { ticket, protocol: SIGNAL_PROTOCOL, expiresAt: expiresAt * 1000, role };
}

export function signalTicketFromProtocols(header: string | null): string {
  const protocols = (header ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!protocols.includes(SIGNAL_PROTOCOL)) throw new HttpError(400, "unsupported signaling protocol");
  const encoded = protocols.find((value) => value.startsWith(TICKET_PREFIX))?.slice(TICKET_PREFIX.length);
  if (!encoded) throw new HttpError(401, "signaling ticket is missing");
  return encoded;
}

export async function verifySignalTicket(env: Env, encoded: string): Promise<VerifiedSignalTicket> {
  try {
    const { payload } = await jwtVerify(encoded, await ticketKey(env), {
      algorithms: ["HS256"],
      audience: SIGNAL_AUDIENCE,
      clockTolerance: 5,
    });
    if (
      payload.protocolVersion !== 1 ||
      typeof payload.pairingId !== "string" ||
      typeof payload.deviceId !== "string" ||
      (payload.role !== "android" && payload.role !== "peer") ||
      typeof payload.jti !== "string" ||
      typeof payload.exp !== "number" ||
      payload.sub !== payload.deviceId
    ) {
      throw new Error("ticket claims are invalid");
    }
    return {
      pairingId: payload.pairingId,
      deviceId: payload.deviceId,
      role: payload.role,
      jti: payload.jti,
      expiresAt: payload.exp * 1000,
    };
  } catch {
    throw new HttpError(401, "signaling ticket is invalid or expired");
  }
}

export const SIGNALING_PROTOCOL = SIGNAL_PROTOCOL;
