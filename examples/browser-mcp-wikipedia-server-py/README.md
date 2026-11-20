# Wikipedia MCP server (Python)

A small [MCP](https://modelcontextprotocol.io) stdio server with two tools backed by a Solari browser:

- `search_wikipedia(query, limit=5)` runs Wikipedia's full-text search and returns a JSON list of `{title, snippet, url}`.
- `get_article(title)` takes a title or an en.wikipedia.org URL and returns `{title, summary, content, url}`. `summary` is the lead section before the first heading, `content` is the article's paragraphs capped at 20,000 characters, and `[1]`-style citation markers are removed from both.

Wikipedia's markup is stable, so plain selectors do the extraction and no model is needed: the JSON is exactly what the page says, shaped by Pydantic models. Each call launches its own browser and releases it before returning. stdout carries the protocol, so the server logs to stderr. Written for the `mcp` 2.x SDK (`MCPServer`).

## Run

```bash
cd examples/browser-mcp-wikipedia-server-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
npx @modelcontextprotocol/inspector --cli -e SOLARI_API_KEY="$SOLARI_API_KEY" python main.py --method tools/call --tool-name search_wikipedia --tool-arg query="analytical engine"
npx @modelcontextprotocol/inspector --cli -e SOLARI_API_KEY="$SOLARI_API_KEY" python main.py --method tools/call --tool-name get_article --tool-arg title="Ada Lovelace"
```

To use it from Claude Desktop, add it to `claude_desktop_config.json` with absolute paths, then restart the app:

```json
{
  "mcpServers": {
    "wikipedia": {
      "command": "/path/to/python",
      "args": ["/path/to/examples/browser-mcp-wikipedia-server-py/main.py"],
      "env": { "SOLARI_API_KEY": "slr_live_..." }
    }
  }
}
```

Source: [`main.py`](main.py)
