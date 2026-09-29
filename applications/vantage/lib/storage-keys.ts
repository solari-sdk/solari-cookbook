/**
 * Client-side storage keys. All of these live in `sessionStorage`, so they are
 * scoped to one browser tab and vanish when it closes — which is the behaviour
 * we want for an API key.
 */
export const ACTIVE_RUN_KEY = "cia:active-run";
export const PROVIDER_STORAGE_KEY = "cia:provider";
export const MODEL_STORAGE_KEY = "cia:model";

export const apiKeyStorageKey = (provider: string) => `cia:key:${provider}`;
