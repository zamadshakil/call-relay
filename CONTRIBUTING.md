# Contributing

Keep changes focused and preserve the stock-OS constraint. A proposal that requires protected call PCM, root, a modified ROM, SIP/PSTN infrastructure, or external bridge hardware is a different architecture and should be documented as such.

Before submitting a change:

1. Run `scripts/verify.ps1` from the repository root.
2. Do not commit credentials, `.dev.vars`, `google-services.json`, signing keys, local databases, APKs, or generated build directories.
3. Add tests for call-state, authentication, number-validation, or failure-handling changes.
4. State whether the change was exercised on a real cellular call and name the handset/Android build without publishing personal device identifiers.
5. Never weaken emergency-number or multi-call safeguards to make a demo pass.
