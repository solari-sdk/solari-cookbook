# wsp

Your setup, on cloud machines, for coding agents.

The site is [wspx.vercel.app](https://wspx.vercel.app). The docs are [wsp.apidocumentation.com](https://wsp.apidocumentation.com).

wsp reads your computer once, builds a machine that has what it has (your agents, your tools, your sign-ins), and forks workspaces from it in about twenty seconds. Coding agents work inside those workspaces as threads. You read and answer them from the app, the command line, or another agent over MCP.

![The wsp app: workspaces and their threads on the left, a thread and its composer in the center, a terminal and a browser tab on the machine to the right](docs/screenshots/app.png)

## What it does

- **One image of your machine.** The agents you use, the tools they run, your logins, sealed once into a golden image on the machine provider. Rebuild it when your setup changes.
- **Forks in seconds.** Every workspace is a fork of that image, with your setup already there. Forks are live clones: what was running on the source is running on the fork.
- **Agents as threads.** Claude Code and Codex run headless on the machine. Start a thread with a task, read its reply, send the next message, stop it. Threads get real titles and you can rename them, in wsp and in the agent's own session list.
- **Agents starting agents.** An agent on your computer drives wsp over MCP: it forks a workspace, opens a Claude Code thread there, starts a Codex thread beside it, reads both back. Everything it does shows in your sidebar.
- **The machine, in the app.** A terminal that uses your Ghostty config, the ports it listens on as browser tabs, its processes, its files, its cost and state.
- **Naps and wakes.** An idle workspace naps with its RAM intact and wakes on the next message. A machine the provider loses is rebuilt from the image with your files back.
- **Your keys never leave a machine you own.** wsp runs on your own computer, or on a box you own, and talks to the provider with your key. There is no hosted service in between.

## Before you start

- Node 22 or newer, on macOS or Linux.
- A [Solari](https://console.getsolari.com) account and API key. Solari provides the machines; they cost money while they run and nap on their own when idle.
- A way for Claude Code to sign in: an Anthropic API key, or a Claude subscription you log in with on the machine during the first run. Codex signs in the same way.

## Install

```sh
npm i -g @zingzy/wsp
```

### Let your agent set it up

Give your agent the wsp tools, then ask it to set you up:

```sh
wsp mcp install --agent claude     # or codex, gemini, opencode
```

Then, in that agent: *"set up wsp for me"*. It reads what you use on this computer, writes the recipe, asks you about the heavy rows, builds the image, and hands you each sign-in link as the build reaches it. Sign-ins finish in your browser.

### Or do it yourself

```sh
wsp init
```

One screen at a time: the agents on this computer, their tools, what else to bring from this computer, sign-ins, wsp for your own agents, then the build; a screen with nothing to pick is skipped. Everything is ticked from what you actually use; Enter through every screen takes the defaults. Nothing leaves your disk before the confirm.

![wsp init: the agents screen, ticked from what this computer runs](docs/screenshots/init.png)

Useful flags: `--yes` takes every default and asks nothing. `--recipe <path>` builds from a recipe an agent wrote. `--non-interactive --json` prints one JSON line per sign-in and build stage, for an agent driving the setup. `--state <path>` and `--port <n>` keep a second setup apart from the first.

## Every day

```sh
wsp new api                  # a workspace from your image
wsp import api ~/code/api    # put a folder in it
wsp run api "fix the flaky terminal test"
```

The first line that needs a host starts one and says so; `wsp down` stops it. `wsp up` is for a host you want to watch in a terminal, and `wsp up --service` keeps one up across logins. The desktop app is the same host and app in one window; bundles for macOS and Linux are on the [releases page](https://github.com/Zingzy/wsp/releases).

`wsp --help` is sixteen words on five nouns: image, place, workspace, thread, project. Every command is `wsp <verb> <workspace> ...`, the workspace first. `wsp --help agent` has the verbs your agents use and `wsp host --help` the roads to a host on another computer. The command line and the MCP tools are the same verbs; the app's palette runs them too.

<!-- renames:start -->
### Renamed in 0.3.0

The front page of `wsp --help` is sixteen words on five nouns: image, place, workspace, thread, project. Every command is `wsp <verb> <workspace> ...`, the workspace first. Nothing answers to the old words, so here they are, once.

| was | is |
| --- | --- |
| `wsp thread new --in <workspace> "<task>"` | `wsp run <workspace> "<task>"` |
| the MCP tool `thread_new` | the MCP tool `run` |
| `wsp import <folder> --to <workspace>` | `wsp import <workspace> <folder>` |
| `wsp threads --in <workspace>` | `wsp threads <workspace>` |
| `wsp new --local [name]` | `wsp new <name> --on <place>`, naming the computer you are at |
| `wsp new --ssh <user@host>` | `wsp add user@host` (or an alias from your ssh config), then `wsp new <name> --on <that place>` |
| `wsp init --provider <id>` | `wsp add <id>` |
| `wsp pair`, `wsp devices` | `wsp host pair`, `wsp host devices` |
| `wsp connect <url>` | `wsp login`: a host on your account needs no code |
| `wsp hosts default`, `wsp disconnect` | nothing: a line goes to your account's one host, `--host` names another, and `wsp logout` drops them |
| `wsp relay link`, `wsp relay unlink` | `wsp host link`, `wsp host unlink` |
| `wsp relay hosts`, `wsp host linked`, `wsp host list` | `wsp hosts`, the hosts on your account |
| `wsp relay clients`, `wsp host clients` | `wsp login`, and `wsp logout <id>` to sign one out |
| `wsp up` to get going | nothing: the first command that needs a host starts one, and `wsp down` stops it |
| plain `wsp` serving | plain `wsp` prints the help |

This computer and every computer or provider you add are places, and `wsp places` lists them; `--on <place>` on `wsp new` is the one flag you meet, and only once you have more than one. `wsp add` is the one way a place joins: `wsp add user@host` for a computer over ssh (an alias from your `~/.ssh/config` works as well), `wsp add <provider>` for a provider, `wsp add` alone for the line another computer types. `wsp up` is still there for a host you want to watch in a terminal or one that serves beyond this computer.

Agents on this computer get the new skill the first time the new host starts; a project folder whose `AGENTS.md` carries the old section gets the new one at the next `wsp mcp install` there.
<!-- renames:end -->

<!-- bundles:start -->
### Opening a downloaded bundle

Open the macOS disk image and drag wsp onto the Applications folder it shows. One image holds both Apple silicon and Intel.

<!-- unsigned:start -->
The bundles are not signed yet, so macOS refuses the first open of `wsp.app`. Open it once, dismiss the refusal, then in System Settings under Privacy & Security find the line saying wsp was blocked and pick Open Anyway. Or from a terminal: `xattr -dr com.apple.quarantine /Applications/wsp.app`. Every open after that is a double click.
<!-- unsigned:end -->

The Linux AppImage needs the run bit before it starts: `chmod +x wsp-*.AppImage`.
<!-- bundles:end -->

## What is next

Spaces: one workspace at a time in the sidebar, with its own tint. Images in threads. Pi and Gemini threads.

## Building from source

```sh
git clone https://github.com/Zingzy/wsp.git && cd wsp
pnpm install && pnpm build
pnpm wsp init
```

`pnpm test` runs without any key. The laws the code follows are in [CONTRIBUTING.md](CONTRIBUTING.md); how a browser reaches a workspace is in [docs/reach.md](docs/reach.md); cutting a release is [docs/release.md](docs/release.md).

## Issues

[github.com/Zingzy/wsp/issues](https://github.com/Zingzy/wsp/issues). Say what you ran, what you saw, and the output of `wsp --version`. Never paste a key.

## License

AGPL-3.0-only. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
