import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { KubeForwarder, type PortForwardHandle } from './kube.js';
import { log } from './logger.js';
import type { ResolvedConfig, ResolvedDependency, ResolvedService } from './types.js';

export function getService(config: ResolvedConfig, service: string): ResolvedService {
  const svc = config.services[service];
  if (!svc) throw new Error(`unknown service "${service}". Available: ${Object.keys(config.services).join(', ') || '(none)'}`);
  return svc;
}

function resolveServiceDir(config: ResolvedConfig, service: string, dir?: string): string | undefined {
  if (dir === undefined) return undefined;
  if (dir.trim() === '') throw new Error(`service "${service}" has an empty "dir"`);

  const cwd = resolve(dirname(config.path), dir);
  let stats;
  try {
    stats = statSync(cwd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'ENOENT'
        ? `service "${service}" "dir" does not exist: ${cwd}`
        : `cannot access service "${service}" "dir" at ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!stats.isDirectory()) throw new Error(`service "${service}" "dir" is not a directory: ${cwd}`);
  return cwd;
}

/** Show the kubeconfig context + forwarding plan and ask the user to confirm it. */
async function confirmKubeContext(
  forwarder: KubeForwarder,
  deps: readonly ResolvedDependency[],
  yes: boolean,
): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new Error('cannot run in a non-interactive shell without --yes');
  }
  log.info(`kubeconfig context: "${forwarder.contextName}"`);
  log.info(`  server: ${forwarder.server}`);
  log.info('forwarding:');
  for (const dep of deps) {
    log.info(`  ${dep.key}: ${dep.kind}/${dep.target} ${dep.port} -> 127.0.0.1:${dep.localPort}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Use this kubeconfig context? [y/N] ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    throw new Error(`aborted: kubeconfig context "${forwarder.contextName}" not confirmed`);
  }
}

/** Open the port-forwards for a service's dependencies. */
export async function forwardService(
  config: ResolvedConfig,
  service: string,
  yes = false,
): Promise<PortForwardHandle[]> {
  const deps = getService(config, service).dependencies;
  if (deps.length === 0) {
    log.warn(`service "${service}" declares no dependencies, nothing to forward`);
    return [];
  }

  const forwarder = new KubeForwarder({ kubeconfig: config.kubeconfig, context: config.context });
  await confirmKubeContext(forwarder, deps, yes);
  const handles: PortForwardHandle[] = [];
  for (const dep of deps) {
    log.info(`forwarding ${dep.kind}/${dep.target} (${dep.namespace}) ${dep.port} -> 127.0.0.1:${dep.localPort}`);
    try {
      handles.push(await forwarder.forward(dep));
      log.info(`${dep.key} ready at 127.0.0.1:${dep.localPort}`);
    } catch (err) {
      await cleanupHandles(handles);
      throw err;
    }
  }
  return handles;
}

export async function cleanupHandles(handles: readonly PortForwardHandle[]): Promise<void> {
  for (const handle of [...handles].reverse()) {
    try {
      handle.close();
    } catch {
      // already closed
    }
  }
}

/** Map each dependency to `LK_<KEY>_HOST/_PORT` env vars. */
export function buildEnv(deps: readonly ResolvedDependency[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const dep of deps) {
    const prefix = `LK_${dep.key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    env[`${prefix}_HOST`] = '127.0.0.1';
    env[`${prefix}_PORT`] = String(dep.localPort);
  }
  return env;
}

/** Resolve with the child exit, or the signal, whichever happens first. */
function waitChild(child?: ChildProcess): Promise<{ signal?: NodeJS.Signals | null; code?: number | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish({ signal, code });
    const onSignal = (signal: NodeJS.Signals) => finish({ signal, code: 0 });
    const finish = (outcome: { signal?: NodeJS.Signals | null; code?: number | null }) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      child?.off('exit', onExit);
      resolve(outcome);
    };
    child?.once('exit', onExit);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

/** Forward the service deps, run it locally, tear everything down on exit. */
export async function runLocal(config: ResolvedConfig, service: string, opts: { noEnv?: boolean; yes?: boolean } = {}): Promise<number> {
  const svc = getService(config, service);
  if (!svc.command) throw new Error(`service "${service}" has no "command" configured to run locally`);

  const cwd = resolveServiceDir(config, service, svc.dir);
  const handles = await forwardService(config, service, opts.yes);
  const env = opts.noEnv ? {} : buildEnv(svc.dependencies);

  log.info(`running "${svc.command}"${cwd ? ` in ${cwd}` : ''}`);
  const child = spawn(svc.command, {
    shell: true,
    cwd,
    env: { ...(process.env as Record<string, string>), ...env },
    stdio: 'inherit',
  });

  const { signal, code } = await waitChild(child);
  await cleanupHandles(handles);
  log.info('cleaned up');
  return signal ? 0 : (code ?? 1);
}

/** Forward a service's deps and keep them alive until interrupted. */
export async function forwardOnly(config: ResolvedConfig, service: string, yes = false): Promise<number> {
  const handles = await forwardService(config, service, yes);
  log.info(`forwarding active for "${service}". Press Ctrl-C to stop`);
  await waitChild();
  await cleanupHandles(handles);
  log.info('cleaned up');
  return 0;
}
