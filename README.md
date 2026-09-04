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

The campaign guard detects the short Han-script recruitment messages currently sent across the network. It uses
normalized message signatures, Telegram mentions, inline-bot metadata, button domains, recent joins, and repetition
across distinct authors and chats. It never bans on language or profile metadata alone.

Set `CAMPAIGN_SPAM_MODE` to control the rollout:

- `off` keeps the existing moderation behavior. This is the default.
- `observe` records decisions and keeps the existing non-Latin rule active.
- `quarantine` replaces the broad non-Latin rule and mutes high-signal matches for review.
- `enforce` also starts BanAll for confirmed indicators and cross-account bursts.

In `enforce` mode, the guard learns a signature after three distinct authors send it in two chats within ten minutes.
The thresholds and window have environment overrides. Redis retains hashed signatures, handles, button domains,
display-name fingerprints, and campaign user IDs for 30 days. Raw message retention does not change.

Known indicators use JSON arrays:

```env
CAMPAIGN_SPAM_CONFIRMED_SIGNATURES_JSON=["known message @replaceable_handle"]
CAMPAIGN_SPAM_DENIED_HANDLES_JSON=["known_bad_handle"]
CAMPAIGN_SPAM_DENIED_BUTTON_DOMAINS_JSON=["bad.example"]
CAMPAIGN_SPAM_DENIED_VIA_BOT_IDS_JSON=[123456789]
```

Only add administrator-reviewed indicators. A denied handle causes quarantine, not BanAll, unless another confirmed
signal is present.

Set `CAMPAIGN_SPAM_JOIN_GATE=true` only after every managed group uses join requests and the bot has
`can_invite_users` and `can_restrict_members`. In `quarantine` or `enforce` mode, the bot approves unknown requests
with text-only permissions. It restores normal permissions after the first allowed message. In `enforce` mode, it
declines exact campaign user IDs and display-name fingerprints repeated by three confirmed campaign accounts.
