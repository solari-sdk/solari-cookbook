# Applications

Complete programs built on Solari. Bigger than the examples, and read differently.

An [example](../examples) shows one idea in one file you can take in at a glance.
An application here is something you would actually run: it has a CLI or a UI,
its own modules, usually its own tests, and it solves a whole problem rather
than demonstrating a single call.

Both are welcome. The distinction is only about what a reader is coming for.
Someone learning `previewUrl` wants forty lines. Someone deciding whether Solari
fits their pipeline wants to see a real one.

## What belongs here

- It does something end to end, not one API call with scaffolding around it.
- It runs. A reader with a `slr_live_` key can clone it and get output.
- It is honest about what it needs. If a second vendor's key is required, say so
  in the README and fail with a clear message when it is missing — don't ask for
  a key in `.env.example` that the code never reads.
- Dependencies come from a registry, not vendored into the tree. Every Solari
  SDK is published; see the [SDK table](https://docs.getsolari.com/languages).
- Nothing outside its own directory changes, apart from one row in the table below.

## What doesn't

- Anything that can't be run: a README pointing at a hosted demo, a design
  document, a screenshot tour. Link those from your own repo instead and we're
  glad to point at it.
- Generated scaffolding nobody reads — an untouched framework starter, `CLAUDE.md`
  or `AGENTS.md` files, build output, lockfiles for dependencies you don't have.
- Claims the code doesn't support. If the agent is a stub, say it's a stub.

## Layout

One directory per application, named for what it does. Include a `README.md`
saying what it demonstrates and how to run it, and a `.env.example` listing every
variable it reads and nothing else.

| Application | Language | What it does |
| --- | --- | --- |
| [worldline](worldline) | Python | Snapshot-branch competing plans, verify their artifacts, and replay only the winner |
| [prism](prism) | TypeScript | Render one URL as every user class at once and assert what each one actually saw |
