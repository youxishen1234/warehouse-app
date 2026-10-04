const fs = require('fs');
const dir = (process.env.WAREHOUSE_BUILD_STAGE || 'release') + '/customer-desk'; fs.mkdirSync(dir, { recursive: true });
const source = fs.readFileSync('prototypes/customer-dark-preview.html', 'utf8');
const css = source.match(/<style>([\s\S]*?)<\/style>/)[1];
const editor = fs.readFileSync('prototypes/customer-dark-editor.js', 'utf8').match(/style\.textContent = `([\s\S]*?)`;/)[1];
const extra = '.empty{padding:40px 20px;text-align:center;color:#9daac0;line-height:1.7}.form-error{color:#ffb8b8;font-size:12px;line-height:1.5}.company-edit{text-align:right;margin-bottom:14px}.company-edit button{font-size:11px}.footer{margin:30px 0}.spec-value{overflow-wrap:anywhere}.app{padding-top:calc(36px + env(safe-area-inset-top,0px));padding-bottom:calc(max(112px,var(--sg-native-bottom-space,84px)) + env(safe-area-inset-bottom,0px))}button:disabled{opacity:.5;cursor:wait}';
fs.writeFileSync(dir + '/customer-desk.html', '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>曙光仓库 · 客户尺寸本</title><style>'+css+editor+extra+'</style><link rel="stylesheet" href="css/polish.css"><div class="app"></div><taro-tabbar class="taro-tabbar__tabbar"></taro-tabbar><div id="toast" class="toast" role="status"></div><script src="customer-desk.js?v=20261001-dock"></script><script src="customer-dock.js?v=20261001-dock"></script></html>');
fs.copyFileSync('prototypes/customer-desk.js',dir+'/customer-desk.js');
if (fs.existsSync(dir+'/team-original.js')) {
  let team=fs.readFileSync(dir+'/team-original.js','utf8');
  const anchor="  route('get', '/auth/me',";
  if(!team.includes(anchor))throw Error('Team integration point missing');
  team=team.replace(anchor,"  require('./customer-dimensions').install(router, db);\n"+anchor);
  fs.writeFileSync(dir+'/team.js',team);
}
async function build() {
  await require('./build-labels.cjs')();
  await require('./build-customer-dock.cjs')();
}

build().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
