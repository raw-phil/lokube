import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { errMsg, log } from './logger.js';
import { buildEnv, forwardOnly, getService, runLocal } from './run.js';

export const VERSION = '1.0.0';

const EXAMPLE_CONFIG = `# lokube configuration
# Edit this file to describe the microservices you run locally and which
# cluster dependencies they need reachable through a port-forward.
# See examples/lokube.example.yaml for a fully commented example.

namespace: default

services:
  # The microservice you want to run and test locally.
  calendar-ms:
    command: "npm run dev"      # command started locally
    dir: "./calendar-ms"        # where the source lives (relative to this file)
    localPort: 3000             # local port the service listens on (informational)

    # Cluster-side microservices this service talks to. lokube port-forwards
    # each one via the Kubernetes API so your local instance can reach it.
    dependencies:
      users-ms:
        deployment: users-ms    # k8s target: deployment | service | pod | podSelector
        port: 8080              # container port to forward
        localPort: 8100         # local port exposed on 127.0.0.1
      resources-ms:
        deployment: resources-ms
        port: 8080
        localPort: 8200
`;

export function buildCli(): Command {
  const program = new Command();
  program
    .name('lokube')
    .description('Run Kubernetes microservices locally with port-forwarded cluster dependencies')
    .version(VERSION);

  program
    .option('-c, --config <path>', 'path to the lokube config file (default: discovered lokube.yaml/yml/json)')
    .option('--kubeconfig <path>', 'path to a kubeconfig file (default: $KUBECONFIG or ~/.kube/config)')
    .option('-n, --namespace <namespace>', 'override the default Kubernetes namespace')
    .option('--context <context>', 'override the kubeconfig context');

  program
    .command('list')
    .description('list the services defined in the config file')
    .action(async () => {
      await ok(async () => {
        const config = loadConfig(program.opts().config, program.opts());
        const services = Object.entries(config.services);
        const depKeys = services.flatMap(([, svc]) => svc.dependencies.map((d) => d.key));
        const nameW = Math.max(...services.map(([n]) => n.length), 7);
        const depW = Math.max(...depKeys.map((k) => k.length), 11);

        for (const [name, svc] of services) {
          const command = svc.command ? `command: ${svc.command}` : '(no local command)';
          log.info(`${name.padEnd(nameW)}  ${command}`);
          if (svc.dependencies.length === 0) {
            log.info(' '.repeat(nameW + 2) + '(no dependencies)');
            continue;
          }
          for (const dep of svc.dependencies) {
            const target = `${dep.kind}/${dep.target}`;
            const forward = `${dep.port} -> 127.0.0.1:${dep.localPort}`;
            log.info(' '.repeat(nameW + 2) + `${dep.key.padEnd(depW)}  ${target.padEnd(28)}  ${forward}`);
          }
        }
      });
    });

  program
    .command('init')
    .description('create a starter lokube config file in the current directory')
    .action(async () => {
      await ok(async () => {
        const target = join(process.cwd(), 'lokube.yaml');
        if (existsSync(target)) throw new Error(`${target} already exists`);
        writeFileSync(target, EXAMPLE_CONFIG, 'utf8');
        log.info(`created ${target}`);
      });
    });

  program
    .command('forward')
    .description('port-forward the cluster dependencies of a service without starting it')
    .argument('<service>', 'name of the service as defined in the config file')
    .option('-y, --yes', 'skip the kubeconfig context confirmation')
    .action(async (service: string, opts: { yes: boolean }) => {
      await ok(async () =>
        forwardOnly(loadConfig(program.opts().config, program.opts()), service, !!opts.yes),
      );
    });

  program
    .command('run')
    .description('start a service locally while port-forwarding its cluster dependencies')
    .argument('<service>', 'name of the service as defined in the config file')
    .option('--no-env', 'do not add LK_* environment variables for forwarded dependencies')
    .option('-y, --yes', 'skip the kubeconfig context confirmation')
    .action(async (service: string, opts: { env: boolean; yes: boolean }) => {
      const globalOpts = program.opts();
      await ok(async () => {
        const config = loadConfig(globalOpts.config, globalOpts);
        return runLocal(config, service, { noEnv: opts.env === false, yes: !!opts.yes });
      });
    });

  program
    .command('env')
    .description("print LK_* environment variables for a service's forwarded dependencies")
    .argument('<service>', 'name of the service as defined in the config file')
    .action(async (service: string) => {
      await ok(async () => {
        const config = loadConfig(program.opts().config, program.opts());
        for (const [key, value] of Object.entries(buildEnv(getService(config, service).dependencies))) {
          process.stdout.write(`${key}=${value}\n`);
        }
      });
    });

  return program;
}

async function ok(fn: () => Promise<number | void> | number | void): Promise<void> {
  try {
    const code = await fn();
    if (typeof code === 'number') process.exitCode = code;
  } catch (err) {
    log.error(errMsg(err));
    process.exitCode = 1;
  }
}