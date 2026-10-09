import time


class LRUCache:
    def __init__(self, capacity, ttl_seconds=None, clock=time.monotonic):
        raise NotImplementedError

    def get(self, key):
        raise NotImplementedError

    def put(self, key, value):
        raise NotImplementedError

    def __len__(self):
        raise NotImplementedError
