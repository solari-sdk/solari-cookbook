import uvicorn
import webbrowser
import threading
import time
from src.config import settings
from src.utils.logger import log_banner, console


def open_browser(url: str):
    time.sleep(1.2)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def main():
    log_banner(
        title="SOLARI VOICE AGENT - WAR ROOM LIVE DASHBOARD",
        subtitle=f"Starting FastAPI & WebSocket server at http://{settings.server_host}:{settings.server_port}"
    )

    url = f"http://{settings.server_host}:{settings.server_port}"
    console.print(f"[bold green]🚀 Dashboard URL:[/bold green] [underline cyan]{url}[/underline cyan]\n")

    # Open browser automatically in a background thread
    threading.Thread(target=open_browser, args=(url,), daemon=True).start()

    # Launch Uvicorn
    uvicorn.run(
        "src.server.app:app",
        host=settings.server_host,
        port=settings.server_port,
        log_level="info",
        reload=False
    )


if __name__ == "__main__":
    main()
