// apps/storefront/tests/helpers/env.ts
//
// Test-environment bootstrap. Imported FIRST in tests/run.ts so its module-
// scope side effects run before any storefront src module is evaluated:
//
//   - Sets the NEXT_PUBLIC_* env vars the API client reads at module scope
//     (default storefront region / sales channel / currency). The API base URL
//     is resolved per-request (see src/lib/api/client.ts `apiBaseUrl()`), so
//     tests point it at an in-process server via testServer.listen().
//   - Installs an in-memory `window`/`localStorage` shim so the SSR-guarded
//     token store (src/lib/api/auth.ts) and cart-id persistence
//     (src/lib/cart.ts) behave as they do in the browser. This is a seam for
//     testing, not a mock of the fetch/API layer.

const KEY = "__QUHA_TEST_STORAGE__";

function createMemoryStorage() {
  let store = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store = new Map();
    },
    key(index: number): string | null {
      return [...store.keys()][index] ?? null;
    },
    get length(): number {
      return store.size;
    },
  };
}

const storage = createMemoryStorage();

(globalThis as unknown as Record<string, unknown>).localStorage = storage;
(globalThis as unknown as Record<string, unknown>).window = {
  localStorage: storage,
} as Window;

/** Wipe the in-memory storage between tests. */
export function resetClientStorage(): void {
  storage.clear();
}

process.env.NEXT_PUBLIC_DEFAULT_REGION_ID = process.env.NEXT_PUBLIC_DEFAULT_REGION_ID ?? "reg-test";
process.env.NEXT_PUBLIC_DEFAULT_SALES_CHANNEL_ID =
  process.env.NEXT_PUBLIC_DEFAULT_SALES_CHANNEL_ID ?? "channel-test";
process.env.NEXT_PUBLIC_DEFAULT_REGION_CURRENCY =
  process.env.NEXT_PUBLIC_DEFAULT_REGION_CURRENCY ?? "NGN";

export const TEST_REGION_ID = process.env.NEXT_PUBLIC_DEFAULT_REGION_ID;
export const TEST_SALES_CHANNEL_ID = process.env.NEXT_PUBLIC_DEFAULT_SALES_CHANNEL_ID;
export const TEST_CURRENCY = process.env.NEXT_PUBLIC_DEFAULT_REGION_CURRENCY ?? "NGN";

// Silence the unused warning for the KEY constant (kept for potential debugging).
void KEY;