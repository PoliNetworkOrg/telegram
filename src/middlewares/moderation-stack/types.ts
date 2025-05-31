import type OpenAI from "openai"

export type ModerationCandidate = OpenAI.Moderations.ModerationMultiModalInput
export type ModerationResult = OpenAI.Moderations.Moderation
export type Category = keyof OpenAI.Moderations.Moderation.CategoryScores

export interface FlaggedCategory {
  category: Category
  score: number
  aboveThreshold: boolean
}
