const fs = require('node:fs');

// Plain source field names match the working LCSign source supplied by the user.
function createSource(info, date = new Date().toISOString()) {
  if (!info.version || !info.build || !info.bundleId || !Number.isSafeInteger(info.sizeBytes) || info.sizeBytes <= 0) throw new Error('Invalid IPA metadata');
  const origin = 'https://youxishen.online';
  const icon = origin + '/download/app-icon.png';
  return {
    name: '曙光软件源',
    message: '曙光仓库管理官方安装包。刷新获取已发布版本，下载后自行签名安装。',
    identifier: 'com.warehouse.app.source',
    sourceURL: origin + '/download/source.json',
    sourceicon: icon,
    apps: [{
      name: info.name || '曙光', type: '1', version: info.version,
      bundleIdentifier: info.bundleId, buildVersion: info.build,
      versionDate: date,
      versionDescription: '曙光仓库管理 · Build ' + info.build + '。未签名 IPA，请使用自己的证书签名安装。',
      lock: '0', isLanZouCloud: '0',
      downloadURL: origin + '/shuguang.ipa?build=' + encodeURIComponent(info.build),
      iconURL: icon, tintColor: '#2563eb', size: String(info.sizeBytes)
    }]
  };
}
if (require.main === module) {
  const [, , input, output] = process.argv;
  if (!input || !output) throw new Error('Usage: node scripts/create-ios-source.cjs ipa.json source.json');
  fs.writeFileSync(output, JSON.stringify(createSource(JSON.parse(fs.readFileSync(input, 'utf8'))), null, 2) + '\n');
}
module.exports = { createSource };
