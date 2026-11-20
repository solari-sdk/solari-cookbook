# Run pytest browser tests on Solari (Python)

Two pytest fixtures put your async Playwright tests on a cloud browser. `browser` opens one Solari session for the whole run and releases it when pytest exits, pass or fail. `page` gives each test a fresh tab in that session. Nothing is installed or launched locally.

The sample tests read example.com, then fill Wikipedia's search box and assert the result page's heading. Tests share the session's cookies and storage; call `browser.new_context()` in a test that needs isolation. The SDK drives the browser with patchright, a Playwright fork with the same API, so import `expect` from `patchright.async_api` rather than `playwright.async_api`, or it will reject the page's locators.

For parallel runs, `pytest -n 4` (with `pytest-xdist`) gives each worker process its own session-scoped fixture, so it opens four sessions. Keep that within your plan's concurrency limit.

## Run

```bash
cd examples/browser-pytest-runner-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
pytest -v
```

Source: [`conftest.py`](conftest.py) · [`test_search.py`](test_search.py)
