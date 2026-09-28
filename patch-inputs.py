from pathlib import Path
files={
'src/pages/inbound/index.tsx': [("import { dimensions, localDate, numberValue, previewAmount, roundDecimal }", "import { dimensions, localDate, numberValue, previewAmount, roundDecimal, sanitizeDecimalInput }"),("onInput={e => setFreight(e.detail.value)}", "onInput={e => setFreight(sanitizeDecimalInput(e.detail.value, 2))}"),("updateLine(line.key, { quantity: e.detail.value })", "updateLine(line.key, { quantity: sanitizeDecimalInput(e.detail.value, 6) })"),("updateLine(line.key, { unit_price: e.detail.value })", "updateLine(line.key, { unit_price: sanitizeDecimalInput(e.detail.value, 2) })"),("updateLine(line.key, { delivered_qty: e.detail.value })", "updateLine(line.key, { delivered_qty: sanitizeDecimalInput(e.detail.value, 6) })")],
'src/pages/outbound/index.tsx': [("import { numberValue, previewAmount, roundDecimal }", "import { numberValue, previewAmount, roundDecimal, sanitizeDecimalInput }"),("updateLine(line.key, { quantity: event.detail.value })", "updateLine(line.key, { quantity: sanitizeDecimalInput(event.detail.value, 6) })"),("updateLine(line.key, { unit_price: event.detail.value })", "updateLine(line.key, { unit_price: sanitizeDecimalInput(event.detail.value, 2) })")],
'src/pages/product-edit/index.tsx': [("import { numberValue }", "import { numberValue, sanitizeDecimalInput }"),("setLayers(e.detail.value)", "setLayers(sanitizeDecimalInput(e.detail.value, 0))"),("setWeight(e.detail.value)", "setWeight(sanitizeDecimalInput(e.detail.value, 6))"),("setLength(e.detail.value)", "setLength(sanitizeDecimalInput(e.detail.value, 6))"),("setWidth(e.detail.value)", "setWidth(sanitizeDecimalInput(e.detail.value, 6))"),("setPrice(e.detail.value)", "setPrice(sanitizeDecimalInput(e.detail.value, 2))"),("setSafety(e.detail.value)", "setSafety(sanitizeDecimalInput(e.detail.value, 6))"),("setStock(e.detail.value)", "setStock(sanitizeDecimalInput(e.detail.value, 6))")],
'src/pages/orders/index.tsx': [("import styles from './index.module.scss';", "import styles from './index.module.scss';\nimport { sanitizeDecimalInput } from '@/utils/stock-math';"),("setQty(e.detail.value)", "setQty(sanitizeDecimalInput(e.detail.value, 6))"),("setPrice(e.detail.value)", "setPrice(sanitizeDecimalInput(e.detail.value, 2))")],
'src/pages/inventory/index.tsx': [("import { localDate, numberValue }", "import { localDate, numberValue, sanitizeDecimalInput }")]
}
for fn,repls in files.items():
 p=Path(fn); s=p.read_text(encoding='utf-8')
 for old,new in repls:
  if old not in s: print('MISSING',fn,old)
  s=s.replace(old,new)
 p.write_text(s,encoding='utf-8')
p=Path('src/pages/inventory/index.tsx'); s=p.read_text(encoding='utf-8'); s=s.replace('setCountValue(e.detail.value)', 'setCountValue(sanitizeDecimalInput(e.detail.value, 6))'); p.write_text(s,encoding='utf-8')
