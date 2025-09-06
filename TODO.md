# TODO

## features

- [x] simple moderation
  - [x] kick
  - [x] ban
  - [x] unban
  - [x] mute
  - [x] unmute
- [x] group management
  - [x] allow only specific roles to add bot to group
  - [x] copy groups from prod table, fix invite links
  - [x] create (or update) group in backend when the bot becomes admin of a group
  - [x] delete group from backend when the bot leaves a group
  - [x] search
- [ ] advanced moderation
  - [ ] ban_all
  - [ ] unban_all
  - [x] audit log
  - [ ] @admin (and similar) to allow user to report
  - [x] track ban, mute and kick done via telegram UI (not by command)
- [ ] automatic moderation
  - [x] delete non-latin alphabet characters 
  - [x] check spam links
  - [x] check harmful messages
  - [x] check spam across different groups (mute + del)
  - [ ] exception to send our whatsapp links?
  - [ ] do not delete Direttivo's allowed messages
  - [x] check if user has username
  - [ ] group-specific moderation (eg. #cerco #vendo in polihouse)
- [ ] role management
  - [ ] setrole: set role for some username (only Direttivo, maybe HR)
  - [x] getrole: get user role
- [ ] automatic messages in some specific groups (like piano di studi)
- [ ] manage channel for associations
- [x] cron setup (non mandatory)
- [x] crash handling
- [ ] backfill mod actions done with previous bot(s)
- [x] log channel (note: not all logs go there)

## unimportant features

- [ ] bot aule ???????????????
- [ ] manage actions from admin dashboard (trpc's WebSocket impl)
- [ ] set exceptions on what the bot can do in some specific group

### very very very very unimportant features

- richieste di accesso ai gruppi (chiedi di entrare, stile whatsapp), se richiesta tramite
  bot viene autoapprovato. permette di mandare messaggio a tutti gli utenti. va fatto bene
  note
