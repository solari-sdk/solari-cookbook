import unittest

from cache import LRUCache


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class HiddenTests(unittest.TestCase):
    def test_get_refreshes_recency(self):
        cache = LRUCache(2)
        cache.put("a", 1)
        cache.put("b", 2)
        cache.get("a")
        cache.put("c", 3)
        self.assertEqual(cache.get("a"), 1)
        self.assertIsNone(cache.get("b"))

    def test_put_existing_key_replaces_and_refreshes(self):
        cache = LRUCache(2)
        cache.put("a", 1)
        cache.put("b", 2)
        cache.put("a", 10)
        cache.put("c", 3)
        self.assertEqual(cache.get("a"), 10)
        self.assertIsNone(cache.get("b"))

    def test_len_counts_items(self):
        cache = LRUCache(3)
        for key in "abcd":
            cache.put(key, key)
        self.assertEqual(len(cache), 3)

    def test_capacity_one(self):
        cache = LRUCache(1)
        cache.put("a", 1)
        cache.put("b", 2)
        self.assertIsNone(cache.get("a"))
        self.assertEqual(cache.get("b"), 2)

    def test_item_expires_after_ttl(self):
        clock = FakeClock()
        cache = LRUCache(2, ttl_seconds=5, clock=clock)
        cache.put("a", 1)
        clock.now = 4.9
        self.assertEqual(cache.get("a"), 1)
        clock.now = 5.0
        self.assertIsNone(cache.get("a"))

    def test_put_resets_ttl(self):
        clock = FakeClock()
        cache = LRUCache(2, ttl_seconds=5, clock=clock)
        cache.put("a", 1)
        clock.now = 4
        cache.put("a", 2)
        clock.now = 8
        self.assertEqual(cache.get("a"), 2)

    def test_get_does_not_reset_ttl(self):
        clock = FakeClock()
        cache = LRUCache(2, ttl_seconds=5, clock=clock)
        cache.put("a", 1)
        clock.now = 4
        cache.get("a")
        clock.now = 6
        self.assertIsNone(cache.get("a"))

    def test_len_ignores_expired_items(self):
        clock = FakeClock()
        cache = LRUCache(3, ttl_seconds=5, clock=clock)
        cache.put("a", 1)
        clock.now = 3
        cache.put("b", 2)
        clock.now = 6
        self.assertEqual(len(cache), 1)

    def test_none_is_a_storable_value_shape(self):
        cache = LRUCache(2)
        cache.put("a", 0)
        self.assertEqual(cache.get("a"), 0)


if __name__ == "__main__":
    unittest.main()
