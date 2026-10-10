# telegram

Our new telegram bot.

## Quick start

1. run Redis instance locally with docker:

   ```sh
   docker run -p 6379:6379 --name pn-tg-redis -d redis
   ```

2. install dependencies

   ```sh
   pnpm install
   ```

3. run
   ```sh
   pnpm run dev
   ```

### Maybe useful references
- [How to send private messages](https://github.com/PoliNetworkOrg/PoliNetworkBot_CSharp/blob/03c7434f06323ffdec301cb105d1d3b2c1ed4a95/PoliNetworkBot_CSharp/Code/Utils/SendMessage.cs#L90)

## Campaign spam protection

The campaign guard detects the short recruitment and fraud campaigns currently sent across the network. It uses
normalized message signatures, a narrow lure lexicon, Telegram mentions and links, contact-card names, inline-bot
metadata, URL domains, recent joins, and repetition across distinct authors and chats. It never bans on language,
an undocumented Telegram user-ID cutoff, a phone prefix, or profile metadata alone.

Protection and the first-post join gate are always active; no feature-specific environment variables are needed.
The guard replaces the broad non-Latin rule. It mutes uncertain matches for moderator review and starts BanAll for
confirmed campaigns. Thresholds are defined in `src/middlewares/campaign-spam/runtime-config.ts`.

The guard learns a signature after either three distinct authors send it in two chats within ten minutes, or four
distinct authors send it in two chats within four hours. The
slow tier keeps one-chat repetition below BanAll to avoid treating a copied local notice as a network campaign. Redis
retains hashed signatures, handles, URL domains, contact phone numbers, display-name fingerprints, and campaign user
IDs for 30 days. Raw message retention does not change.

High-precision lures such as `收米`, `日入`, `上车吃肉`, `洗资`, `聘群演`, `注册送`, and `两分钟一单` can quarantine a
Han-script message without requiring an `@mention`. Broad terms such as `米`, `学籍`, or `群演` do not match alone.
Contact cards are inspected through their display name and phone number, but the phone is HMAC-protected before any
evidence is stored.

Examples:

- Match and quarantine: `来收米 日入9K`, `上车吃肉🧧`, or a contact named `PG电子来注册送28U`.
- Match on a restricted first post: Han text containing an `@mention`, `t.me` link, or inline button.
- Match and BanAll: the same normalized campaign signature from 4 authors in 2 chats over 4 hours.
- Do not match: `大家好，我是交换生，请问今天的课程在哪个教室？`.
- Do not match: an established member sharing a contact named `王小明`.

Reputation is learned from confirmed campaigns and moderator decisions. The join gate also checks each applicant's
existing BanAll and UnbanAll audit history, so previously banned targets work immediately.

Quarantined messages create an action-required review with `Confirm BanAll` and `Release` buttons. Confirming trains
the signature, account, and display-name reputation. Releasing removes learned reputation and restores permissions.
Unrelated BanAll, unban, and unmute actions do not alter campaign reputation. Retained evidence includes hashes for
button URLs and domains, mention targets, and inline-bot usernames. Telemetry records the classifier version, actual
join outcomes, first-post catches, and campaign review feedback.

Persisted identifiers use versioned HMAC-SHA-256 fingerprints keyed by the existing bot token. Rotating the bot token
starts a fresh learned-reputation fingerprint space; BanAll audit history still applies. Review callback state is authenticated and encrypted before the menu adapter stores it.

The bot needs `can_invite_users` and `can_restrict_members` in every managed
group. The bot gives ordinary requested and direct joins text-only permissions. An
ordinary first-post restriction lasts for up to seven days and is removed after the first allowed message, so waiting
beyond the freshness window does not bypass first-post review. The gate declines exact campaign user IDs and exact
display-name fingerprints repeated by three confirmed campaign accounts. A partial exact match or a no-username
profile containing several campaign markers stays read-only for moderator review; one benign post and the ordinary
timeout cannot clear that review hold. Review permissions, callback data, pending state, and replay protection share a
bounded 365-day lifecycle. If the review item cannot be delivered, the account falls back to the ordinary first-post
path. Profile metadata alone never triggers an automatic decline.

Console logs use the `[CampaignSpam]` prefix through the existing Pino logger. They report startup, suspicious and
first-post classifications with reasons and cross-chat counts, join decisions and restrictions, first-post releases,
review delivery, local bans, network BanAll starts, moderator decisions, and dependency failures. Identifiers let
operators correlate actions without logging raw message text, contact details, or the fingerprint secret.

## IdP migration (Phase 4b)

The bot uses `@polinetwork/auth-kit` to obtain a cached `client_credentials` token with
`private_key_jwt`. Register a separate `telegram-bot` client in the IdP and link it to the backend
resource. Its scopes are `backend:tg:read`, `backend:tg:ingest`, `backend:tg:groups:sync`,
`backend:tg:audit`, `backend:tg:act-as` and `backend:tg:events`. The IdP stores its public JWKS;
inject the private JWK from the bot's Key Vault as `OAUTH_BOT_PRIVATE_JWK` (JSON with `kid`, `alg`
and private key material). Never put the key in the repository or logs.

Set `IDP_PUBLIC_URL`, `OAUTH_BACKEND_RESOURCE_URI`, `OAUTH_BOT_CLIENT_ID` and
`OAUTH_BOT_PRIVATE_JWK` together. `IDP_INTERNAL_URL` optionally routes token requests inside the
cluster; assertion audiences retain the public token URL. An entirely absent configuration
keeps anonymous calls. A partial configuration fails startup. `BACKEND_URL` continues to be a
host and port, without a URL scheme, matching the existing backend transport.

Each human update gets an isolated actor client (`ctx.backend`, `X-PN-Actor: telegram:<id>`).
Service-only operations, including buffered message/user ingestion, group synchronization,
ban-all execution and audit writes, use `serviceBackend`. Commands running inside grammY
conversations reconstruct the actor client from their sender because conversation state cannot
persist a tRPC client. A batch belongs to one client and cannot mix actors. Backend calls have a
10-second transport timeout; a `401` invalidates the token and retries once. Other errors never
fall back to anonymous transport. The socket authenticates with `auth.token`; a server expiry
disconnect triggers reconnect, and rejected handshakes invalidate the token with retry backoff.

`IDP_DECISIONS=shadow` is the default. It computes both checks, logs `[ACCESS] shadow` differences,
and acts exclusively on the original role decision. Legacy roles and group administrators are
read anonymously; grant interruption also stays on the anonymous legacy path with
`interruptedById`. `/audit` uses the service read path during shadow, so the backend's actor
permission check cannot override the legacy command decision. The backend must keep
`LEGACY_ANONYMOUS=allow` throughout shadow. Grants are read through the backend's migration
helper, which includes active grants from both tables. An IdP lookup failure is logged and never
changes a successful shadow decision.

After comparing differences for roughly a week and reconciling roles and Telegram links, set
`IDP_DECISIONS=enforce` to apply IdP permissions. An unavailable actor check denies actions;
native chat administrators retain the documented chat-local shortcut. Immunity applies to every
ban-all entry point at enqueue; jobs already accepted continue without permission rechecks.
`/getroles` lists the legacy roles until enforcement, then the IdP permissions. `/addrole`,
`/delrole`, `/link` and the unregistered test commands remain in this transitional source tree;
remove them and the legacy role/group-admin checks in the coordinated cleanup before setting
`LEGACY_ANONYMOUS=deny`.
Switching the mode alone does not remove those legacy commands.

Moderation audit records use `tg.auditLog.record` and a Redis outbox with stable idempotency keys,
actor IDs and the basis (`idp_permission`, `telegram_chat_admin`, `automatic`, `telegram_ui`).
Automatic actions have no human actor. During shadow, a legacy role pass uses the permission
path basis; the backend flags cases where the snapshot does not back that claim for review.
Redis hashes and a due-time sorted set are changed atomically. Backend outages retry with capped
exponential backoff; permanent input errors move to `audit-outbox:dead` for inspection. Enable
Redis AOF, use persistent storage and a non-evicting policy for the audit data. Shutdown keeps
Redis alive until the runner, buffered storage and module workers stop. If Redis cannot store a
record, the bot attempts direct delivery; if both systems fail the full record is logged as lost.
This fallback is best effort: durability requires functioning persistent Redis, and a crash
between a Telegram action and its outbox write can still lose that action's audit record. Ban-all
token-authenticated flow creation persists audit recovery data atomically with the job. Audit delivery starts only
after a confirmed insertion; caller retries and the resumed orchestrator deliver the same key,
so a crash in between is recovered without duplicate history. Older jobs without this recovery
data keep their original behavior. Anonymous flows record once and do not replay because the
legacy audit endpoint has no idempotency support.

Grant socket messages accept both the legacy `adminId` and the new `{ sub, telegramId,
displayName }` actor. A dashboard user without a linked Telegram account can therefore be shown
by display name in the grants topic.

Deploy the Phase 3 backend API/SDK before enabling these variables. Validate token acquisition,
service-only ingestion, actor isolation, socket expiry/reconnect, audit retry/deduplication and
shadow differences in a test environment. Unit tests do not verify real IdP, Telegram or Key
Vault connectivity. Roll back the bot image/configuration while keeping backend anonymous
compatibility enabled; keep Redis persistence so pending audits survive a rollback/restart.
