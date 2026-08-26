# Worker secrets

Required encrypted Worker secrets:

- `CF_TURN_KEY_ID`
- `CF_TURN_API_TOKEN`
- `SIGNAL_TICKET_SECRET` (at least 32 random bytes)
- `ENROLLMENT_INVITE`
- `FCM_CLIENT_EMAIL`
- `FCM_PRIVATE_KEY`

Prepare an ignored aggregate upload without printing values:

```powershell
pnpm secrets:prepare -- --firebase "C:\secure\firebase-service-account.json" --turn "C:\secure\turn-keys.txt"
pnpm providers:validate -- --firebase "C:\secure\firebase-service-account.json" --turn "C:\secure\turn-keys.txt"
pnpm exec wrangler deploy --secrets-file .\.secrets.production.json
pnpm exec wrangler secret list
```

The TURN file contains `CF_TURN_KEY_ID=...` and `CF_TURN_API_TOKEN=...`. The preparation script creates ignored enrollment and signaling secrets if absent. Delete only `.secrets.production.json` after successful deployment; retain the generated secret source files securely for recovery.

For the first staging deployment, use a separate staging TURN key and separate generated invite/ticket files, then pass the aggregate file directly to `wrangler deploy --env staging --secrets-file ...`. A new Worker cannot receive secrets with `secret bulk` before its first deployment.

Never commit or print these values. Per-Worker secrets are used because the Firebase PKCS#8 key commonly exceeds Secrets Store's smaller item limit.
