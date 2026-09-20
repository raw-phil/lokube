/**
 * Kubernetes object kind a dependency forward targets.
 * `podSelector` resolves the first ready pod matching a `key=value,key=value`
 * label selector.
 */
export type DepTargetKind = 'deployment' | 'service' | 'pod' | 'podSelector';

/**
 * One cluster-side dependency as written in the config file: a Kubernetes
 * object plus the ports to bridge. Each entry becomes a local forward.
 *
 * @example { deployment: "users-ms", port: 8080, localPort: 8100 }
 */
export type DependencyConfig = {
  /** Name of the Kubernetes Deployment to forward (resolved to its first ready pod).
   *  @example "users-ms" */
  deployment?: string;
  /** Name of the Kubernetes Service to forward (resolved to a ready backend pod).
   *  @example "auth-service" */
  service?: string;
  /** Exact name of a Kubernetes Pod to forward.
   *  @example "calendar-ms-7f9a1-abcde" */
  pod?: string;
  /** Label selector of the pod to forward; exactly one of the four target keys must be set.
   *  @example "app=worker,version=latest" */
  podSelector?: string;
  /** Container port inside the cluster to tunnel (required).
   *  @example 8080 */
  port?: number;
  /** Port bound on 127.0.0.1; defaults to `port` when omitted.
   *  @example 8100 */
  localPort?: number;
  /** Namespace of the target; defaults to the top-level `namespace`.
   *  @example "dev" */
  namespace?: string;
  /** Environment variables to inject; `{HOST}` and `{PORT}` use the local forward values.
   *  @example { USERS_URL: "http://{HOST}:{PORT}" } */
  env?: Record<string, string>;
}

/**
 * One microservice as written under `services` in the config file: how to start
 * it locally and which cluster dependencies it needs forwarded.
 */
export type ServiceConfig = {
  /** Shell command that starts the service locally (needed for `lokube run`).
   *  @example "npm run dev" */
  command?: string;
  /** Working directory for the command, relative to the config file.
   *  @example "./calendar-ms" */
  dir?: string;
  /** Port the local service listens on (informational only).
   *  @example 3000 */
  localPort?: number;
  /** Dependency name → forward definition.
   *  @example { "users-ms": { deployment: "users-ms", port: 8080 } } */
  dependencies?: Record<string, DependencyConfig>;
}

/**
 * Shape of the config file (`lokube.yaml` / `lokube.yml` / `lokube.json`).
 */
export type Config = {
  /** Default namespace applied to every dependency forward.
   *  @example "dev" */
  namespace?: string;
  /** Kubeconfig context to use, overriding the current one.
   *  @example "dev-cluster" */
  context?: string;
  /** Kubeconfig file path; defaults to `$KUBECONFIG` or `~/.kube/config`.
   *  @example "~/.kube/dev-config" */
  kubeconfig?: string;
  /** Service name → local run configuration.
   *  @example { "calendar-ms": { command: "npm run dev" } } */
  services?: Record<string, ServiceConfig>;
}

/**
 * A dependency with defaults applied and validated, ready to be forwarded.
 * Built from {@link DependencyConfig}: `localPort` falls back to `port` and
 * `namespace` to the top-level one.
 */
export type ResolvedDependency = {
  /** Name the dependency is declared under (used in logs and configuration). */
  key: string;
  kind: DepTargetKind;
  /** Object name, or the label selector when `kind` is `podSelector`. */
  target: string;
} & Required<Pick<DependencyConfig, 'port' | 'localPort' | 'namespace'>> &
  Pick<DependencyConfig, 'env'>;

/**
 * A service at runtime: `ServiceConfig` with its dependencies already resolved
 * and validated (defaults for `localPort` and `namespace` applied).
 */
export type ResolvedService = Omit<ServiceConfig, 'dependencies'> & {
  /** The service's dependencies, resolved and validated (may be empty). */
  dependencies: ResolvedDependency[];
};

/**
 * The loaded and validated config lokube operates on: the file's `Config`
 * plus the resolved defaults and the absolute config path. Pure data.
 */
export type ResolvedConfig = Omit<Config, 'namespace' | 'services'> & {
  /** Absolute path of the config file that was loaded. */
  path: string;
  /** Default namespace applied to every forward. */
  namespace: string;
  /** Service name → configuration, with dependencies resolved and validated. */
  services: Record<string, ResolvedService>;
};
