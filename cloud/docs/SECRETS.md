# Production secrets

Production uses encrypted per-Worker secrets. The five required names are declared in `wrangler.jsonc`, which allows Wrangler to reject a deployment when one is missing:

- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `ENROLLMENT_INVITE`
- `FCM_CLIENT_EMAIL`
- `FCM_PRIVATE_KEY`

For the first deployment, create an ignored `.secrets.production.json` containing all five values and upload it atomically:

```powershell
pnpm build
pnpm exec wrangler deploy --secrets-file .\.secrets.production.json
pnpm exec wrangler secret list
```

The complete guide includes protected PowerShell prompts that construct this file without printing the credentials. Delete only `.secrets.production.json` immediately after the deployment and `/health` check succeed.

For later Firebase-key rotation, load the downloaded service-account JSON without printing its credentials:

```powershell
$firebaseCredentialPath = "C:\secure\call-relay-firebase-service-account.json"
$firebaseCredential = Get-Content -Raw -LiteralPath $firebaseCredentialPath | ConvertFrom-Json
$firebaseCredential.private_key | pnpm exec wrangler secret put FCM_PRIVATE_KEY
Remove-Variable firebaseCredential
```

Do not commit the service-account JSON. Secure or remove the downloaded key after confirming deployment, and revoke it immediately if it is exposed.

Cloudflare Secrets Store is intentionally not used for `FCM_PRIVATE_KEY`: Secrets Store currently limits each account secret to 1024 bytes, while an RSA PKCS#8 Firebase private key commonly exceeds that. Per-Worker secrets support values up to 5 KB and are compatible with the Worker's existing secret loader.

Use `pnpm exec wrangler secret list` to verify names only. Cloudflare will not reveal stored values. Re-running `wrangler secret put NAME` rotates a value by creating and deploying a new Worker version. See `../../docs/DEPLOYMENT_GUIDE.md` for initial setup and recovery details.
