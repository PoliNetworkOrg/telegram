import { z } from "zod/v4"

import { fmtDate } from "./format"

const DURATIONS = ["m", "h", "d", "w"] as const
type Duration = (typeof DURATIONS)[number]
const durationRegex = new RegExp(`(\\d+)[${DURATIONS.join("")}]`)

const Durations: Record<Duration, number> = {
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
}
const zDuration = z
  .string()
  .regex(durationRegex)
  .transform((a) => {
    const parsed = parseInt(a.slice(0, -1), 10) * Durations[a.slice(-1) as Duration]

    const date = new Date(Date.now() + parsed * 1000)
    const timestamp_s = Math.floor(date.getTime() / 1000)
    const dateStr = fmtDate(date)

    return { secondsFromNow: parsed, raw: a, date, timestamp_s, dateStr }
  })
  .refine((a) => a.secondsFromNow < Durations.d * 366, "The maximum duration is 365 days")

export const duration = {
  zod: zDuration,
  values: Durations,
  formatDesc: `Format: <number><unit> where unit can be ${DURATIONS.join(",")}`,
} as const
