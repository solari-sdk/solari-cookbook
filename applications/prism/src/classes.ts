/**
 * The user classes to check, and what each must and must not see.
 *
 * Expectations are stated as testids that must be present or absent on the
 * rendered page. That is deliberate: a check that asserts "the profile was
 * attached" proves nothing about what the user actually got. Prism only ever
 * asserts things read back off a live page.
 *
 * Two rules this list has to obey, both learned by getting them wrong:
 *
 *   1. No two classes may carry the same identity. If they do, the same page
 *      is judged twice by different standards, and one of the verdicts is
 *      wrong by construction.
 *   2. Every class must reject everything it should never see -- not just the
 *      one thing it is "about". A class that only lists its headline concern
 *      passes while a different bug is on screen in front of it.
 */
export type UserClass = {
  name: string
  /** Cookies that define this identity. In production these come from a real
   *  login performed once in Solari's console; here they are seeded so the
   *  demo reproduces with no accounts. */
  cookies: { name: string; value: string }[]
  mustSee: string[]
  mustNotSee: string[]
  /** Why this class exists, printed in the report so a failure explains itself. */
  because: string
}

export const CLASSES: UserClass[] = [
  {
    name: "anon",
    // No cookies at all: a genuinely fresh visitor, not one carrying a
    // tier=anon marker that a real signed-out user would never have.
    cookies: [],
    mustSee: ["heading", "signin", "consent-banner", "quota"],
    // Nothing has been consented to yet, so a tracker here is as much a breach
    // as an explicit refusal. Listing it is what makes this class able to fail.
    mustNotSee: ["export", "admin", "tracker"],
    because: "a fresh visitor has consented to nothing and has bought nothing",
  },
  {
    name: "free",
    cookies: [{ name: "tier", value: "free" }, { name: "consent", value: "accepted" }],
    mustSee: ["heading", "quota", "tier"],
    mustNotSee: ["export", "admin", "signin"],
    because: "a free account must not reach paid-only export -- this is revenue leak",
  },
  {
    name: "paid",
    cookies: [{ name: "tier", value: "paid" }, { name: "consent", value: "accepted" }],
    mustSee: ["heading", "export", "quota"],
    mustNotSee: ["admin", "signin", "consent-banner"],
    because: "a paying account must get what it pays for, and no admin surface",
  },
  {
    name: "admin",
    cookies: [{ name: "tier", value: "admin" }, { name: "consent", value: "accepted" }],
    mustSee: ["heading", "export", "admin", "quota"],
    mustNotSee: ["signin", "consent-banner"],
    because: "an admin gets everything, but must still not look signed out",
  },
  {
    name: "eu-consent-rejected",
    cookies: [{ name: "tier", value: "free" }, { name: "consent", value: "rejected" }],
    mustSee: ["heading", "consent-banner"],
    // Both, not just the tracker: this identity is also a free account, so the
    // paid export must be absent here for exactly the reason it is for `free`.
    mustNotSee: ["tracker", "export", "admin"],
    because: "a visitor who refused consent must not be tracked, and is still not a paying account",
  },
  {
    name: "anon-consent-accepted",
    // Distinct from every other row: signed out, but has accepted. Reusing
    // free's cookies here would judge one identical page by two standards.
    cookies: [{ name: "consent", value: "accepted" }],
    mustSee: ["heading", "signin", "tracker", "quota"],
    mustNotSee: ["consent-banner", "export", "admin"],
    because: "consent means the tracker is allowed and the banner must stop asking",
  },
]
