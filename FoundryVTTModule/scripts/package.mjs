import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = path.join(moduleRoot, 'release');
const archivePath = path.join(releaseRoot, 'dndsearch-mcp-module.zip');
const archiveRoot = 'dndsearch-mcp-module';

const runtimeEntries = [
  'assets',
  'CHANGELOG.md',
  'dist/module.js',
  'lang',
  'LICENSE',
  'module.json',
  'packs',
  'README.md',
  'styles',
  'templates',
];

await mkdir(releaseRoot, { recursive: true });
if (await stat(archivePath).then(() => true, () => false)) await unlink(archivePath);

const output = createWriteStream(archivePath);
const archive = archiver('zip');

const completed = new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
});

archive.pipe(output);
for (const entry of runtimeEntries) {
  const sourcePath = path.join(moduleRoot, entry);
  const destinationPath = path.posix.join(archiveRoot, entry.replaceAll(path.sep, '/'));
  const details = await stat(sourcePath);

  if (details.isDirectory()) {
    archive.directory(sourcePath, destinationPath);
  } else {
    archive.file(sourcePath, { name: destinationPath });
  }
}

await archive.finalize();
await completed;
console.log(`Created ${archivePath}`);
