import sys
import argparse


def main():
    parser = argparse.ArgumentParser(
        description="Solari Voice Agent - Voice-Directed Computer-Use with Live War Room Observability"
    )
    parser.add_argument("--web", action="store_true", help="Launch the FastAPI War Room live web dashboard")
    parser.add_argument("--cli", action="store_true", help="Run interactive terminal CLI")
    parser.add_argument("--demo", action="store_true", help="Run automated recording demo")
    parser.add_argument("--task", type=str, default="", help="Task instruction string")
    parser.add_argument("--mic", action="store_true", help="Capture instruction via microphone")
    parser.add_argument("--mock", action="store_true", help="Use emulated mock desktop")

    args = parser.parse_args()

    if args.web or len(sys.argv) == 1:
        # Default behavior: Launch Web War Room Dashboard
        import run_dashboard
        run_dashboard.main()
    elif args.demo:
        import demo
        demo.main()
    elif args.cli:
        import cli
        cli.main()


if __name__ == "__main__":
    main()
