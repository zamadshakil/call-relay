declare namespace Cloudflare {
  interface Env {
    ENROLLMENT_INVITE: string;
    CF_TURN_KEY_ID: string;
    CF_TURN_API_TOKEN: string;
    SIGNAL_TICKET_SECRET: string;
    FCM_CLIENT_EMAIL: string;
    FCM_PRIVATE_KEY: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
