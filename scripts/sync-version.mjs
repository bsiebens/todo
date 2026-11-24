// Copies the version from package.json into the desktop app's Rust package, so the
// web app, the installers and the release tag all carry one number.
// Runs automatically from `npm version` (see "version" in package.json).
// `node scripts/sync-version.mjs --check v1.2.3` only verifies, for the release workflow.
import { readFileSync, writeFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const files = {
  'src-tauri/Cargo.toml': /^(\[package\][\s\S]*?\nversion = ")[^"]+(")/,
  'src-tauri/Cargo.lock': /(\nname = "todo-desktop"\nversion = ")[^"]+(")/,
};

const args = process.argv.slice(2);
if (args[0] === '--check') {
  const problems = [];
  const tag = args[1]?.replace(/^refs\/tags\//, '');
  if (tag && tag !== `v${version}`) problems.push(`tag ${tag} does not match package.json version ${version} (expected v${version})`);
  for (const [file, re] of Object.entries(files)) {
    const m = readFileSync(file, 'utf8').match(re);
    const found = m?.[0].match(/"([^"]+)"$/)?.[1];
    if (found !== version) problems.push(`${file} has version ${found}, package.json has ${version}`);
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`Version ${version} is consistent.`);
} else {
  for (const [file, re] of Object.entries(files)) {
    const text = readFileSync(file, 'utf8');
    if (!re.test(text)) throw new Error(`No version found in ${file}`);
    writeFileSync(file, text.replace(re, `$1${version}$2`));
  }
  console.log(`Set version ${version} in ${Object.keys(files).join(', ')}.`);
}
