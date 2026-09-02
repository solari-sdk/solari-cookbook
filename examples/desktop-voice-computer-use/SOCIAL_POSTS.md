# 📣 Social Media Launch Posts

Use the drafts below to publish and showcase the project on X (Twitter) and LinkedIn.

---

## 🐦 X (Twitter) Thread / Post

### Option 1: High-Impact Video Demo Post (Recommended)
> 🎙️ Excited to open-source **Solari Voice Agent**: a voice-directed autonomous computer-use agent built on @getsolari's managed Linux desktop infrastructure!
>
> Instead of another browser scraper, I wanted to build a true end-to-end voice loop:
> 1. 🎤 Spoken command captured & transcribed with Whisper
> 2. 🧠 @LangChainAI LangGraph reasoning loop plans GUI milestones
> 3. 👁️ GPT-4o Vision analyzes live Solari desktop screenshots
> 4. ⚡ Dispatches mouse clicks, keystrokes, & bash commands in real time
> 5. 🔊 Speaks back the answer via OpenAI TTS
> 6. 🛰️ Streams live viewport + thoughts to a FastAPI WebSocket "War Room" dashboard
>
> Handled Solari's platform gotchas too (`kill()` vs `close()` teardown lifecycle & bash command wrapping).
>
> Shoutout to @Harry and the @getsolari team for building such crisp microVM infrastructure for agents!
>
> 🔗 Code & Repo: https://github.com/your-username/solari-voice-agent
> 
> #AIAgents #ComputerUse #LangGraph #Solari #OpenAI #BuildInPublic

---

## 💼 LinkedIn Post

> 🚀 **Building the Future of Voice-Directed Computer-Use with Solari & LangGraph**
>
> Most autonomous agent projects today fall into two categories: basic headless web scrapers or simple text-in/text-out terminal scripts.
>
> I wanted to push the frontier further and build a complete, production-grade **Voice-Directed Computer-Use Agent** using the new **Solari Desktop SDK** (@Solari).
>
> 💡 **How it works end-to-end:**
> • **Voice Input**: Captures live spoken user instructions directly from the browser mic or terminal and transcribes them in milliseconds with OpenAI Whisper.
> • **Multi-Step Orchestration**: Feeds the instruction into a LangGraph state machine that breaks down high-level requests into visual GUI milestones.
> • **Multimodal Perception**: Captures remote desktop frames from Solari's hardware-isolated Linux microVMs, analyzes the viewport with GPT-4o Vision, and pinpoints exact pixel coordinates for clicks, scrolling, and keyboard typing.
> • **Spoken Feedback**: Synthesizes the extracted findings back into natural speech using OpenAI TTS.
> • **Real-Time Observability**: Streams live screenshots with animated action crosshairs, chain-of-thought tokens, and milestone progress to a FastAPI WebSocket "War Room" UI.
>
> 🛡️ **Engineering Details & Solari Gotchas Handled:**
> - Handled Solari's VM lifecycle by pairing session `close()` with explicit `kill()` / `destroy()` to eliminate idle billing leaks.
> - Handled non-shell-interpreted command execution with automated bash shell wrapping.
> - Built an emulated mock desktop engine with PIL rendering for fast CI/CD and offline tests.
>
> Huge kudos to Harry and the Solari team for building fast, isolated VM infrastructure designed specifically for AI agents.
>
> Check out the open-source repo, architecture diagrams, and quickstart guide here:
> 🔗 **GitHub Repository**: https://github.com/your-username/solari-voice-agent
>
> Would love to hear your thoughts! 👇
>
> #ArtificialIntelligence #ComputerUse #AIAgents #SoftwareEngineering #LangChain #Solari #FastAPI #OpenSource
