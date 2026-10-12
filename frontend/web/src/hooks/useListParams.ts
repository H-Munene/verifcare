import { useSearchParams } from 'react-router-dom';

/**
 * A list page's filters and sort, kept in the URL's query string so a reload or a shared link
 * keeps them. Changes replace the history entry rather than adding one per click.
 */
export function useListParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  function update(apply: (next: URLSearchParams) => void) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        apply(next);
        return next;
      },
      { replace: true },
    );
  }

  return {
    /** The value, or '' when unset. */
    get: (key: string) => searchParams.get(key) ?? '',
    /** The value if it's one of [allowed], else [fallback] - a hand-edited URL can't break it. */
    oneOf: <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
      const value = searchParams.get(key) as T | null;
      return value && allowed.includes(value) ? value : fallback;
    },
    /** Sets a value; '' removes it. */
    set: (key: string, value: string) =>
      update((next) => (value ? next.set(key, value) : next.delete(key))),
    clear: (keys: string[]) => update((next) => keys.forEach((key) => next.delete(key))),
  };
}
