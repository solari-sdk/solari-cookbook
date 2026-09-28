# Security

wsp runs on your computer and talks to a machine provider with your key. A
hole in it can expose that key, the machines it controls, or the agent
sessions on them. Report one privately and we fix it before anyone else
learns of it.

## Reporting

Use GitHub's private vulnerability reporting on this repository:
[github.com/Zingzy/wsp/security/advisories/new](https://github.com/Zingzy/wsp/security/advisories/new).
The report is visible to you and the maintainer only.

Do not open a public issue for a security problem, and do not paste a key,
a token or a preview link into any report. Say what you ran, what you saw,
the output of `wsp --version`, and the steps that get there again.

## What is in scope

- The host: `wsp up`, the runtime behind it, and the app it serves.
- The command line and the MCP server, which are clients of that host.
- The desktop app.
- The daemon that runs on the machines, and the golden image `wsp init`
  builds.

The kinds of problem we most want to hear about: a key or token that leaves
the computer or shows in a URL, a log or a file; a way onto a machine or its
daemon without the token; a way for one workspace or thread to reach
another; and anything that runs on your computer that you did not ask for.

## What is out of scope

- The machine provider's own service, console and API. Report those to the
  provider.
- The coding agents that run inside a workspace. Report those to their
  makers.
- Problems that need a key you already hold, or an attacker already sitting
  at your unlocked computer.

## What happens after a report

You hear back within a week. If the report is a hole, it is fixed on a
branch, released, and only then written up as an advisory that credits you
if you want credit. If it is not, you get the reason. Either way you are
told when it is closed.

Only the latest release gets fixes; there are no security branches for
older versions.
