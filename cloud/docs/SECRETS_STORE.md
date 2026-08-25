# Cloudflare Secrets Store production binding

Local development reads `.dev.vars`. Production should bind account-level Secrets Store values so the same LiveKit and FCM credentials can be rotated without placing them in this repository.

1. Log in with Wrangler and create the account store.
2. Create these worker-scoped secrets in that store:
   - `call-relay-livekit-api-key`
   - `call-relay-livekit-api-secret`
   - `call-relay-enrollment-invite`
   - `call-relay-fcm-client-email`
   - `call-relay-fcm-private-key`
3. Add a `secrets_store_secrets` entry to `wrangler.jsonc` for each value, using bindings `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ENROLLMENT_INVITE`, `FCM_CLIENT_EMAIL`, and `FCM_PRIVATE_KEY`.

Example entry:

```jsonc
"secrets_store_secrets": [
  {
    "binding": "LIVEKIT_API_KEY",
    "store_id": "REPLACE_WITH_STORE_ID",
    "secret_name": "call-relay-livekit-api-key"
  }
]
```

Do not commit a real store ID if the repository will be shared outside the account, and never put secret values in `wrangler.jsonc` or shell history. After adding bindings, rerun `pnpm types`, `pnpm check`, and `pnpm exec wrangler deploy --dry-run`.
