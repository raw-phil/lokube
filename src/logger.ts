const codes = {
  reset: '\u001b[0m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
} as const;

type Level = 'INFO' | 'WARN' | 'ERROR';

const levelStyle: Record<Level, keyof typeof codes> = {
  INFO: 'cyan',
  WARN: 'yellow',
  ERROR: 'red',
};

function useColor(dest: NodeJS.WriteStream): boolean {
  return Boolean(dest.isTTY);
}

function paint(text: string, code: keyof typeof codes, dest: NodeJS.WriteStream): string {
  return useColor(dest) ? `${codes[code]}${text}${codes.reset}` : text;
}

function write(channel: 'stdout' | 'stderr', level: Level, args: unknown[]): void {
  const dest = channel === 'stdout' ? process.stdout : process.stderr;
  const msg = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(' ');
  dest.write(`${paint(`[${level}]`, levelStyle[level], dest)} ${msg}\n`);
}

export const log = {
  info: (...args: unknown[]) => write('stdout', 'INFO', args),
  warn: (...args: unknown[]) => write('stderr', 'WARN', args),
  error: (...args: unknown[]) => write('stderr', 'ERROR', args),
};

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}