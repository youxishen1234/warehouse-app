const fs = require('node:fs/promises');
const path = require('node:path');
const yauzl = require('yauzl');
const yazl = require('yazl');
const bplist = require('bplist-parser');

const input = process.argv[2];
const output = process.argv[3] || 'release/shuguang-ledger.ipa';
if (!input) throw new Error('Usage: node scripts/repack-ipa.cjs input.ipa output.ipa');
const dist = path.resolve('dist');
const readEntries = () => new Promise((resolve, reject) => yauzl.open(input, { lazyEntries: true }, (err, zip) => {
  if (err) return reject(err); const entries=[]; zip.on('error', reject); zip.on('end',()=>resolve(entries)); zip.on('entry', e=>zip.openReadStream(e,(error,s)=>{if(error)return reject(error);const c=[];s.on('data',x=>c.push(x));s.on('end',()=>{entries.push({name:e.fileName, data:Buffer.concat(c), dir:e.fileName.endsWith('/')});zip.readEntry();});})); zip.readEntry();
}));
const files = async dir => { const out=[]; const walk=async rel=>{for(const e of await fs.readdir(path.join(dir,rel),{withFileTypes:true})){const r=path.join(rel,e.name).replaceAll('\\','/');if(e.isDirectory())await walk(r);else out.push({name:r,data:await fs.readFile(path.join(dir,r))});}};await walk('');return out; };
(async()=>{
  const plist = await import('plist');
  const entries=await readEntries(); const appPrefix=entries.find(e=>/Payload\/[^/]+\.app\/Info\.plist$/.test(e.name)).name.replace(/Info\.plist$/,'');
  const infoEntry=entries.find(e=>e.name===appPrefix+'Info.plist'); let info;
  info=infoEntry.data.subarray(0,6).toString()==='bplist'?bplist.parseBuffer(infoEntry.data)[0]:plist.parse(infoEntry.data.toString());
  info.CFBundleShortVersionString=process.env.IPA_VERSION || '1.1.0'; info.CFBundleVersion=process.env.IPA_BUILD || '3';
  const zip=new yazl.ZipFile(); const write=new Promise((resolve,reject)=>{zip.outputStream.pipe(require('node:fs').createWriteStream(output)).on('close',resolve).on('error',reject);});
  for(const e of entries){ if(e.dir || e.name.includes('/_CodeSignature/') || e.name.endsWith('/embedded.mobileprovision') || e.name.startsWith(appPrefix+'public/'))continue; if(e.name===appPrefix+'Info.plist'){zip.addBuffer(Buffer.from(plist.build(info)),e.name);continue;} const native = e.name === appPrefix + info.CFBundleExecutable || /\.dylib$/.test(e.name) || /\.framework\/[^/.]+$/.test(e.name); zip.addBuffer(e.data,e.name,{mode: native ? 0o100755 : 0o100644}); }
  for(const f of await files(dist)) zip.addBuffer(f.data,appPrefix+'public/'+f.name);
  zip.end(); await write; console.log(JSON.stringify({output,version:info.CFBundleShortVersionString,build:info.CFBundleVersion,entries:entries.length}));
})().catch(e=>{console.error(e);process.exitCode=1});
