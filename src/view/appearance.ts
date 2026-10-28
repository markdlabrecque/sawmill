import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../build-identity.js';

// Bundle the Board's brand assets into its document so it also works offline.
const asset = (name: string) => readFileSync(join(packageRoot, 'templates/board', name));
const dataUrl = (name: string, type: string) => `data:${type};base64,${asset(name).toString('base64')}`;

export const boardWordmark = dataUrl('sawmill-wordmark.svg', 'image/svg+xml');
export const boardIcon = dataUrl('sawmill-mark.svg', 'image/svg+xml');
export const boardTouchIcon = dataUrl('sawmill-touch-icon.png', 'image/png');
export const boardStyles = [
  ...[
    ['display', 'Mill Display', '900'],
    ['body-regular', 'Mill Body', '400'],
    ['body-semibold', 'Mill Body', '600 700'],
  ].map(([file, family, weight]) => `@font-face{font-family:'${family}';src:url(${dataUrl(file + '.woff2', 'font/woff2')}) format('woff2');font-weight:${weight};font-style:normal;font-display:swap}`),
  asset('board.css').toString('utf8'),
].join('\n');
