declare namespace Cloudflare {
  interface Env {
    ENROLLMENT_INVITE: string;
    LIVEKIT_API_KEY: string;
    LIVEKIT_API_SECRET: string;
    FCM_CLIENT_EMAIL: string;
    FCM_PRIVATE_KEY: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
