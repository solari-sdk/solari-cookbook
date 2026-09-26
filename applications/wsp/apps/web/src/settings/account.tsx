// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Account: the one row that says who this wsp is signed in to and
// what a sign-in buys. The button is held with no title: no op on the wire
// signs the app in yet, and the row's description says so, since a held
// control never has a pointer on it and a title there is a reason nobody can
// read. A host that refuses the account read leaves the slot empty and keeps
// the sentence.
//
// The slot says no state word: a Sign in button standing there is not being
// signed in and a Sign out is being signed in, so a word beside it said it
// twice and took the room the sentence needed. The login is a fact rather
// than a state, and keeps its place.
import { Button } from "../components/ui/button.js";
import { ACCOUNT_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

export function accountCards(ctx: SettingsContext): SettingsCardData[] {
  const account = ctx.reads.account;
  const signedIn = account?.signedIn === true;
  const word = signedIn ? account?.login : undefined;
  return [
    {
      id: "account",
      items: [
        {
          kind: "row",
          id: "github",
          title: ACCOUNT_WORDS.github,
          description: signedIn ? ACCOUNT_WORDS.reachable : ACCOUNT_WORDS.reach,
          ...(word === undefined ? {} : { word, wordK: "account-login" }),
          // The screenshot list waits on this id to know the page is drawn, so it sits on the row, which stands
          // whatever the account read said, rather than on a word the row no longer always has.
          attrs: { "data-k": "account-state" },
          control: (
            <Button data-k="account-action" size="xs" held>
              {signedIn ? ACCOUNT_WORDS.signOut : ACCOUNT_WORDS.signIn}
            </Button>
          ),
        },
      ],
    },
  ];
}
