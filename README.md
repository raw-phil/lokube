# lokube

Test Kubernetes microservices locally. `lokube` starts a service's local command and opens TCP port-forwards to its cluster dependencies via the Kubernetes API — no `kubectl` binary required.

## Install

```sh
npm install -g lokube

# or run without installing
npx lokube --help
```

Requires Node.js >= 20 and a reachable Kubernetes cluster (via kubeconfig).

## Usage

```sh
lokube init                       # scaffold a lokube.yaml in the current dir
lokube list                       # show services + their dependency forwards
lokube run <service>              # forward deps, then run the local command
lokube forward <service>          # only port-forward a service's dependencies
lokube env <service>              # print LK_* env vars a service's deps inject
```

`run` and `forward` print the kubeconfig context and forwarding plan, then ask for confirmation. Pass `--yes` to skip it (required in non-interactive shells).

Each forwarded dependency `foo-ms` injects `LK_FOO_MS_HOST` and `LK_FOO_MS_PORT` pointing at `127.0.0.1`.

## Configuration

`lokube init` creates a starter `lokube.yaml`. A minimal example:

```yaml
namespace: dev
services:
  calendar-ms:
    command: "npm run dev"
    dir: "./calendar-ms"
    dependencies:
      users-ms:
        deployment: users-ms   # or service | pod | podSelector
        port: 8080
        localPort: 8100
```

See `examples/lokube.example.yaml` for the full, commented reference. Config is discovered in the current directory (`lokube.yaml`, `lokube.yml`, or `lokube.json`), or via `-c <path>`.

## License

[MIT](LICENSE)