import type { BadgeTone } from '../design-system/Badge';

// A visit status's badge colour and wording, shared by every table and panel that shows one.
// Completed is the only success; missed and investigated are the failures; the rest are neutral.
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'missed':
    case 'investigated':
      return 'danger';
    default:
      return 'neutral';
  }
}

// "Checked In"/"Checked Out" read far more naturally than the raw in_progress/completed status
// names; the underlying values are unchanged, this is display-only.
export function statusLabel(status: string): string {
  switch (status) {
    case 'in_progress':
      return 'Checked In';
    case 'completed':
      return 'Checked Out';
    default:
      return status.replace('_', ' ');
  }
}
