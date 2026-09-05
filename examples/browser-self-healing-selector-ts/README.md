# Self-healing selectors

Repair a broken selector instead of failing on it.

A scraper dies when someone renames an id. The element is still there — only
its address changed. This captures a semantic description of the element while
the selector still works, and uses it to re-find the element after a redesign.

```bash
npm install
export SOLARI_API_KEY=slr_live_...
export OPENROUTER_API_KEY=sk-or-v1-...
npm start
```

```
learned  : {"role":"button","name":"Export CSV","near":["Invoices","Export CSV","ready"]}
broken   : #export-btn no longer matches
repaired : #cta-dl
verified : it does the same thing
```

## The part worth stealing

**A repair is not accepted until a postcondition confirms it.** Without that
check, a confidently wrong answer reports itself as a success and you silently
click the wrong button on every subsequent run. Verification is what separates
a repair from a guess.

Two smaller things that matter:

- **The model never sees a selector.** Candidates are sent with an index, so it
  cannot invent a selector that is not on the page.
- **The page is set with `setContent`**, so the example is self-contained and
  reproducible — no third-party site to depend on or drift underneath you.

Built out as a full tool in [Understudy](https://github.com/Srinivasan8888/solari-cookbook/tree/understudy/understudy),
which measures this across ten classes of page drift.
