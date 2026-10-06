#!/usr/bin/env node
import { run } from '../src/cli.js';

// `proxy <url> | head` closes the pipe early; like curl, that is a normal end,
// not a crash with a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`proxy: ${error.message}\n`);
    process.exitCode = 1;
  },
);
