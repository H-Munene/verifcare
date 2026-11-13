import { Button } from './Button';
import './LoadError.css';

// Where a page's content would be when it failed to load. The toast (main.tsx) says why; this stays
// after the toast has gone, so the page is never left blank, and offers another try.
export function LoadError({ what = 'this', onRetry }: { what?: string; onRetry: () => void }) {
  return (
    <div className="ds-load-error" role="status">
      <span>Couldn&rsquo;t load {what}.</span>
      <Button type="button" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
