import { describe, expect, it } from "vitest"
import { calculateOutcome, type Outcome, type Vote, type Voter } from "@/utils/vote"

function makeTest(
  pres: Vote | undefined,
  inFavor: number,
  against: number,
  abstained: number,
  empty: number
): Outcome | null {
  const voters: Voter[] = [{ user: fakeUser, isPresident: true, vote: pres }]

  for (let i = 0; i < inFavor; i++) {
    voters.push({
      user: fakeUser,
      isPresident: false,
      vote: "inFavor",
    })
  }
  for (let i = 0; i < against; i++) {
    voters.push({
      user: fakeUser,
      isPresident: false,
      vote: "against",
    })
  }
  for (let i = 0; i < abstained; i++) {
    voters.push({
      user: fakeUser,
      isPresident: false,
      vote: "abstained",
    })
  }
  for (let i = 0; i < empty; i++) {
    voters.push({
      user: fakeUser,
      isPresident: false,
      vote: undefined,
    })
  }

  return calculateOutcome(voters)
}

const fakeUser: Voter["user"] = { first_name: "First", last_name: "Last", id: 1000000000 }
describe("voting utility", () => {
  it("limits breaking", () => {
    expect(calculateOutcome([])).toBe(null)
    expect(makeTest(undefined, 0, 0, 0, 0)).toBe(null)
    expect(makeTest(undefined, 0, 0, 0, 10)).toBe(null)
  })

  it("everyone votes the same", () => {
    expect(makeTest("abstained", 0, 0, 6, 0)).toBe<Outcome>("denied")
    expect(makeTest("against", 0, 6, 0, 0)).toBe<Outcome>("denied")
    expect(makeTest("inFavor", 6, 0, 0, 0)).toBe<Outcome>("approved")
  })

  it("no majority of votes reached", () => {
    expect(makeTest(undefined, 2, 3, 0, 3)).toBe<Outcome>("waiting")
    expect(makeTest("inFavor", 0, 1, 0, 5)).toBe<Outcome>("waiting")
    expect(makeTest(undefined, 1, 2, 0, 4)).toBe<Outcome>("waiting")
    expect(makeTest(undefined, 1, 1, 0, 3)).toBe<Outcome>("waiting")
    expect(makeTest("abstained", 0, 0, 3, 5)).toBe<Outcome>("waiting")
  })

  it("everyone voted, different combinations", () => {
    expect(makeTest("abstained", 4, 2, 0, 0)).toBe<Outcome>("approved")
    expect(makeTest("inFavor", 3, 3, 0, 0)).toBe<Outcome>("approved")
    expect(makeTest("against", 4, 2, 0, 0)).toBe<Outcome>("approved")
    expect(makeTest("against", 2, 4, 0, 0)).toBe<Outcome>("denied")
    expect(makeTest("abstained", 2, 4, 0, 0)).toBe<Outcome>("denied")
    expect(makeTest("abstained", 1, 5, 0, 0)).toBe<Outcome>("denied")
    expect(makeTest("abstained", 0, 6, 0, 0)).toBe<Outcome>("denied")
    expect(makeTest("inFavor", 0, 6, 0, 0)).toBe<Outcome>("denied")
    expect(makeTest("inFavor", 1, 2, 3, 0)).toBe<Outcome>("approved")
  })

  it("not everyone voted, but still a majority is reached", () => {
    expect(makeTest(undefined, 4, 1, 0, 1)).toBe<Outcome>("approved")
    expect(makeTest(undefined, 5, 0, 0, 1)).toBe<Outcome>("approved")
    expect(makeTest("inFavor", 4, 1, 0, 1)).toBe<Outcome>("approved")
    expect(makeTest("abstained", 4, 1, 0, 1)).toBe<Outcome>("approved")
    expect(makeTest("inFavor", 3, 0, 2, 1)).toBe<Outcome>("approved")
    expect(makeTest(undefined, 4, 2, 0, 0)).toBe<Outcome>("approved")
    expect(makeTest("inFavor", 1, 4, 0, 1)).toBe<Outcome>("denied")
    expect(makeTest("against", 1, 4, 0, 1)).toBe<Outcome>("denied")
    expect(makeTest("inFavor", 1, 4, 0, 1)).toBe<Outcome>("denied")
  })

  it("tie cases", () => {
    expect(makeTest("abstained", 3, 3, 0, 0)).toBe<Outcome>("denied")
    expect(makeTest("inFavor", 3, 4, 0, 0)).toBe<Outcome>("approved")
    expect(makeTest("abstained", 3, 4, 0, 0)).toBe<Outcome>("denied") // not a proper tie
    expect(makeTest("against", 3, 2, 1, 0)).toBe<Outcome>("denied")
  })

  it("some tricky cases", () => {
    expect(makeTest("inFavor", 2, 3, 0, 1)).toBe<Outcome>("waiting")
    expect(makeTest("abstained", 2, 3, 0, 1)).toBe<Outcome>("waiting")
    expect(makeTest(undefined, 3, 3, 0, 0)).toBe<Outcome>("waiting")
    expect(makeTest("against", 3, 2, 0, 1)).toBe<Outcome>("waiting")
    expect(makeTest("inFavor", 2, 2, 0, 1)).toBe<Outcome>("approved")
    expect(makeTest("against", 2, 2, 0, 1)).toBe<Outcome>("denied")
    expect(makeTest("inFavor", 3, 3, 0, 1)).toBe<Outcome>("approved")
    expect(makeTest("inFavor", 0, 2, 0, 0)).toBe<Outcome>("denied")
    expect(makeTest("inFavor", 1, 1, 0, 0)).toBe<Outcome>("approved")
    expect(makeTest("abstained", 1, 1, 0, 0)).toBe<Outcome>("denied")
  })
})
