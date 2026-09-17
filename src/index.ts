#!/usr/bin/env node
import { buildCli } from './cli.js';

function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

buildCli().parse(process.argv);