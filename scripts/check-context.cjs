const fs = require('fs');
const md = fs.readFileSync('E:/aoo/warehouse-app/docs/曙光库存-优化建议3000条.md', 'utf8');
const lines = md.split('\n').filter(l => /^\d+\./.test(l));
const scan = (word, okWords) => {
  const hits = lines.filter(l => l.includes(word));
  const bad = hits.filter(l => !okWords.some(w => l.includes(w)));
  console.log(`「${word}」共 ${hits.length} 行，可疑 ${bad.length}`);
  bad.slice(0, 15).forEach(l => console.log('  ', l.slice(0, 120)));
};
scan('登录', ['不需要登录','移除','删除','不出现','不弹','无需','免登录','登录/密码','登录步骤','静默','不再','登录负担','登录体系','登录相关','登录页','登录交互','登录过期','登录中','账号登录','重建完整账号','无登录']);
scan('小程序', ['不需要微信小程序','移除','删除','不构建','不维护','不再','小程序相关','小程序 CI','小程序使用','小程序/Android','小程序平台','小程序存在','小程序免登录','支持端列表','weapp','非小程序']);
scan('密码', ['移除','删除','不再','无需','访问密钥','密码类','密码/','密码相关','密码配置','密码管理','访问密码','密码校验','shuguang2026']);
scan('viewer', ['移除','删除','viewer 下','降级为 viewer']);
scan('operator', ['移除','删除']);
scan('admin', ['移除','删除']);
