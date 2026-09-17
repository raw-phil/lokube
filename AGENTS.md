# AGENTS.md

Guidance for AI agents working on **lokube**, a Node.js + TypeScript (ESM) CLI
for testing Kubernetes microservices locally: it starts a service's local
command and opens TCP port-forwards to its cluster dependencies via the
Kubernetes API (no `kubectl` binary).

```
lokube list                       # show services + their dependency forwards (no cluster needed)
lokube init                       # scaffold an lokube.yaml in the CWD
lokube forward <service>          # only port-forward a service's dependencies
lokube run <service>              # forward deps, then run the local command
lokube env <service>              # print LK_* env vars a service's deps would inject
```

## Commands

```sh
npm install
npm run typecheck  # tsc --noEmit (strict); the only "lint" the repo has
npm run build      # tsc -> dist/ (gitignored; required before running)
```

There is **no test framework** and no test script. Verify with `npm run typecheck`
then a smoke test on built output (no cluster needed):
`node dist/index.js list -c examples/lokube.example.yaml`.
`run`/`forward` need a live cluster + kubeconfig.

## Layout

- `src/index.ts` — entrypoint: shebang, EPIPE-tolerant stdout/stderr, `buildCli().parse(process.argv)`.
- `src/cli.ts` — commander CLI tree and command wiring; `ok()` wraps each action to set exit code.
- `src/config.ts` — config discovery/parsing/validation → `ResolvedConfig`.
- `src/types.ts` — type declarations only (no logic).
- `src/kube.ts` — `KubeForwarder`: loads kubeconfig, resolves target to a ready pod, bridges a local `net.Server` to the client-node `PortForward` WebSocket.
- `src/run.ts` — orchestration: `forwardService`, `runLocal`, `forwardOnly`, `buildEnv`, signal handling.
- `src/logger.ts` — the only logger; has exactly `log.info/warn/error` + `errMsg` (no `step`/`ok`/`dim`).

## Config file (the contract)

`lokube.yaml` / `lokube.yml` / `lokube.json`, discovered in the CWD, or `-c <path>`. Eagerly validated: `loadConfig` validates **every**
service's dependencies up front, so a broken dependency fails even `lokube list`.

```yaml
namespace: dev            # default namespace for forwards
context: my-context       # optional kubeconfig context override
kubeconfig: ~/.kube/dev   # optional kubeconfig file override
services:
  calendar-ms:
    command: "npm run dev"      # started locally by `lokube run` (through a shell)
    dir: "./calendar-ms"        # working dir, relative to the config file
    localPort: 3000             # informational
    dependencies:
      users-ms:
        deployment: users-ms    # exactly ONE of deployment|service|pod|podSelector
        port: 8080              # required cluster port to forward
        localPort: 8100         # optional, defaults to port
```
Resolved deps default `localPort` to `port` and `namespace` to the top-level
namespace. `LK_<KEY>_HOST/PORT` env vars are named from the dependency key
(upper-cased, non-alnum → `_`).

## Gotchas (read before editing)

- **ESM only.** `"type": "module"` + NodeNext; relative imports need `.js` extensions.
- **Kube context gate.** `run`/`forward` print the context (name + server) and the
  forwarding plan, then prompt `[y/N]` before opening forwards; refusing aborts
  with exit 1. Non-interactive shells (no TTY) **must** pass `--yes` or lokube
  refuses to run. `--yes` skips the gate entirely. Don't remove this.
- **Commander 15 `--no-env` quirk.** A lone `--no-<flag>` option always yields the
  flag as `true` unless passed; read it as `opts.env === false`, never
  `opts.env`. (See `cli.ts` `run` handler, `{ noEnv: opts.env === false }`.)
- **Cleanup.** `forwardService` closes all handles on any dependency failure;
  `runLocal`/`forwardOnly` tear down on exit / SIGINT/SIGTERM. Never leave
  sockets or WebSockets dangling or the process won't exit.
- **Version.** `VERSION` constant in `src/cli.ts` must stay in sync with
  `package.json` `version`.
- `src/index.ts` swallows EPIPE on stdout/stderr so piped output (e.g. `env | grep`)
  doesn't crash — preserve that behavior.

## Conventions

- Keep `src/types.ts` declarative; compose with TS utilities (`Omit`, `Pick`, `Required`), don't re-declare shapes.
- No comments unless they explain non-obvious behavior.
- New per-service/per-dependency config options belong in `types.ts` + validation in `config.ts`, and must be documented in `examples/lokube.example.yaml`.