import { CoreV1Api, KubeConfig, PortForward } from '@kubernetes/client-node';
import { Readable, Writable } from 'node:stream';
import { log } from './logger.js';
import type { ResolvedDependency } from './types.js';
import * as net from 'node:net';


export interface PortForwardHandle {
  dep: ResolvedDependency;
  close: () => void;
}

export class KubeForwarder {
  private readonly config: KubeConfig;
  private readonly portForward: PortForward;
  readonly contextName: string;
  readonly server: string;

  constructor(opts: { kubeconfig?: string; context?: string }) {
    const config = new KubeConfig();
    try {
      if (opts.kubeconfig) config.loadFromFile(opts.kubeconfig);
      else config.loadFromDefault();
    } catch (err) {
      const hint = opts.kubeconfig ? ` (kubeconfig: ${opts.kubeconfig})` : '';
      throw new Error(
        `could not load a Kubernetes configuration${hint}. Check your kubeconfig ` +
        `(KUBECONFIG env or ~/.kube/config): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (opts.context) config.setCurrentContext(opts.context);

    const cluster = config.getCurrentCluster();
    if (!cluster) {
      throw new Error(
        `no usable current context in kubeconfig (context: "${config.getCurrentContext() || '(unset)'}"). ` +
        'Set one with kubectl or configure "context" in the lokube config.',
      );
    }

    this.config = config;
    this.contextName = config.getCurrentContext();
    this.server = cluster.server;
    this.portForward = new PortForward(config);
  }

  public async forward(dep: ResolvedDependency): Promise<PortForwardHandle> {

    const sockets = new Set<net.Socket>();

    const server = net.createServer(async (socket) => {
      try {

        sockets.add(socket);
        socket.setNoDelay(true);

        const ws = await this.pf(dep, socket, socket);

        socket.once('close', () => {
          ws.close();
          sockets.delete(socket)
        });
        socket.once('error', (err) => {
          log.error(`socket error: ${err.message}`);
          socket.destroy();
        });

      } catch (error) {
        log.error('Error during connection: ' + (error as Error).message);
        socket.destroy();
      }
    })

    server.on('error', (error) => {
      log.error(`Local TCP server: ${error.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(dep.localPort, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });

    return {
      dep,
      close: () => {
        server.close();
        sockets.forEach(s => s.destroy());
      },
    };
  }

  private async pf(
    dep: ResolvedDependency,
    output: Writable,
    input: Readable,
  ): Promise<WebSocket> {
    const ports = [dep.port];
    switch (dep.kind) {
      case 'deployment':
        return this.portForward.portForwardDeployment(dep.namespace, dep.target, ports, output, this.pfErrors, input);
      case 'service':
        return this.portForward.portForwardService(dep.namespace, dep.target, ports, output, this.pfErrors, input);
      case 'pod':
        return this.portForward.portForward(dep.namespace, dep.target, ports, output, this.pfErrors, input);
      case 'podSelector': {
        const list = await this.config.makeApiClient(CoreV1Api).listNamespacedPod({
          namespace: dep.namespace,
          labelSelector: dep.target,
        });
        const name = list.items?.find((pod) =>
          pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
        )?.metadata?.name;
        if (!name) throw new Error(`no ready pod matched "${dep.target}" in namespace ${dep.namespace}`);
        return this.portForward.portForward(dep.namespace, name, ports, output, this.pfErrors, input);
      }
    }
  }

  private pfErrors = new Writable({
    write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ) {
      try {

        if (chunk.length > 0) {
          log.error(chunk.toString());
        }

        callback();
      } catch (err) {
        callback(err as Error);
      }
    }
  });
}