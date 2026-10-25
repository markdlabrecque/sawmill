export type RunSelection = { kind: 'numbers'; numbers: number[] } | { kind: 'label'; label: string } | { kind: 'spec'; number: number };

export function parseDraftArgs(args: string[]): { selection: RunSelection; replace: boolean; includeClosed: boolean } | undefined {
  const values = args.filter(arg => arg !== '--replace' && arg !== '--include-closed');
  const replace = args.includes('--replace');
  const includeClosed = args.includes('--include-closed');
  if (values[0] === '--label' && values.length === 2 && values[1]!.trim() && !values[1]!.startsWith('--')) {
    return { selection: { kind: 'label', label: values[1]! }, replace, includeClosed };
  }
  if (values[0] === '--spec' && values.length === 2 && /^[1-9]\d*$/.test(values[1]!) && Number.isSafeInteger(Number(values[1]))) {
    return { selection: { kind: 'spec', number: Number(values[1]) }, replace, includeClosed };
  }
  if (values.length && values.every(arg => /^[1-9]\d*$/.test(arg) && Number.isSafeInteger(Number(arg)))) {
    return { selection: { kind: 'numbers', numbers: [...new Set(values.map(Number))] }, replace, includeClosed };
  }
}
