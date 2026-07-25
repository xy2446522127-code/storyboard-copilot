import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const [artifact, signature, version, notesFile, output] = process.argv.slice(2);
if (!artifact || !signature || !version || !notesFile || !output) {
  throw new Error('Usage: node make-updater-manifest.mjs <artifact> <artifact.sig> <version> <notes.md> <output.json>');
}
if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid SemVer version: ${version}`);
}

const repository = 'xy2446522127-code/storyboard-copilot';
const tag = `v${version.replace(/^v/, '')}`;
const artifactName = basename(resolve(artifact));
const signatureText = (await readFile(resolve(signature), 'utf8')).trim();
const notes = await readFile(resolve(notesFile), 'utf8');
if (!signatureText) throw new Error('Update signature is empty.');

const manifest = {
  version: version.replace(/^v/, ''),
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: signatureText,
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(artifactName)}`
    }
  }
};

await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote ${output} for ${artifactName}`);
