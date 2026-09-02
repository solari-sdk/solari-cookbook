import os
import asyncio
from typing import Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from src.config import settings
from src.utils.logger import logger
from src.server.websocket_manager import war_room_manager
from src.voice.stt import VoiceTranscriber
from src.voice.tts import VoiceSynthesizer
from src.desktop import get_desktop_client, BaseDesktopClient, MockDesktopClient
from src.agent.graph import VoiceComputerUseGraph

app = FastAPI(
    title="Solari Voice Agent - War Room Observability",
    description="Real-time Computer-Use Agent Dashboard powered by Solari Desktop & LangGraph",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active singletons
transcriber = VoiceTranscriber()
synthesizer = VoiceSynthesizer()
current_desktop: Optional[BaseDesktopClient] = None
is_task_running: bool = False


class RunTaskRequest(BaseModel):
    instruction: str
    use_mock: Optional[bool] = None


@app.get("/api/status")
async def get_system_status():
    """Returns system configuration and connectivity status."""
    has_solari = bool(settings.solari_api_key and not settings.solari_api_key.startswith("slr_live_your"))
    has_openai = bool(settings.openai_api_key and not settings.openai_api_key.startswith("sk-your"))
    return {
        "status": "ready",
        "solari_configured": has_solari,
        "openai_configured": has_openai,
        "mode": "Live Solari Desktop" if (has_solari and not settings.use_mock_desktop) else "Emulated / Mock Desktop",
        "vision_model": settings.vision_model,
        "resolution": f"{settings.desktop_width}x{settings.desktop_height}",
        "is_task_running": is_task_running
    }


@app.post("/api/voice/transcribe")
async def transcribe_audio_endpoint(audio: UploadFile = File(...)):
    """Transcribes an audio recording sent from the browser microphone via Whisper."""
    try:
        content = await audio.read()
        logger.info(f"[Server] Received {len(content)} bytes of audio from browser mic.")
        transcript = transcriber.transcribe_audio_bytes(content, filename=audio.filename or "browser_mic.wav")
        
        await war_room_manager.broadcast("voice_transcribed", {
            "transcript": transcript
        })
        return {"success": True, "transcript": transcript}
    except Exception as e:
        logger.error(f"[Server] Audio transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/run-task")
async def run_task_endpoint(request: RunTaskRequest):
    """Triggers the LangGraph computer-use reasoning loop."""
    global current_desktop, is_task_running

    if is_task_running:
        raise HTTPException(status_code=400, detail="A task is already actively running.")

    is_task_running = True
    instruction = request.instruction.strip()
    logger.info(f"[Server] 🚀 Triggering task: \"{instruction}\"")

    try:
        # Initialize desktop client with fallback
        try:
            current_desktop = get_desktop_client(use_mock=request.use_mock)
            await current_desktop.create(
                width=settings.desktop_width,
                height=settings.desktop_height,
                timeout_seconds=settings.desktop_timeout
            )
            await current_desktop.connect()
        except Exception as conn_err:
            logger.warning(f"[Server] Live Solari connection unavailable ({conn_err}). Falling back to Emulated Mock Desktop.")
            current_desktop = MockDesktopClient(width=settings.desktop_width, height=settings.desktop_height)
            await current_desktop.create()
            await current_desktop.connect()

        is_mock = isinstance(current_desktop, MockDesktopClient)
        await war_room_manager.broadcast("vm_connected", {
            "resolution": f"{settings.desktop_width}x{settings.desktop_height}",
            "mode": "Mock Desktop" if is_mock else "Solari Live VM"
        })

        # Run LangGraph Agent
        agent_graph = VoiceComputerUseGraph(
            desktop_client=current_desktop,
            synthesizer=synthesizer,
            on_event_callback=war_room_manager.broadcast
        )

        result = await agent_graph.run(task_instruction=instruction)

        return {
            "success": True,
            "instruction": instruction,
            "summary": result.get("summary"),
            "audio_uri": result.get("audio_uri"),
            "total_steps": result.get("current_step")
        }

    except Exception as e:
        logger.error(f"[Server] Task execution failed: {e}")
        await war_room_manager.broadcast("task_error", {"error": str(e)})
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        is_task_running = False
        # GOTCHA: Ensure proper cleanup
        if current_desktop:
            await current_desktop.close()
            # If mock desktop or completed, terminate VM
            await current_desktop.kill()
            current_desktop = None
        await war_room_manager.broadcast("vm_disconnected", {})


@app.post("/api/desktop/kill")
async def kill_desktop_endpoint():
    """Immediately kills the active VM."""
    global current_desktop, is_task_running
    if current_desktop:
        await current_desktop.kill()
        current_desktop = None
        is_task_running = False
        await war_room_manager.broadcast("vm_killed", {"message": "VM destroyed by user."})
        return {"success": True, "message": "Desktop VM killed."}
    return {"success": True, "message": "No active VM."}


@app.websocket("/ws/warroom")
async def war_room_websocket_endpoint(websocket: WebSocket):
    """WebSocket stream powering the live War Room dashboard."""
    await war_room_manager.connect(websocket)
    try:
        # Send initial status
        await websocket.send_json({
            "type": "init",
            "data": {
                "message": "Connected to Solari Voice War Room",
                "mode": "Mock Desktop" if settings.use_mock_desktop else "Solari Cloud",
                "resolution": f"{settings.desktop_width}x{settings.desktop_height}"
            }
        })
        while True:
            data = await websocket.receive_text()
            # Handle incoming WebSocket commands if any
            logger.debug(f"[War Room WS] Received client message: {data}")
    except WebSocketDisconnect:
        war_room_manager.disconnect(websocket)
    except Exception as e:
        logger.debug(f"[War Room WS] Error: {e}")
        war_room_manager.disconnect(websocket)


# Mount static assets
static_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "static")
if os.path.exists(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.get("/", response_class=HTMLResponse)
    async def serve_index():
        index_file = os.path.join(static_dir, "index.html")
        if os.path.exists(index_file):
            with open(index_file, "r", encoding="utf-8") as f:
                return f.read()
        return "<h1>Solari Voice Agent War Room Dashboard</h1>"
