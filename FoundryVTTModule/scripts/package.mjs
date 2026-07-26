import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = path.join(moduleRoot, 'release');
const archivePath = path.join(releaseRoot, 'dndsearch-mcp-module.zip');
const packagePath = path.join(moduleRoot, 'package.json');
const releaseModulePath = path.join(releaseRoot, 'module.json');
const archiveRoot = 'dndsearch-mcp-module';
const repositoryUrl = 'https://github.com/Zinshis/dndsearch-foundryvtt-module';

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
const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
const moduleTemplate = JSON.parse(await readFile(path.join(moduleRoot, 'module.template.json'), 'utf8'));
const releaseManifest = {
  ...moduleTemplate,
  version: packageManifest.version,
  manifest: `${repositoryUrl}/releases/v${packageManifest.version}/download/module.json`,
  download: `${repositoryUrl}/releases/v${packageManifest.version}/download/dndsearch-mcp-module.zip`,
};

await writeFile(releaseModulePath, `${JSON.stringify(releaseManifest, null, 2)}\n`);
if (await stat(archivePath).then(() => true, () => false)) await unlink(archivePath);

const output = createWriteStream(archivePath);
const archive = new ZipArchive();

const completed = new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
});

archive.pipe(output);
for (const entry of runtimeEntries) {
  const sourcePath = entry === 'module.json' ? releaseModulePath : path.join(moduleRoot, entry);
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
