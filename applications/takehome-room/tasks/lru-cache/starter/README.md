# LRU cache with expiry

Implement `LRUCache` in `cache.py`.

- `LRUCache(capacity, ttl_seconds=None, clock=time.monotonic)` makes a cache that holds at most `capacity` items.
- `get(key)` returns the value, or `None` if the key is missing or expired. A successful `get` makes the key the most recently used.
- `put(key, value)` adds or replaces a value and makes the key the most recently used. If the cache is full, it removes the least recently used key first.
- If `ttl_seconds` is set, an item expires `ttl_seconds` after its last `put`. Use `clock()` for the time, so tests can control it.
- `len(cache)` returns the number of items that have not expired.

You can use any tools you like, including AI assistants. Commit your work with Git as you go. Your commit history is part of what the reviewer reads.

Run the visible tests:

    python3 -m unittest discover -s tests -v

The reviewer also runs hidden tests that you cannot see.
