import type { SortDirection } from './Table';

/**
 * Sort state for a list whose API takes "key" / "-key": which column, which way, and what the
 * next click on a column should ask for (the other way if it's the current column, else
 * ascending).
 */
export function sortState<K extends string>(sort: `${K}` | `-${K}`) {
  const descending = sort.startsWith('-');
  const key = (descending ? sort.slice(1) : sort) as K;
  return {
    directionOf: (column: K): SortDirection | undefined =>
      column === key ? (descending ? 'descending' : 'ascending') : undefined,
    toggled: (column: K): `${K}` | `-${K}` =>
      column === key && !descending ? `-${column}` : `${column}`,
  };
}
