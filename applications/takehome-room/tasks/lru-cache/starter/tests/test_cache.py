import unittest

from cache import LRUCache


class VisibleTests(unittest.TestCase):
    def test_get_returns_what_was_put(self):
        cache = LRUCache(2)
        cache.put("a", 1)
        self.assertEqual(cache.get("a"), 1)

    def test_missing_key_is_none(self):
        self.assertIsNone(LRUCache(2).get("nope"))

    def test_evicts_least_recently_used(self):
        cache = LRUCache(2)
        cache.put("a", 1)
        cache.put("b", 2)
        cache.put("c", 3)
        self.assertIsNone(cache.get("a"))
        self.assertEqual(cache.get("c"), 3)


if __name__ == "__main__":
    unittest.main()
