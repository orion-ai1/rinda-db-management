import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: watch,
  minify: false,
  logLevel: 'info'
};

if (watch) {
  const buildContext = await context(options);
  await buildContext.watch();
  console.log('Watching Rinda MySQL sources...');
} else {
  await build(options);
}
