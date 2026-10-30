# Assert on the delivered page (Python)

A browser can navigate, record a session, and save a screenshot without
completing the requested task. Check the delivered content before declaring
success.

This example asks for a pricing page at `https://example.com/pricing`. That
missing path has been observed to render the ordinary **Example Domain** page:
`goto()` and `screenshot()` succeed, but the title and heading do not match
**Pricing**. The content check raises `AssertionError` and exits nonzero; the
`finally` block still releases the recorded session.

## Run

```bash
cd examples/browser-page-assertions-py
pip install -r requirements.txt
export SOLARI_API_KEY=slr_live_...   # https://console.getsolari.com
python main.py                     # negative case: expect AssertionError
python main.py homepage            # positive control: expect PASS
```

Each run saves `screenshot.png` (gitignored, overwritten on the next run) and
prints the session ID, HTTP status, title, and heading. Recording is requested
per session. To download a replay when available, see
[browser-session-recording-py](../browser-session-recording-py).

Live verification returned HTTP 200 / exit 0 for the homepage and HTTP 404 /
exit 1 for pricing, with a screenshot saved in both cases. Both sessions were
confirmed released. Their replay endpoints returned 404, including after the
recording example's retry window; replay availability is not verified here.

`example.com` is an external site, not a fixed test fixture: its missing-page
response can change. A transport failure is not the demonstrated content-check
failure. HTTP errors also need checking in real tasks; even HTTP 200, a valid
screenshot, or a replay is not sufficient proof that the result is correct.
These two exact content checks are the contract for this tiny example, not a
general-purpose page evaluator.

Source: [`main.py`](main.py)
