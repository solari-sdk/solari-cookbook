// Adapted from pingdotgg/t3code apps/web/src/hooks/useLocalStorage.ts at 57a66608 (MIT).
import { useCallback, useMemo, useSyncExternalStore } from "react";

export interface Codec<T> {
  decode: (raw: string) => T;
  encode: (value: T) => string;
}

export const finiteNumber: Codec<number> = {
  decode: (raw) => {
    const value = Number(JSON.parse(raw));
    if (!Number.isFinite(value)) throw new Error(`Expected a finite number, got ${raw}.`);
    return value;
  },
  encode: (value) => JSON.stringify(value),
};

export class LocalStorageOperationError extends Error {
  constructor(
    readonly operation: "read" | "decode" | "encode" | "update" | "write" | "remove" | "notify",
    readonly storageKey: string,
    readonly cause: unknown,
  ) {
    super(`Failed to ${operation} local storage item ${storageKey}.`);
    this.name = "LocalStorageOperationError";
  }
}

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (_) => store.get(_) ?? null,
          key: (_) => [...store.keys()].at(_) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (_) => store.delete(_),
          setItem: (_, value) => store.set(_, value),
        };
      })();

const read = (key: string) => {
  try {
    return isomorphicLocalStorage.getItem(key);
  } catch (cause) {
    throw new LocalStorageOperationError("read", key, cause);
  }
};

const decode = <T>(key: string, codec: Codec<T>, value: string) => {
  try {
    return codec.decode(value);
  } catch (cause) {
    throw new LocalStorageOperationError("decode", key, cause);
  }
};

const encode = <T>(key: string, codec: Codec<T>, value: T) => {
  try {
    return codec.encode(value);
  } catch (cause) {
    throw new LocalStorageOperationError("encode", key, cause);
  }
};

export const getLocalStorageItem = <T>(key: string, codec: Codec<T>): T | null => {
  const item = read(key);
  return item ? decode(key, codec, item) : null;
};

export const setLocalStorageItem = <T>(key: string, value: T, codec: Codec<T>) => {
  const valueToSet = encode(key, codec, value);
  try {
    isomorphicLocalStorage.setItem(key, valueToSet);
  } catch (cause) {
    throw new LocalStorageOperationError("write", key, cause);
  }
};

export const removeLocalStorageItem = (key: string) => {
  try {
    isomorphicLocalStorage.removeItem(key);
  } catch (cause) {
    throw new LocalStorageOperationError("remove", key, cause);
  }
};

const LOCAL_STORAGE_CHANGE_EVENT = "wsp:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
        detail: { key },
      }),
    );
  } catch (cause) {
    throw new LocalStorageOperationError("notify", key, cause);
  }
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  codec: Codec<T>,
): [T, (value: T | ((val: T) => T)) => void] {
  const getSnapshot = useCallback(() => {
    try {
      return read(key);
    } catch (error) {
      console.error("[LOCALSTORAGE] Could not read stored value.", error);
      return null;
    }
  }, [key]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const handleStorageChange = (event: StorageEvent) => {
        if (event.key === key) {
          onStoreChange();
        }
      };
      const handleLocalChange = (event: CustomEvent<LocalStorageChangeDetail>) => {
        if (event.detail.key === key) {
          onStoreChange();
        }
      };

      window.addEventListener("storage", handleStorageChange);
      window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
      return () => {
        window.removeEventListener("storage", handleStorageChange);
        window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
      };
    },
    [key],
  );

  const serializedValue = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const storedValue = useMemo(() => {
    if (serializedValue === null) {
      return initialValue;
    }
    try {
      return decode(key, codec, serializedValue);
    } catch (error) {
      console.error("[LOCALSTORAGE] Could not decode stored value.", error);
      return initialValue;
    }
  }, [initialValue, key, codec, serializedValue]);

  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      try {
        const currentValue = getLocalStorageItem(key, codec) ?? initialValue;
        let valueToStore: T;
        if (typeof value === "function") {
          try {
            valueToStore = (value as (val: T) => T)(currentValue);
          } catch (cause) {
            throw new LocalStorageOperationError("update", key, cause);
          }
        } else {
          valueToStore = value;
        }
        if (valueToStore === null) {
          removeLocalStorageItem(key);
        } else {
          setLocalStorageItem(key, valueToStore, codec);
        }
        dispatchLocalStorageChange(key);
      } catch (error) {
        console.error("[LOCALSTORAGE] Could not update stored value.", error);
      }
    },
    [initialValue, key, codec],
  );

  return [storedValue, setValue];
}
