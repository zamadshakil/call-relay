import type { SecretValue } from "./secrets";

export type Platform = "android" | "browser" | "ios";
export type Direction = "incoming" | "outgoing";
export type RelayMode = "full_duplex" | "listen" | "talk";
export type SignalRole = "android" | "peer";
export type ApprovalStatus = "approved" | "unknown" | "suspended";
export type SubscriptionStatus = "none" | "pending" | "active" | "past_due" | "paused" | "canceled" | "refunded" | "disputed";
export type PlanCode = "monthly" | "annual";
export type CallState =
  | "created"
  | "ringing_peer"
  | "accepted"
  | "dialing_sim"
  | "active"
  | "ending"
  | "ended"
  | "failed";

export type Env = Omit<Cloudflare.Env, "PUSH_QUEUE"> & {
  PUSH_QUEUE: Queue<PushJob>;
  CF_TURN_KEY_ID: SecretValue;
  CF_TURN_API_TOKEN: SecretValue;
  SIGNAL_TICKET_SECRET: SecretValue;
  ENROLLMENT_INVITE: SecretValue;
  FCM_CLIENT_EMAIL?: SecretValue;
  FCM_PRIVATE_KEY?: SecretValue;
  FIREBASE_PROJECT_ID: string;
  ONBOARDING_V2_ENABLED: string;
  MIN_ANDROID_APP_VERSION: string;
  PUBLIC_APP_URL: string;
  PADDLE_ENVIRONMENT: "sandbox" | "production";
  PADDLE_MONTHLY_PRICE_ID: string;
  PADDLE_ANNUAL_PRICE_ID: string;
  PADDLE_API_KEY?: SecretValue;
  PADDLE_WEBHOOK_SECRET?: SecretValue;
  SIM_PROFILE_ENCRYPTION_KEY?: SecretValue;
};

export interface PushJob {
  targetDeviceId: string;
  data: Record<string, string>;
}

export interface DeviceRow {
  id: string;
  platform: Platform;
  display_name: string;
  public_key_spki: string;
  fcm_token: string | null;
  fcm_target_kind: "token" | "fid";
  revoked_at: number | null;
  user_id: string | null;
  agreement_public_key_raw: string | null;
  app_version: number;
}

export interface FirebaseIdentity {
  uid: string;
  email: string;
  emailVerified: true;
  displayName: string | null;
  photoUrl: string | null;
  issuedAt: number;
  authTime: number;
}

export interface AccountContext {
  identity: FirebaseIdentity;
  approvalStatus: ApprovalStatus;
  subscription: SubscriptionRow | null;
}

export interface SubscriptionRow {
  user_id: string;
  paddle_customer_id: string | null;
  paddle_subscription_id: string | null;
  plan_code: PlanCode | null;
  status: SubscriptionStatus;
  current_period_ends_at: number | null;
  cancel_at_period_end: number;
  latest_transaction_id: string | null;
  source_occurred_at: number;
  created_at: number;
  updated_at: number;
}

export interface CallRow {
  id: string;
  pairing_id: string;
  android_device_id: string;
  peer_device_id: string;
  direction: Direction;
  state: CallState;
  phone_number: string | null;
  relay_mode: RelayMode;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  failure_code: string | null;
  version: number;
  last_event_id: string | null;
  request_id: string | null;
  media_transport: "webrtc_p2p";
  ice_policy: "all" | "relay";
  media_connected_at: number | null;
  media_failure_code: string | null;
  selected_candidate_type: "host" | "srflx" | "relay" | null;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnCredentialRow {
  username: string;
  call_id: string;
  device_id: string;
  custom_identifier: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoke_attempts: number;
  last_error: string | null;
}

export interface PairingRow {
  id: string;
  device_a_id: string;
  device_b_id: string;
  secret_commitment: string;
  created_by_device_id: string | null;
  confirmed_by_device_id: string | null;
  confirmed_at: number | null;
  revoked_at: number | null;
  protocol_version: 1 | 2;
  user_id: string | null;
  invitation_id: string | null;
  peer_proof: string | null;
  android_proof: string | null;
}

export interface PushOutboxRow {
  id: string;
  target_device_id: string;
  payload_json: string;
  attempts: number;
}
