# The Room is a full remote desktop, not a browser IDE

HackerRank, CoderPad and similar tools give the candidate an editor in a web page with one approved AI assistant. We give each Candidate a full Linux desktop on Solari. Solari streams it to the Candidate's browser. The Candidate then works with the tools they really use, such as Cursor, Claude Code, a terminal and a browser, on an open-ended Task.

This has three costs. The stream can lag more than a native web editor. A desktop costs about $0.25 per hour on Solari's Starter plan. The project depends on Solari's desktop, recording and snapshot APIs. We accept these costs for two reasons. The Reviewer wants to see how the Candidate works with their own AI tools. A Solari use case is also the point of the project.

## Consequences

- Stream lag over a 2 to 3 hour Interview is the first risk to test. If it is not usable, this decision fails.
- The Candidate can read anything inside the Room. API keys and Hidden tests must not live there.
