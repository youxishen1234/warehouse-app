const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || 'dist');
const scripts = fs.readdirSync(path.join(root, 'js')).filter(name => name.endsWith('.js'));
const content = scripts.map(name => fs.readFileSync(path.join(root, 'js', name), 'utf8')).join('\n');
for (const marker of ['pages/ai-assistant/index', 'data-ai-assistant', '/api/ai/command', '/api/ai/voice', '/api/ai/photo', '发语音', '/ai/config/test', '接入设置']) {
  if (!content.includes(marker)) throw new Error(`Release is missing the AI assistant feature: ${marker}. Refusing to publish a bundle that removes AI.`);
}
console.log('AI route, interface, command API and model settings are present in this release.');
