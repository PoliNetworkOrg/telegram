import type { User } from "grammy/types"
import { logger } from "@/logger"

export type Vote = "inFavor" | "against" | "abstained"
export type Outcome = "approved" | "denied" | "waiting"
export type Voter = {
  user: Partial<Pick<User, "id" | "first_name" | "last_name">> & { id: number }
  isPresident: boolean
  vote?: Vote
}

/**
 * WARNING: This function is specific to Direttivo voting, do NOT use it for generic voting.
 *
 * This function calculate the voting outcome based on the votes collected so far.
 * To determine the outcome, we refer to Article 13.8 of the Statute:
 * > Le riunioni del Direttivo sono valide quando è presente la maggioranza assoluta
 * > dei componenti. Il Direttivo delibera a maggioranza dei voti dei presenti.
 * > In caso di parità prevale il voto del Presidente.
 *
 * In this context, the “maggioranza assoluta” (absolute majority)
 * is always respected because it is an asynchronous vote,
 * so it means the absolute majority of votes.
 *
 * Here is an example to help devs better understand the voting system.
 * e.g. Direttivo of 8
 * - 4 inFavor, 4 against. President inFavor => ✅ Approved
 * - 3 inFavor, 5 against. President inFavor => ❌ Denied
 * - 5 inFavor, 3 against. President against => ✅ Approved
 * - 2 inFavor, 2 against, 3 absteined, President absteined => TIE => ❌ Denied
 *   (this is an unregulated case, for the sake of banall this should
 *   not ever happen, so we consider it denied anyway)
 * Note: the same mechanisms apply to a Direttivo composed of an odd number of members
 *
 * The rule of thumb is:
 * 1) absolute majority of members:
 *   8-9 => 5 voters  ||  6-7 => 4 voters  ||  4-5 => 3 voters ||  3 => 2 voters
 * 2) in case of TIE, the President's vote counts twice
 * 3) in case of TIE where the President is abstaineded, we consider the votation denied.
 *
 * This function is unit-tested to ensure correct handling of edge-cases.
 */
export function calculateOutcome(voters: Voter[]): Outcome | null {
  if (voters.length < 3 || voters.length > 9) {
    logger.error({ length: voters.length }, "[VOTE] recieved a voters array with invalid length (must be 3<=l<=9)")
    return null
  }

  const membersCount = voters.length
  const majority = Math.floor(membersCount / 2) + 1 // absolute majority
  const votes = voters.filter((v): v is Voter & { vote: Vote } => v.vote !== undefined)

  const presVote = votes.find((v) => v.isPresident)
  if (votes.length === membersCount && !presVote) {
    logger.error({ length: voters.length }, "[VOTE] every member voted but no member is flagged as president!")
    return null
  }

  if (votes.length < majority) return "waiting" // not enough votes

  const results = votes.reduce(
    (results, voter) => {
      results[voter.vote]++
      return results
    },
    {
      inFavor: 0,
      against: 0,
      abstained: 0,
    }
  )

  // there are enough votes, but do we have a majority?
  if (results.inFavor >= majority) return "approved" // majority voted in-favor
  if (results.against >= majority) return "denied" // majority voted against

  // in the following cases we don't have a majority
  if (votes.length === membersCount) {
    if (!presVote) return null // we already checked above, but TS wants it again
    if (results.abstained === membersCount) return "denied" // everyone abstaineded (crazy)
    if (results.inFavor > results.against) return "approved"
    if (results.against > results.inFavor) return "denied"

    // against === inFavor => TIE => the Pres decides
    // abstained === against for the reasons stated in the docs comment
    if (presVote.vote === "abstained" || presVote.vote === "against") return "denied"
    return "approved"
  }

  // some special cases
  if (votes.length === membersCount - 1 && presVote && presVote.vote !== "abstained") {
    if (results.inFavor > results.against && presVote.vote === "inFavor") return "approved"
    if (results.inFavor < results.against && presVote.vote === "against") return "denied"
  }

  // we have not reach enoguh votes to determine the outcome
  // we wait for the remaining votes
  return "waiting"
}
