/** The IdP permissions the bot checks (RFC v3 §4.1). Services check permissions, never roles. */
export const PERMISSION = {
  /** ban/tban/kick/mute/tmute/unban/unmute in any network chat; report-menu Kick/Ban */
  moderate: "tg:moderate",
  /** /ban_all, /unban_all, report-menu "Start BAN ALL", campaign review Confirm/Release */
  moderateGlobal: "tg:moderate:global",
  /** /del, report-menu Del */
  messagesDelete: "tg:messages:delete",
  /** /pin, /unpin */
  messagesPin: "tg:messages:pin",
  /** Ban-all target immunity, campaign-spam exemption. Implies `tg:trusted`. */
  immune: "tg:immune",
  /** Message trust (auto-moderation whitelist), hashtag-rule exemption */
  trusted: "tg:trusted",
  /** /audit */
  auditRead: "tg:audit:read",
  /** /userid, /getroles */
  usersRead: "tg:users:read",
  /** /updategroup, /regenerate_group_links */
  groupsManage: "tg:groups:manage",
  /** Adding the bot to a group */
  botAdd: "tg:bot:add",
  /** Grants menu: delete log message; interrupting is checked by the backend */
  grantsManage: "tg:grants:manage",
} as const

export type Permission = (typeof PERMISSION)[keyof typeof PERMISSION]
