declare namespace Cloudflare {
  interface Env {
    ENROLLMENT_INVITE: string;
    CF_TURN_KEY_ID: string;
    CF_TURN_API_TOKEN: string;
    SIGNAL_TICKET_SECRET: string;
    FCM_CLIENT_EMAIL: string;
    FCM_PRIVATE_KEY: string;
    FIREBASE_PROJECT_ID: string;
    ACCESS_MODE: "paid" | "approval_only";
    ONBOARDING_V2_ENABLED: string;
    MIN_ANDROID_APP_VERSION: string;
    PUBLIC_APP_URL: string;
    PADDLE_ENVIRONMENT: string;
    PADDLE_MONTHLY_PRICE_ID: string;
    PADDLE_ANNUAL_PRICE_ID: string;
    PADDLE_API_KEY: string;
    PADDLE_WEBHOOK_SECRET: string;
    SIM_PROFILE_ENCRYPTION_KEY: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
