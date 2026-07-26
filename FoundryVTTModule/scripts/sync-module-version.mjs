import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(moduleRoot, 'package.json');
const modulePath = path.join(moduleRoot, 'module.json');

const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
const moduleManifest = JSON.parse(await readFile(modulePath, 'utf8'));

if (moduleManifest.version !== packageManifest.version) {
  moduleManifest.version = packageManifest.version;
  await writeFile(modulePath, `${JSON.stringify(moduleManifest, null, 2)}\n`);
  console.log(`Updated module.json to version ${packageManifest.version}`);
} else {
  console.log(`module.json is already at version ${packageManifest.version}`);
}
