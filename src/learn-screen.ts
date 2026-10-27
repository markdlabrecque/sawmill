#!/usr/bin/env node
import { jevScreenOptions } from './jev-config.js';
import { z } from 'zod';
import { screenLearning } from './learn-screening.js';

// Separate opt-in: draft screening permission never permits delivery evidence uploads.
const identity = z.string().min(1).max(512);
const observationSchema = z.object({
  id: identity, incidentId: identity, basis: z.enum(['observed', 'inferred', 'predicted']),
  evidence: z.array(z.object({
    id: identity, source: identity, text: z.string(), truncated: z.boolean().optional(),
  }).strict()).max(32),
}).strict();

let report = await screenLearning([]);
try {
  if (process.argv.length !== 2) throw new Error('unexpected-arguments');
  const config = await jevScreenOptions(process.cwd(), 'learn');
  if (config.enabled === true) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 256 * 1024) throw new Error('observations-too-large');
      chunks.push(buffer);
    }
    // No counts, run state, coverage or transcripts are accepted by this boundary.
    const input = z.object({ observations: z.array(observationSchema).max(128) }).strict()
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    report = await screenLearning(input.observations, config);
  }
} catch {
  // The caller retains its original observations and continues the ordinary workflow.
  report.fallbackReason = 'screening-unavailable';
}
console.log(JSON.stringify(report));
