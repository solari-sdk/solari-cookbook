import asyncio
import sys
import argparse
from rich.prompt import Prompt
from rich.console import Console
from src.config import settings
from src.utils.logger import logger, log_banner
from src.voice.stt import VoiceTranscriber
from src.voice.tts import VoiceSynthesizer
from src.desktop import get_desktop_client
from src.agent.graph import VoiceComputerUseGraph

console = Console()


async def run_voice_cli(instruction: str = "", use_mic: bool = False, use_mock: bool = False):
    """Interactive CLI runner for Solari Voice Agent."""
    if use_mock:
        settings.use_mock_desktop = True

    log_banner(
        title="SOLARI VOICE COMPUTER-USE AGENT",
        subtitle=f"Mode: {'Emulated / Mock' if settings.use_mock_desktop else 'Solari Cloud VM'} | Resolution: {settings.desktop_width}x{settings.desktop_height}"
    )

    transcriber = VoiceTranscriber()
    synthesizer = VoiceSynthesizer()

    # 1. Voice Input / Text Capture
    if use_mic:
        console.print("\n[bold cyan]🎙️ Microphone Mode Enabled:[/bold cyan]")
        audio_bytes = transcriber.record_microphone(duration_seconds=5)
        if audio_bytes:
            with console.status("[bold yellow]Transcribing audio via OpenAI Whisper...[/bold yellow]"):
                instruction = transcriber.transcribe_audio_bytes(audio_bytes)
        else:
            console.print("[yellow]Microphone hardware unavailable or sounddevice missing. Falling back to prompt.[/yellow]")

    if not instruction:
        console.print("\n[bold green]Select or enter a task to execute on Solari Desktop:[/bold green]")
        console.print("  [cyan]1[/cyan] - ☀️ Search for Tokyo weather and read it back")
        console.print("  [cyan]2[/cyan] - 📰 Find the top post on Hacker News and summarize it")
        console.print("  [cyan]3[/cyan] - ✍️ Custom spoken or typed instruction")
        
        choice = Prompt.ask("Choose an option", choices=["1", "2", "3"], default="1")
        if choice == "1":
            instruction = "Search for the current weather in Tokyo and read back the temperature and condition."
        elif choice == "2":
            instruction = "Find the top post on Hacker News and summarize it."
        else:
            instruction = Prompt.ask("Enter instruction")

    console.print(f"\n[bold green]Executing Task:[/bold green] [italic]\"{instruction}\"[/italic]\n")

    # 2. Initialize Desktop Client
    desktop = get_desktop_client()
    try:
        with console.status("[bold cyan]Provisioning & Connecting to Solari Linux Desktop...[/bold cyan]"):
            await desktop.create(
                width=settings.desktop_width,
                height=settings.desktop_height,
                timeout_seconds=settings.desktop_timeout
            )
            await desktop.connect()

        # 3. Execute LangGraph Agent
        agent = VoiceComputerUseGraph(
            desktop_client=desktop,
            synthesizer=synthesizer
        )

        result = await agent.run(task_instruction=instruction)

        # 4. Final Output
        console.print("\n" + "=" * 60)
        console.print(f"[bold green]✨ Task Completed in {result.get('current_step')} Steps![/bold green]")
        console.print(f"[bold cyan]🗣️ Voice Summary:[/bold cyan] {result.get('summary')}")
        console.print("=" * 60 + "\n")

    except Exception as e:
        logger.error(f"[CLI] Execution error: {e}")
    finally:
        # GOTCHA: Always call close() and kill() to terminate VM
        with console.status("[bold magenta]Tearing down session and terminating Solari VM (kill)...[/bold magenta]"):
            await desktop.close()
            await desktop.kill()
        console.print("[dim green]VM session successfully terminated.[/dim green]\n")


def main():
    parser = argparse.ArgumentParser(description="Solari Voice Computer-Use Agent CLI")
    parser.add_argument("--task", type=str, default="", help="Instruction to execute")
    parser.add_argument("--mic", action="store_true", help="Record instruction from microphone")
    parser.add_argument("--mock", action="store_true", help="Run with simulated mock desktop")
    args = parser.parse_args()

    asyncio.run(run_voice_cli(instruction=args.task, use_mic=args.mic, use_mock=args.mock))


if __name__ == "__main__":
    main()
