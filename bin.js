#!/usr/bin/env node
// The hook runs on every shell command an agent starts, so it loads only what it needs.
if (process.argv[2] === 'hook') {
  const { runHook } = await import('./src/hook.js');
  await runHook(process.argv.slice(3));
} else {
  const { main } = await import('./src/cli.js');
  main();
}
