const RESTRICTION_UNITS = { m: 60, h: 3_600, d: 86_400, w: 604_800 } as const

// Telegram treats restrictions of 366 days or longer as permanent. Keep the
// validator aligned with duration.zod, which enforces the same strict bound.
export const TELEGRAM_MAX_TEMPORARY_RESTRICTION_SECONDS = 366 * RESTRICTION_UNITS.d - 1

/** Accepts only explicit nonzero durations that Telegram will not interpret as permanent. */
export function isTemporaryTelegramRestrictionDuration(value: string): boolean {
  const match = /^([1-9]\d*)([mhdw])$/.exec(value)
  if (!match) return false
  const amount = Number(match[1])
  const unit = match[2] as keyof typeof RESTRICTION_UNITS
  const seconds = amount * RESTRICTION_UNITS[unit]
  return Number.isSafeInteger(seconds) && seconds >= 30 && seconds <= TELEGRAM_MAX_TEMPORARY_RESTRICTION_SECONDS
}
