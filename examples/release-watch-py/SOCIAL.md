Release Watch — a Solari cookbook example (Pinetree intern challenge)

I forked https://github.com/solari-sdk/solari-cookbook and shipped a real use case that uses all three Solari products on one API key:

1. Cloud browser (stealth Chrome) loads a live page and captures DOM + PNG
2. Sandbox Python kernel scores the extract (read time, hosts, CTA copy) in isolation
3. Desktop Linux GUI opens Chrome on the same URL for a human-review screenshot

Repo: https://github.com/mangeshraut712/solari-cookbook
Example: https://github.com/mangeshraut712/solari-cookbook/tree/main/examples/release-watch-py

This is the actual loop a release / competitive-intel agent runs: see the site like a user, compute off-box, keep a GUI still.

Built with AI, reviewed by me, meant to ship.

@harrychow_ @getsolari
