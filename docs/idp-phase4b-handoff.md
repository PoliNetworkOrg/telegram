# Phase 4b Telegram handoff

Branch: `feat/idp-phase4b-bot`. The working tree contains the completed local implementation;
no commit, staging, push, PR or deployment was performed during continuation.

## Implemented

- OAuth service token with `private_key_jwt` through `@polinetwork/auth-kit`, six bot scopes,
  cached renewal, actor-isolated update clients and `X-PN-Actor`.
- Service clients for buffered ingestion, group synchronization, background jobs and audit.
- Default shadow authorization plus explicit enforcement: commands, callbacks, native chat-admin
  shortcuts, trust/exemptions and target immunity at every ban-all entry point.
- Authenticated socket reconnect, rejected-handshake backoff and shutdown cancellation.
- Grants logging for IdP actors with or without a linked Telegram account.
- Redis Lua audit outbox with durable retries, stable keys, dead-letter handling and confirmed
  ban-all enqueue audit with flow recovery data.
- Configuration/cutover/rollback documentation in README and `.env.example`.

Continuation fixed enforce `/getroles` depending on legacy APIs, shadow IdP failures disrupting
legacy `/getroles`, service fetch header isolation, bounded transport requests, socket shutdown
callbacks, Redis shutdown ordering and audit written before failed flow insertion. Ban-all
recovery reuses a stable key and preserves the original actor/basis; duplicate outbox enqueue
keeps the pending retry schedule. Anonymous flows avoid replay because their legacy audit API
has no idempotency support.

## Verification

Verified on 2026-10-10:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm exec biome check src tests` | Pass, 132 files |
| `pnpm test` | 197 passed, 1 optional Redis integration skipped |
| `pnpm build` | Pass |
| `git diff --check` | Pass |
| `AUDIT_TEST_REDIS_URL=redis://127.0.0.1:36480/14 pnpm exec vitest run tests/audit-outbox-redis.test.ts` | Pass, 1 test |

The Redis integration used a dedicated disposable local Redis 7 container with AOF enabled,
verified the real Lua operations and record survival across client reconnection, and removed
that container afterward. It did not test a Redis server restart or deployed infrastructure.

The unscoped `pnpm check` command fails because the existing Biome configuration includes
assist/linter checks for generated `dist/bot.js` despite excluding it from formatting. Its
initial run also found task formatting issues, which were subsequently fixed. The final full
source/test check above passes; generated-bundle lint/configuration is not fixed in this change.

Tests cover actor isolation, 401 retry boundaries, deployment config, shadow/enforce decision
selection, native-admin fallback, immunity across entry points, socket lifecycle, outbox
retry/deduplication and ban-all queue failure/recovery/anonymous compatibility.

## Deployment and cutover

1. Deploy the Phase 3 backend API before enabling the bot's IdP configuration.
2. Register the separate `telegram-bot` client with its public JWKS and backend resource link.
   Grant `backend:tg:read`, `backend:tg:ingest`, `backend:tg:groups:sync`, `backend:tg:audit`,
   `backend:tg:act-as`, `backend:tg:events`.
3. Inject the private JWK from the bot's Key Vault. Set all four required values together:
   `IDP_PUBLIC_URL`, `OAUTH_BACKEND_RESOURCE_URI`, `OAUTH_BOT_CLIENT_ID`,
   `OAUTH_BOT_PRIVATE_JWK`. Optionally set `IDP_INTERNAL_URL`; assertion identifiers still use
   the public URL. `BACKEND_URL` remains a host/port without a scheme.
4. Require persistent Redis with AOF and a non-evicting policy for the outbox. Begin with
   `IDP_DECISIONS=shadow`, keeping backend `LEGACY_ANONYMOUS=allow`.
5. Validate token acquisition, service ingestion, actor isolation, socket expiry/reconnect,
   audit retry/deduplication and shadow differences in a test environment.
6. Compare shadow decisions for roughly one week and reconcile IdP roles and Telegram links.
   Shadow acts only on legacy decisions; grants interruption uses the anonymous legacy API,
   and `/audit` uses the service API so token actor enforcement cannot change the old result.
7. Set `IDP_DECISIONS=enforce` after reconciliation. Remove `/addrole`, `/delrole`, `/link`,
   unregistered test commands and remaining legacy checks in the coordinated cleanup before
   changing backend `LEGACY_ANONYMOUS=deny`. The env switch itself does not remove those commands.

Rollback requires keeping backend anonymous compatibility enabled and restoring the prior bot
image/configuration. Keep Redis persistence so pending audits survive restarts. Avoid mixing
anonymous and token audit recovery across versions without reviewing the persisted jobs.

## Limitations

Real IdP, backend, Telegram and Key Vault connectivity were not exercised. Production was not
accessed. Backend outages retry durable audit records, but simultaneous Redis/backend failures
can lose a record after a logged direct-delivery failure. A crash between a normal Telegram action
and its outbox write can also lose that audit. Token-authenticated ban-all jobs persist recovery
metadata with the flow and replay idempotently after a crash; anonymous/older jobs retain their
legacy behavior. Shadow legacy permission-path audit entries can be flagged by the backend when
the snapshot does not support the claim.

## Suggested publication text

Conventional Commit:

```text
feat(telegram): add IdP service authentication and shadow authorization
```

PR title:

```text
feat(telegram): implement IdP migration phase 4b
```

Ready PR body:

```markdown
Introduce OAuth service authentication, isolated Telegram actor clients, authenticated sockets
and IdP authorization in shadow/enforce modes. Preserve legacy decisions during shadow, check
commands/menus and ban-all immunity, and record moderation through an idempotent Redis outbox.
Grant logs support dashboard actors without a linked Telegram account.

Ban-all persists audit recovery data with the flow and records only confirmed enqueues. Retry
and resumed orchestration reuse the same key and original actor/basis; anonymous legacy jobs
continue to record once. Documented deployment configuration, cutover, rollback and Redis limits.

Verified typecheck, source/test lint, 197 tests, build and a real local Redis Lua integration.
The optional Redis test is skipped in the default suite. Unscoped pnpm check still includes the
generated bundle under the existing Biome configuration; the complete source/test check passes.
Provisioning and integration with real IdP/backend/Telegram/Key Vault remain deployment tasks.
```
