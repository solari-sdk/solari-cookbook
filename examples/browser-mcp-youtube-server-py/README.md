# YouTube MCP server (Python)

A small [MCP](https://modelcontextprotocol.io) stdio server with two tools backed by a Solari browser:

- `get_video_description(url)` returns a video's title, channel, view count, publish date and full description as JSON.
- `get_channel_videos(channel, limit=10)` takes a handle like `@NASA` or a channel URL and returns its latest uploads as a JSON list of `{title, link, views, published}`.

YouTube builds its pages with JavaScript, so a plain HTTP fetch gets a shell. The description tool reads the player data the watch page was rendered from, which holds the whole description, so there's no "...more" button to click. The channel tool opens the Videos tab and scrolls until enough cards have rendered. Channel cards come in two markups at the moment, and the selectors cover both. Each call launches its own browser and releases it before returning, and the server logs to stderr because stdout carries the protocol. Written for the `mcp` 2.x SDK (`MCPServer`).

## Run

```bash
cd examples/browser-mcp-youtube-server-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npx @modelcontextprotocol/inspector --cli -e SOLARI_API_KEY="$SOLARI_API_KEY" python main.py --method tools/call --tool-name get_channel_videos --tool-arg channel=@NASA --tool-arg limit=5
npx @modelcontextprotocol/inspector --cli -e SOLARI_API_KEY="$SOLARI_API_KEY" python main.py --method tools/call --tool-name get_video_description --tool-arg url="https://www.youtube.com/watch?v=<id>"
```

To use it from Claude Desktop, add it to `claude_desktop_config.json` with absolute paths, then restart the app:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "/path/to/python",
      "args": ["/path/to/examples/browser-mcp-youtube-server-py/main.py"],
      "env": { "SOLARI_API_KEY": "slr_live_..." }
    }
  }
}
```

Source: [`main.py`](main.py)
