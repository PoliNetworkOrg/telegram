import { z } from "zod/v4"

import { fmtDate } from "./format"

const DURATIONS = ["m", "h", "d", "w"] as const
type DurationUnit = (typeof DURATIONS)[number]
const durationRegex = new RegExp(`(\\d+)[${DURATIONS.join("")}]`)

type Duration = {
  raw: string;
  date: Date;
  timestamp_s: number;
  secondsFromNow: number;
  dateStr: string;
}

const Durations: Record<DurationUnit, number> = {
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
}
const zDuration = z
  .string()
  .regex(durationRegex)
  .transform<Duration>((a) => {
    const parsed = parseInt(a.slice(0, -1)) * Durations[a.slice(-1) as DurationUnit]

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
  fromUntilDate: (until_date: number): Duration => {
    const seconds = until_date - (Date.now() / 1000)
    const date = new Date(until_date * 1000)
    return {
      raw: "custom",
      secondsFromNow: seconds,
      date,
      timestamp_s: until_date,
      dateStr: fmtDate(date)
    }
  }
} as const
