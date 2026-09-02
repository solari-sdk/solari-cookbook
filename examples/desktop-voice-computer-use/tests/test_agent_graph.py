import pytest
from src.desktop.mock_desktop import MockDesktopClient
from src.agent.vision_reasoner import VisionReasoner
from src.agent.graph import VoiceComputerUseGraph
from src.voice.tts import VoiceSynthesizer


@pytest.mark.asyncio
async def test_reasoner_milestone_planning():
    reasoner = VisionReasoner(api_key=None)
    plan = reasoner.plan_task("Search for the weather in Tokyo and read it back")
    assert isinstance(plan, list)
    assert len(plan) > 0


@pytest.mark.asyncio
async def test_full_langgraph_execution_loop():
    events_received = []

    async def mock_callback(event_type: str, data: dict):
        events_received.append((event_type, data))

    desktop = MockDesktopClient(width=1024, height=768)
    await desktop.create()
    await desktop.connect()

    synthesizer = VoiceSynthesizer(api_key=None)
    reasoner = VisionReasoner(api_key=None)

    agent = VoiceComputerUseGraph(
        desktop_client=desktop,
        reasoner=reasoner,
        synthesizer=synthesizer,
        on_event_callback=mock_callback
    )

    task_instruction = "Search for Tokyo weather and read it back."
    result = await agent.run(task_instruction=task_instruction)

    assert result.get("task_completed") is True
    assert result.get("status") == "COMPLETED"
    assert "Tokyo" in result.get("summary") or "weather" in result.get("summary").lower()
    assert result.get("current_step") > 0

    # Verify event types were emitted for the War Room
    event_types = [e[0] for e in events_received]
    assert "status_update" in event_types
    assert "plan_generated" in event_types
    assert "screenshot_update" in event_types
    assert "reasoning_update" in event_types
    assert "action_executed" in event_types
    assert "task_completed" in event_types

    await desktop.close()
    await desktop.kill()
