# 🎙️ Solari Voice Agent

> **Voice-Directed Autonomous Computer-Use Agent** powered by the **Solari Desktop SDK**, **LangGraph Reasoning Loops**, **OpenAI Whisper & TTS**, and a **Real-Time "War Room" WebSocket Observability Dashboard**.

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![LangGraph](https://img.shields.io/badge/orchestration-LangGraph-orange.svg)](https://github.com/langchain-ai/langgraph)
[![Solari Desktop](https://img.shields.io/badge/sandbox-Solari_Desktop-cyan.svg)](https://getsolari.com)
[![FastAPI](https://img.shields.io/badge/server-FastAPI_WebSockets-009688.svg)](https://fastapi.tiangolo.com)
[![Tests](https://img.shields.io/badge/tests-11%20passing-brightgreen.svg)]()

---

## 🌟 Overview

Most autonomous agent demos are either basic browser scrapers or text-in/text-out terminal scripts. **Solari Voice Agent** is a full-stack, voice-directed computer-use agent that takes natural spoken instructions, breaks them into visual GUI milestones with **LangGraph**, controls a managed Linux virtual desktop via the **Solari Desktop API**, and speaks back a synthesized answer using **OpenAI TTS**—all while streaming live screenshots, thought tokens, and action bounding boxes to a real-time **Mission Control War Room**.

```
┌─────────────────┐       ┌──────────────────────┐       ┌────────────────────────┐
│  🎙️ Spoken Voice │  ───> │  OpenAI Whisper STT  │  ───> │   LangGraph Planner    │
│   (Mic / Web)   │       │   (Audio -> Text)    │       │ (Milestone Breakdown)  │
└─────────────────┘       └──────────────────────┘       └───────────┬────────────┘
                                                                     │
┌────────────────────────────────────────────────────────────────────▼────────────┐
│                    🔄 LangGraph Screenshot-Reason-Act Loop                      │
│                                                                                 │
│   ┌─────────────────────┐    ┌─────────────────────┐    ┌───────────────────┐   │
│   │ 👁️ Solari Desktop    │ ─> │ 🧠 Multimodal Vision │ ─> │ ⚡ Solari Action  │   │
│   │   Screenshot Stream │    │    Reasoner (GPT-4o)│    │   API (Click/Type)│   │
│   └─────────────────────┘    └─────────────────────┘    └───────────────────┘   │
└────────────────────────────────────┬────────────────────────────────────────────┘
                                     │ (On Task Completion)
┌────────────────────────────────────▼────────────────────────────────────────────┐
│ 🔊 OpenAI TTS Synthesizer (Spoken Voice Summary) + 🖥️ War Room Live Stream      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## ✨ Key Features

1. **End-to-End Voice Loop (STT -> Vision Action -> TTS)**:
   - **Voice Input**: Captures spoken commands directly from the browser microphone (HTML5 Web Audio + frequency waveform canvas) or local microphone, transcribed via **OpenAI Whisper**.
   - **Voice Output**: Speaks back extracted information naturally using **OpenAI Speech API (`tts-1`)**.

2. **LangGraph State Machine**:
   - Structured `StateGraph` with dedicated nodes: `planner` ➔ `perceive` ➔ `reason` ➔ `execute` ➔ `synthesize`.
   - Dynamic conditional routing between action execution and task completion.

3. **Solari Desktop Cloud Integration & Gotcha Handling**:
   - Programmatic mouse movement, click simulation, keyboard typing, and window control.
   - **Handles all documented Solari platform gotchas**:
     - 🛡️ **VM Lifecycle**: Solari's `close()` method ends the connection stream, but `kill()` / `destroy()` is required to shut down the VM and avoid idle billing leaks.
     - 🐚 **Shell Command Interpretation**: Desktop commands in Solari are not shell-interpreted by default. The client automatically wraps raw strings into `["bash", "-c", cmd]` so pipes, subshells, and environment variables execute correctly.
     - ⚡ **Local Emulated Mode**: Built-in mock desktop mode with dynamic PIL rendering for offline testing, demos, and CI without incurring VM credits.

4. **Real-Time "War Room" Observability Dashboard**:
   - **Live Viewport**: Streams screenshots with interactive coordinate tracking, bounding boxes, and animated red action crosshairs.
   - **Reasoning Inspector**: Watch the Vision LLM's chain-of-thought in real time.
   - **Milestone Checklist**: Tracks high-level plan progress.
   - **Action Timeline**: Chronological log of GUI interactions with execution latency and observations.

---

## 🏗️ Project Architecture

```
solari/
├── .env.example              # Environment variables template
├── requirements.txt          # Production dependencies
├── pyproject.toml            # Project packaging metadata
├── README.md                 # Complete documentation
├── SOCIAL_POSTS.md           # Ready-to-publish X & LinkedIn post copy
├── demo.py                   # Automated demo script for video recordings
├── cli.py                    # Interactive terminal CLI runner
├── run_dashboard.py          # FastAPI War Room dashboard launcher
├── main.py                   # Unified root entrypoint
│
├── src/
│   ├── config.py             # Pydantic Settings & environment validation
│   ├── agent/
│   │   ├── state.py          # LangGraph typed state schema (AgentState)
│   │   ├── prompts.py        # Planner & Vision Reasoner prompts
│   │   ├── vision_reasoner.py# GPT-4o multimodal vision reasoning engine
│   │   └── graph.py          # Compiled LangGraph workflow & WebSocket hooks
│   ├── desktop/
│   │   ├── interface.py      # BaseDesktopClient ABC
│   │   ├── solari_client.py  # Solari Cloud Desktop SDK / REST API client
│   │   └── mock_desktop.py   # Emulated desktop with dynamic PIL screen rendering
│   ├── voice/
│   │   ├── stt.py            # Whisper Speech-to-Text transcriber
│   │   └── tts.py            # OpenAI Text-to-Speech synthesizer & audio streaming
│   ├── server/
│   │   ├── app.py            # FastAPI REST & static asset server
│   │   └── websocket_manager.py # WebSocket broadcaster for War Room
│   └── utils/
│       ├── logger.py         # Rich terminal formatting & action cards
│       └── image_utils.py    # Base64, thumbnails, & visual marker overlays
│
├── static/
│   ├── index.html            # Mission Control War Room UI
│   ├── style.css             # Cyberpunk dark mode styling
│   └── app.js                # Web Audio recording, canvas waveform, & WebSocket client
│
└── tests/
    ├── test_agent_graph.py   # LangGraph execution tests
    ├── test_solari_client.py # Solari lifecycle & gotcha tests
    ├── test_voice_stt_tts.py # STT & TTS tests
    └── test_server.py        # FastAPI endpoint & WebSocket tests
```

---

## 🚀 Quickstart Guide

### 1. Prerequisites
- Python 3.10 or higher
- Solari API Key (`slr_live_...` from [getsolari.com](https://getsolari.com))
- OpenAI API Key (`sk-...`)

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/your-username/solari-voice-agent.git
cd solari-voice-agent

# Create and activate virtual environment
python -m venv venv
# On Windows:
.\venv\Scripts\activate
# On macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Environment Setup
Copy `.env.example` to `.env` and fill in your API keys:
```bash
cp .env.example .env
```

Edit `.env`:
```env
SOLARI_API_KEY=slr_live_your_key_here
OPENAI_API_KEY=sk-your_openai_key_here

# Optional: Set to true to test locally without consuming Solari/OpenAI credits
USE_MOCK_DESKTOP=false
```

---

## 🎮 Running the Agent

### Option A: Launch the "War Room" Web Dashboard (Recommended)
```bash
python run_dashboard.py
```
Open **`http://localhost:8000`** in your browser:
1. Click the glowing **Microphone** button and speak an instruction (e.g. *"Check the weather in Tokyo and tell me"*).
2. Watch the live desktop stream, action crosshairs, chain-of-thought, and milestone checklist update in real time.
3. Hear the agent read back the final answer through your speakers!

### Option B: Interactive Terminal CLI
```bash
# Interactive selection:
python cli.py

# Direct voice instruction via local mic:
python cli.py --mic

# Direct text command:
python cli.py --task "Find the top post on Hacker News and summarize it"
```

### Option C: Automated Recording Demo Script
```bash
# Runs the Tokyo Weather demonstration:
python demo.py weather

# Runs the Hacker News demonstration:
python demo.py hn
```

---

## 🧪 Testing

Run the comprehensive test suite:
```bash
pytest -v
```

Output:
```text
tests/test_agent_graph.py::test_reasoner_milestone_planning PASSED       [  9%]
tests/test_agent_graph.py::test_full_langgraph_execution_loop PASSED     [ 18%]
tests/test_server.py::test_status_endpoint PASSED                        [ 27%]
tests/test_server.py::test_index_html_endpoint PASSED                    [ 36%]
tests/test_server.py::test_kill_desktop_endpoint PASSED                  [ 45%]
tests/test_server.py::test_run_task_endpoint_mock PASSED                 [ 54%]
tests/test_solari_client.py::test_mock_desktop_lifecycle PASSED          [ 63%]
tests/test_solari_client.py::test_solari_command_wrapping PASSED         [ 72%]
tests/test_solari_client.py::test_image_utils_annotation PASSED          [ 81%]
tests/test_voice_stt_tts.py::test_stt_initialization_and_fallback PASSED [ 90%]
tests/test_voice_stt_tts.py::test_tts_initialization_and_data_uri PASSED [100%]

============================= 11 passed in 3.83s ==============================
```

---

## ⚙️ Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `SOLARI_API_KEY` | `""` | Solari Cloud authentication key (`slr_live_...`) |
| `SOLARI_API_BASE` | `https://api.getsolari.com` | Solari API base endpoint |
| `OPENAI_API_KEY` | `""` | OpenAI API key for Whisper, GPT-4o Vision, and TTS |
| `VISION_MODEL` | `gpt-4o` | Multimodal Vision model for GUI screenshot inspection |
| `PLANNING_MODEL` | `gpt-4o` | LLM used for initial milestone breakdown |
| `WHISPER_MODEL` | `whisper-1` | OpenAI Whisper model for audio transcription |
| `TTS_MODEL` | `tts-1` | OpenAI Speech synthesis model |
| `TTS_VOICE` | `alloy` | Voice style (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`) |
| `DESKTOP_WIDTH` | `1024` | Desktop screen width in pixels |
| `DESKTOP_HEIGHT` | `768` | Desktop screen height in pixels |
| `DESKTOP_TIMEOUT` | `600` | Session timeout in seconds |
| `DESKTOP_ON_TIMEOUT` | `kill` | Teardown behavior on timeout (`pause` or `kill`) |
| `MAX_STEPS` | `15` | Maximum LangGraph reasoning iterations per task |
| `USE_MOCK_DESKTOP` | `false` | Enable simulated desktop rendering for offline tests |

---

## 🛡️ Solari Gotchas & Best Practices

1. **Session `close()` vs VM `kill()`**:
   In Solari, calling `close()` simply disconnects the WebSocket stream. To prevent runaway cloud billing, always call `kill()` or `destroy()` upon task completion or error handling to terminate the underlying microVM.
2. **Command Execution Interpreter**:
   Commands run through Solari's action API are not executed through a shell by default. Our client wraps string commands in `["bash", "-c", cmd]` so environment variables, pipes (`|`), and bash redirects work as expected.
3. **Viewport Coordinate Mapping**:
   Normalized coordinates from Vision models are scaled to the remote resolution (e.g. 1024x768) with visual marker compensation.

---

## 📜 License

MIT License. Free for open source and commercial use.
