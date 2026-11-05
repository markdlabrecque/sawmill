import type { ProjectConfig } from './config.js';

/** OSC 8 terminal hyperlink; terminals without support show only the text. */
export const hyperlink = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

export function ticketUrl(tracker: ProjectConfig['tracker'], number: number): string {
  const gitlab = tracker.backend === 'gitlab';
  return `https://${tracker.host ?? (gitlab ? 'gitlab.com' : 'github.com')}/${tracker.repo}/${gitlab ? '-/' : ''}issues/${number}`;
}

/** `#<n>` (or a command argument), linked to the ticket's web page when links are on. */
export function ticketRef(tracker: ProjectConfig['tracker'], number: number, links: boolean, text = `#${number}`): string {
  return links ? hyperlink(ticketUrl(tracker, number), text) : text;
}
