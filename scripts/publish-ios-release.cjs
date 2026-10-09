const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

async function publishIOSRelease({ tag, commit, run = args => execFileSync('gh', args, { stdio: 'inherit' }), exists = fs.existsSync, list = directory => fs.readdirSync(directory), wait = sleep, warn = console.warn } = {}) {
  if (!/^build-\d+$/.test(tag || '') || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('A build tag and source commit are required');
  const ipa = 'ios/App/shuguang.ipa';
  if (!exists(ipa)) throw new Error('Required IPA is missing: ' + ipa);
  const optional = ['release/ios-smoke/result.json', 'release/ios-smoke/simulator.png', 'release/ios-smoke/dock-preview.jpg'];
  if (exists('release/ios-smoke')) {
    optional.push(...list('release/ios-smoke').filter(name => /^native-dock-step-[\w-]+\.png$/.test(name)).sort().map(name => 'release/ios-smoke/' + name));
  }
  const assets = [ipa];
  const missing = [];
  for (const asset of optional) {
    if (exists(asset)) assets.push(asset);
    else missing.push(asset);
  }
  if (missing.length) warn('::warning::Optional simulator diagnostics unavailable: ' + missing.join(', ') + '. See the simulator verification log.');
  const retry = async args => {
    for (let attempt = 1; ; attempt++) {
      try { return run(args); }
      catch (error) {
        if (attempt === 4) throw error;
        warn('::warning::GitHub Release request failed; retrying attempt ' + (attempt + 1) + '/4');
        await wait(attempt * 10000);
      }
    }
  };
  try { run(['release', 'view', tag]); }
  catch { await retry(['release', 'create', tag, '--target', commit, '--title', tag, '--notes', 'iOS IPA build for ' + commit]); }
  for (const asset of assets) await retry(['release', 'upload', tag, asset, '--clobber']);
  return { assets, missing };
}

if (require.main === module) publishIOSRelease({ tag: process.env.RELEASE_TAG, commit: process.env.GITHUB_SHA }).then(result => {
  console.log('Published required IPA and ' + (result.assets.length - 1) + ' available diagnostic assets.');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'IPA published successfully. Optional simulator diagnostics missing: ' + result.missing.length + '.\n');
}).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { publishIOSRelease };
