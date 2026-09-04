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

Set `CAMPAIGN_SPAM_MODE` to control the rollout:

- `off` keeps the existing moderation behavior. This is the default.
- `observe` records decisions and keeps the existing non-Latin rule active.
- `quarantine` replaces the broad non-Latin rule and mutes high-signal matches for review.
- `enforce` also starts BanAll for confirmed indicators and cross-account bursts.

In `enforce` mode, the guard learns a signature after either three distinct authors send it in two chats within ten
minutes, or four distinct authors send it in two chats within four hours. Both tiers have environment overrides. The
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

Known indicators use JSON arrays:

```env
CAMPAIGN_SPAM_CONFIRMED_SIGNATURES_JSON=["known message @replaceable_handle"]
CAMPAIGN_SPAM_DENIED_USER_IDS_JSON=[123456789]
CAMPAIGN_SPAM_DENIED_HANDLES_JSON=["known_bad_handle"]
CAMPAIGN_SPAM_DENIED_BUTTON_DOMAINS_JSON=["bad.example"]
CAMPAIGN_SPAM_DENIED_VIA_BOT_IDS_JSON=[123456789]
```

Only add administrator-reviewed indicators. Seed `CAMPAIGN_SPAM_DENIED_USER_IDS_JSON` with active BanAll targets
before enabling the join gate. The gate also checks each applicant's existing BanAll and UnbanAll audit history, so
previously banned targets work without waiting for the new Redis reputation to learn them. Treat denied handles as
exact infrastructure evidence. A reference can strengthen a quarantine decision, but it never proves that the sender
owns that handle and cannot trigger BanAll by itself.

Quarantined messages create an action-required review with `Confirm BanAll` and `Release` buttons. Confirming trains
the signature, account, and display-name reputation. Releasing removes learned reputation and restores permissions.
Unrelated BanAll, unban, and unmute actions do not alter campaign reputation. Retained evidence includes hashes for
button URLs and domains, mention targets, and inline-bot usernames. Telemetry records the classifier version, actual
join outcomes, first-post catches, and campaign review feedback. A review release temporarily overrides a configured
user ID for 30 days, giving operators time to remove a false positive from the environment list.

Persisted identifiers use versioned HMAC-SHA-256 fingerprints. Set a stable, random
`CAMPAIGN_SPAM_FINGERPRINT_SECRET` before rollout; the bot token is the secure compatibility fallback. The v2 Redis
namespace ignores older unkeyed v1 evidence and lets it expire normally. Changing the secret intentionally starts a
fresh learned-reputation fingerprint space, while configured indicators and BanAll audit history continue to seed
decisions. Review callback state is authenticated and encrypted before the menu adapter stores it.

Set `CAMPAIGN_SPAM_JOIN_GATE=true` only when the bot has `can_invite_users` and `can_restrict_members` in every managed
group. In `quarantine` or `enforce` mode, the bot gives ordinary requested and direct joins text-only permissions. An
ordinary first-post restriction lasts for up to seven days and is removed after the first allowed message, so waiting
beyond the freshness window does not bypass first-post review. In `enforce` mode, the gate declines exact campaign user IDs and exact
display-name fingerprints repeated by three confirmed campaign accounts. A partial exact match or a no-username
profile containing several campaign markers stays read-only for moderator review; one benign post and the ordinary
timeout cannot clear that review hold. Review permissions, callback data, pending state, and replay protection share a
bounded 365-day lifecycle. If the review item cannot be delivered, the account falls back to the ordinary first-post
path. Profile metadata alone never triggers an automatic decline.
