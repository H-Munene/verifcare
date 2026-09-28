import type { ScheduledHandler } from 'aws-lambda';

// Stub only (HEZ-23) - deliberately does not query visit_schedules or publish
// to SNS yet. Real logic is deferred to a follow-up issue, once HEZ-27
// establishes how a Lambda in this project resolves its DB credentials and
// builds a Drizzle client, so this doesn't invent a second, possibly
// inconsistent way of doing the same thing.
export const handler: ScheduledHandler = (event) => {
  console.log('missed-visit-sweep invoked', { time: event.time });
};
