import type { ScheduledHandler } from 'aws-lambda';

// TODO: query visit_schedules and publish to SNS. Stub for now.
export const handler: ScheduledHandler = (event) => {
  console.log('missed-visit-sweep invoked', { time: event.time });
};
