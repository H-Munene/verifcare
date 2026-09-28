import { useState } from 'react';

/**
 * Previous/Next paging over a cursor-paginated list: a stack of the cursors seen so far. It
 * starts again from the first page whenever [resetKey] changes - a new filter or sort - since a
 * cursor from one ordering means nothing in another (the API refuses it).
 */
export function useCursorPages(resetKey: string) {
  const [state, setState] = useState<{ key: string; stack: (string | undefined)[] }>({
    key: resetKey,
    stack: [undefined],
  });
  const stack = state.key === resetKey ? state.stack : [undefined];
  return {
    cursor: stack[stack.length - 1],
    canGoBack: stack.length > 1,
    back: () => setState({ key: resetKey, stack: stack.slice(0, -1) }),
    next: (cursor: string) => setState({ key: resetKey, stack: [...stack, cursor] }),
  };
}
