import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { log } from './logger.js';
import type {
  Config,
  DepTargetKind,
  ResolvedConfig,
  ResolvedDependency,
  ResolvedService,
} from './types.js';

export class ConfigError extends Error {}

const CONFIG_FILE_NAMES = ['lokube.yaml', 'lokube.yml', 'lokube.json'];
const DEP_TARGET_KEYS = ['deployment', 'service', 'pod', 'podSelector'] as const;
const ENV_PLACEHOLDERS = new Set(['HOST', 'PORT']);

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function checkRecord(value: unknown, what: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`"${what}" must be a mapping/object, got ${describe(value)}`);
  }
}

function asString(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ConfigError(`"${what}" must be a string, got ${describe(value)}`);
  return value;
}

function asPositiveInt(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`"${what}" must be an integer between 1 and 65535, got ${describe(value)}`);
  }
  return n;
}

function validateEnv(value: unknown, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  checkRecord(value, what);
  const env: Record<string, string> = {};
  for (const [name, template] of Object.entries(value)) {
    if (typeof template !== 'string') {
      throw new ConfigError(`"${what}.${name}" must be a string, got ${describe(template)}`);
    }
    for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
      if (!ENV_PLACEHOLDERS.has(match[1] as string)) {
        throw new ConfigError(`"${what}.${name}" uses unknown placeholder "{${match[1]}}" (use {HOST} or {PORT})`);
      }
    }
    env[name] = template;
  }
  return env;
}

function findConfigPath(explicit?: string): string {
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);
    return path;
  }
  const found = CONFIG_FILE_NAMES.map((name) => join(process.cwd(), name)).find(existsSync);
  if (found) return found;
  throw new ConfigError(
    `no config file found (looked for ${CONFIG_FILE_NAMES.join(', ')} in "${process.cwd()}"). ` +
      'Run "lokube init" to create one.',
  );
}

export type ConfigOverrides = Pick<Config, 'namespace' | 'context' | 'kubeconfig'>;

export function loadConfig(explicit?: string, overrides?: ConfigOverrides): ResolvedConfig {
  const path = findConfigPath(explicit);
  log.info(`config: ${path}`);

  let raw: unknown;
  try {
    const text = readFileSync(path, 'utf8');
    raw = path.toLowerCase().endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new ConfigError(`failed to parse "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateConfig(raw ?? {}, path, overrides);
}

function validateConfig(value: unknown, path: string, overrides?: ConfigOverrides): ResolvedConfig {
  checkRecord(value, 'config root');
  const raw = value as Config;

  const namespace = overrides?.namespace ?? raw.namespace ?? 'default';

  const services: Record<string, ResolvedService> = {};
  if (raw.services !== undefined) {
    checkRecord(raw.services, 'services');
    for (const [name, cfg] of Object.entries(raw.services)) {
      services[name] = validateService(cfg, `services.${name}`, namespace);
    }
  }
  if (Object.keys(services).length === 0) {
    throw new ConfigError('config must define at least one service under "services"');
  }

  return {
    path,
    namespace,
    context: overrides?.context ?? raw.context,
    kubeconfig: overrides?.kubeconfig ?? raw.kubeconfig,
    services,
  };
}

function validateService(value: unknown, what: string, defaultNamespace: string): ResolvedService {
  checkRecord(value, what);
  const svc = value as Record<string, unknown>;

  const dependencies: ResolvedDependency[] = [];
  if (svc.dependencies !== undefined) {
    checkRecord(svc.dependencies, `${what}.dependencies`);
    for (const [key, dep] of Object.entries(svc.dependencies)) {
      checkRecord(dep, `${what}.dependencies.${key}`);
      dependencies.push({
        key,
        ...validateDependency(dep, `${what}.dependencies.${key}`, defaultNamespace),
      });
    }
  }

  const envNames = new Map<string, string>();
  for (const dependency of dependencies) {
    for (const name of Object.keys(dependency.env ?? {})) {
      const previous = envNames.get(name);
      if (previous) {
        throw new ConfigError(
          `environment variable "${name}" is configured by both "${previous}" and "${what}.dependencies.${dependency.key}.env.${name}"`,
        );
      }
      envNames.set(name, `${what}.dependencies.${dependency.key}.env.${name}`);
    }
  }

  const localPort = asPositiveInt(svc.localPort, `${what}.localPort`);
  const dir = asString(svc.dir, `${what}.dir`);
  const occupiedPorts = new Map<number, string>();
  if (localPort !== undefined) occupiedPorts.set(localPort, `${what}.localPort`);
  for (const dependency of dependencies) {
    const previous = occupiedPorts.get(dependency.localPort);
    if (previous) {
      throw new ConfigError(
        `local port ${dependency.localPort} is used by both "${previous}" and "${what}.dependencies.${dependency.key}.localPort"`,
      );
    }
    occupiedPorts.set(dependency.localPort, `${what}.dependencies.${dependency.key}.localPort`);
  }

  return {
    command: asString(svc.command, `${what}.command`),
    dir,
    localPort,
    dependencies,
  };
}

function validateDependency(
  value: unknown,
  what: string,
  defaultNamespace: string,
): Omit<ResolvedDependency, 'key'> {
  checkRecord(value, what);
  const dep = value as Record<string, unknown>;

  const targets = DEP_TARGET_KEYS.flatMap((kind) => {
    const target = asString(dep[kind], `${what}.${kind}`);
    return target === undefined ? [] : [{ kind, target }];
  });
  if (targets.length !== 1) {
    const hint = DEP_TARGET_KEYS.join('/');
    throw new ConfigError(
      targets.length === 0
        ? `"${what}" must define one target: ${hint} (e.g. "deployment: users-ms")`
        : `"${what}" defines multiple targets; pick one of ${hint}`,
    );
  }
  const { kind, target } = targets[0] as { kind: DepTargetKind; target: string };

  const port = asPositiveInt(dep.port, `${what}.port`);
  if (port === undefined) {
    throw new ConfigError(`"${what}.port" is required (the cluster port to forward)`);
  }

  return {
    kind,
    target,
    port,
    localPort: asPositiveInt(dep.localPort, `${what}.localPort`) ?? port,
    namespace: asString(dep.namespace, `${what}.namespace`) ?? defaultNamespace,
    env: validateEnv(dep.env, `${what}.env`),
  };
}
