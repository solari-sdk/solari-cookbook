import sys
import logging
from rich.console import Console
from rich.logging import RichHandler
from rich.panel import Panel
from rich.text import Text
from rich.table import Table

# Ensure UTF-8 stdout encoding on Windows
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

console = Console(force_terminal=True, legacy_windows=False)

def setup_logger(name: str = "solari_agent", level: int = logging.INFO) -> logging.Logger:
    """Configures a rich console logger."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = RichHandler(
            console=console,
            show_time=True,
            show_path=False,
            rich_tracebacks=True,
            markup=True
        )
        formatter = logging.Formatter("%(message)s")
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        logger.setLevel(level)
    return logger

logger = setup_logger()

def log_banner(title: str, subtitle: str = ""):
    """Displays a stylized application banner."""
    content = Text()
    content.append(f"🎙️  {title}\n", style="bold cyan")
    if subtitle:
        content.append(f"{subtitle}\n", style="dim white")
    content.append("Powered by Solari Desktop SDK + LangGraph + Whisper + War Room UI", style="italic green")
    
    panel = Panel(
        content,
        border_style="bright_blue",
        title="[bold magenta]SOLARI VOICE COMPUTER-USE[/bold magenta]",
        subtitle="[dim]Autonomous Agent System[/dim]",
        padding=(1, 2)
    )
    console.print(panel)

def log_action_card(step_num: int, thought: str, action_type: str, action_details: str, status: str = "EXECUTING"):
    """Displays a formatted step action card."""
    table = Table(title=f"Step #{step_num} Action Card", show_header=False, border_style="cyan")
    table.add_column("Field", style="bold yellow", width=15)
    table.add_column("Value", style="white")

    table.add_row("Status", f"[bold green]{status}[/bold green]" if status == "SUCCESS" else f"[bold yellow]{status}[/bold yellow]")
    table.add_row("Reasoning", thought)
    table.add_row("Action", f"[bold cyan]{action_type.upper()}[/bold cyan]")
    table.add_row("Parameters", action_details)

    console.print(table)
