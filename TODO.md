### features

- [x] simple moderation
  - [x] kick
  - [x] ban
  - [x] unban
  - [x] mute
  - [x] unmute
- [ ] group management
  - [x] allow only specific roles to add bot to group
  - [x] copy groups from prod table, fix invite links
  - [ ] create group in backend when the bot joins a new group
  - [ ] create (or update) group in backend when the bot becomes admin of a group
  - [ ] search
- [ ] advanced moderation
  - [ ] ban_all
  - [ ] unban_all
  - [x] audit log
- [ ] automatic moderation
  - [ ] spam check
  - [ ] check spam across different groups (mute + del)
  - [ ] exception to send our whatsapp links?
  - [ ] do not delete Direttivo's allowed messages
  - [x] check if user has username
- [ ] role management
  - [ ] setrole: set role for some username (only Direttivo, maybe HR)
  - [x] getrole: get user role
- [ ] automatic messages in some specific groups (like piano di studi)
- [ ] manage channel for associations
- [x] cron setup (non mandatory)
- [x] crash handling

### unimportant features

- [ ] log channel (maybe redirecting all Pino's messages there)
- [ ] bot aule ???????????????
- [ ] manage actions from admin dashboard (trpc's WebSocket impl)
- [ ] set exceptions on what the bot can do in some specific group

### very very very very unimportant features

- richieste di accesso ai gruppi (chiedi di entrare, stile whatsapp), se richiesta tramite
  bot viene autoapprovato. permette di mandare messaggio a tutti gli utenti. va fatto bene
  note
