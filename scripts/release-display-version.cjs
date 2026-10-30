const fs = require('node:fs');

const INITIAL_DISPLAY_VERSION = '1.23';
const DISPLAY_VERSION_PATTERN = /^\d+\.\d+$/;

function nextDisplayVersion(baseline = {}) {
  const current = baseline?.displayVersion;
  if (current === undefined || current === null || current === '') {
    return INITIAL_DISPLAY_VERSION;
  }
  if (typeof current !== 'string' || !DISPLAY_VERSION_PATTERN.test(current)) {
    throw new Error('Published manifest displayVersion must use major.minor format');
  }
  const [major, minor] = current.split('.');
  return `${BigInt(major)}.${BigInt(minor) + 1n}`;
}

function readBaseline(file) {
  if (!file || !fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeGitHubEnv(file, version) {
  if (!DISPLAY_VERSION_PATTERN.test(version)) throw new Error('Invalid display version');
  fs.appendFileSync(file, `TARO_APP_DISPLAY_VERSION=${version}\nHOTUPDATE_DISPLAY_VERSION=${version}\n`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

if (require.main === module) {
  try {
    const version = nextDisplayVersion(readBaseline(argument('--baseline')));
    const githubEnv = argument('--github-env');
    if (githubEnv) writeGitHubEnv(githubEnv, version);
    process.stdout.write(version + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  DISPLAY_VERSION_PATTERN,
  INITIAL_DISPLAY_VERSION,
  nextDisplayVersion,
  readBaseline,
  writeGitHubEnv
};
