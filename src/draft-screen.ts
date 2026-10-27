#!/usr/bin/env node
import { jevScreenOptions } from './jev-config.js';
import { z } from 'zod';
import { screenDraft } from './draft-screening.js';

// This independent opt-in cannot affect drafting, activation or the scheduler.
const ticketSchema = z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string(),
  labels: z.array(z.string()), trackerState: z.enum(['open', 'closed']),
  blockedBy: z.array(z.number().int().positive()).nullable(),
  comments: z.array(z.object({ body: z.string() })),
});

let report = await screenDraft([]);
try {
  const config = await jevScreenOptions(process.cwd(), 'draft');
  if (config.enabled === true) {
    let input = '';
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('snapshot-too-large');
      input += chunk.toString();
    }
    const snapshot = z.object({ status: z.literal('ok'), tickets: z.array(ticketSchema) }).parse(JSON.parse(input));
    report = await screenDraft(snapshot.tickets.map(ticket => ({ ...ticket, state: ticket.trackerState })), config);
  }
} catch {
  // Even parse/SDK errors may contain raw ticket text. Emit only a fixed reason.
  report.fallbackReason = 'screening-unavailable';
}
// Read-only, best effort: inability to screen must never refuse a valid draft.
console.log(JSON.stringify(report));
