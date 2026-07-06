# Secure management for sensitive reference lists

This folder contains guidance and tooling to keep the reference lists (アプローチ禁止リスト／既存顧客リスト／SFリードリスト) encrypted when stored or shared.

Principles
- Raw plaintext files under `data/` must NOT be committed.
- Encrypted exports are written to `secure/encrypted/` and may be stored in the repository only if access control is appropriate.
- Decrypted plaintext should only be produced locally and stored temporarily under `secure/plain/` (which is gitignored).

Quick usage

1. Export or place the source files into `data/` (local only).
2. Set the passphrase in environment: `SET LISTS_PASSPHRASE=your-secret` (Windows) or `export LISTS_PASSPHRASE=...` (POSIX).
3. Encrypt matching files:

```bash
npm run encrypt:lists
```

4. To decrypt (locally) and inspect:

```bash
npm run decrypt:lists
```

Security notes
- Do NOT store the passphrase in the repository or in CI logs.
- Prefer a secrets manager (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault) for CI/deployment.
- Consider rotating the passphrase and re-encrypting periodically.
