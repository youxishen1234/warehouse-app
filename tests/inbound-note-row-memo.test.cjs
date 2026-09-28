const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('inbound recent delivery note rows are memoized', () => {
  const source = fs.readFileSync('src/pages/inbound/index.tsx', 'utf8');
  assert.match(source, /const InboundNoteRow = React\.memo\(function InboundNoteRow/);
  assert.match(source, /notes\.map\(note => <InboundNoteRow/);
  assert.match(source, /const openPreview = useCallback\(/);
  assert.match(source, /onOpen=\{openPreview\}/);
  assert.doesNotMatch(source, /notes\.map\(note => <View className=\{styles\.note\}/);
});
