import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readTickets } from '../../../dist/src/ticket-review-agent.js';

export default function ticketReview(pi) {
  const key = Symbol.for('pi-subagents.agent-providers');
  const providers = (globalThis[key] ??= new Map());
  const promptPath = fileURLToPath(new URL('./ticket-review.md', import.meta.url));
  providers.set('sawmill-ticket-review', () => [{
    name: 'ticket-review',
    description: 'Review all open tracker tickets against Logging and its template, or independently review a supplied ticket rewrite. Read-only; not code review.',
    tools: ['gh-axi', 'read'],
    systemPrompt: readFileSync(promptPath, 'utf8') + '\n\nLogging skill: ' +
      fileURLToPath(new URL('../skills/logging/SKILL.md', import.meta.url)) + '\nTicket template: ' +
      fileURLToPath(new URL('../skills/logging/ticket-template.md', import.meta.url)),
    filePath: promptPath,
  }]);
  pi.registerTool({
    name: 'gh-axi',
    label: 'gh-axi',
    defaultActive: false,
    description: 'Read GitHub tickets through gh-axi. Uses the verified millyard account. Issues, comments and blocked-by links return one 100-entry page; continue until an empty page. Project reads use a limit; increase it until the complete collection is returned. Responses above 50 KB or 2000 lines are saved for read. No writes or arbitrary commands.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['repo', 'action', 'millyard'],
      properties: {
        repo: { type: 'string', description: 'Configured owner/repository on github.com.' },
        millyard: { type: 'string', description: 'Verified absolute millyard path from caller preflight.' },
        action: { type: 'string', enum: ['issues', 'issue', 'comments', 'blocked-by', 'project-fields', 'project-items'] },
        page: { type: 'integer', minimum: 1 },
        ticket: { type: 'integer', minimum: 1 },
        project: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1 },
      },
    },
    async execute(_id, input, signal) {
      return readTickets(input, signal);
    },
  });
}
