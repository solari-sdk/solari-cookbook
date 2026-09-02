import asyncio
import os
from src.config import settings
from src.utils.logger import log_banner, console
from src.voice.tts import VoiceSynthesizer
from src.desktop import get_desktop_client
from src.agent.graph import VoiceComputerUseGraph


async def run_demo(preset: str = "weather"):
    """Runs an automated demo script perfect for video recording."""
    log_banner(
        title="SOLARI VOICE AGENT - AUTOMATED DEMO RUNNER",
        subtitle=f"Preset: {preset.upper()} | Clean Lifecycle & Spoken TTS Summary"
    )

    if preset == "weather":
        instruction = "Search for the current weather in Tokyo and read back the temperature and condition."
    elif preset == "hn":
        instruction = "Find the top post on Hacker News and summarize it."
    else:
        instruction = "Open Wikipedia and search for Autonomous Agent Architecture."

    console.print(f"[bold cyan]Demo Task Instruction:[/bold cyan] [italic]\"{instruction}\"[/italic]\n")

    desktop = get_desktop_client()
    synthesizer = VoiceSynthesizer()

    try:
        console.print("[bold yellow]1. Provisioning Solari Linux Desktop environment...[/bold yellow]")
        await desktop.create(
            width=settings.desktop_width,
            height=settings.desktop_height,
            timeout_seconds=settings.desktop_timeout
        )
        await desktop.connect()
        console.print("[bold green]✓ Solari Desktop VM connected.[/bold green]\n")

        console.print("[bold yellow]2. Initializing LangGraph Reasoning & Computer-Use Loop...[/bold yellow]")
        agent = VoiceComputerUseGraph(
            desktop_client=desktop,
            synthesizer=synthesizer
        )

        result = await agent.run(task_instruction=instruction)

        console.print("\n[bold green]3. Task Execution Summary:[/bold green]")
        console.print(f"   • Total Steps: {result.get('current_step')}")
        console.print(f"   • Spoken Response: [bold cyan]\"{result.get('summary')}\"[/bold cyan]")

    finally:
        console.print("\n[bold yellow]4. Proper Teardown (Gotcha Safe):[/bold yellow]")
        console.print("   • Closing WebSocket connection: close()")
        await desktop.close()
        console.print("   • Terminating Cloud VM: kill() / destroy()")
        await desktop.kill()
        console.print("[bold green]✓ Solari VM successfully destroyed. No idle billing leaks.[/bold green]\n")


def main():
    import sys
    preset = sys.argv[1] if len(sys.argv) > 1 else "weather"
    asyncio.run(run_demo(preset))


if __name__ == "__main__":
    main()
