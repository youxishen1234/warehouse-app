from pathlib import Path
p=Path('backend/db.js')
s=p.read_text(encoding='utf-8')
s=s.replace("d.customers.forEach(c => { if (typeof c.debt !== 'number') c.debt = 0; });", "d.customers.forEach(c => { if (typeof c.debt !== 'number') c.debt = 0; if (c.profile_updated_at === undefined) c.profile_updated_at = Number(c.updated_at) || Number(c.created_at) || 0; if (c.balance_updated_at === undefined) c.balance_updated_at = Number(c.updated_at) || Number(c.created_at) || 0; });")
s=s.replace("d.suppliers.forEach(s => { if (typeof s.payable !== 'number') s.payable = 0; });", "d.suppliers.forEach(s => { if (typeof s.payable !== 'number') s.payable = 0; if (s.profile_updated_at === undefined) s.profile_updated_at = Number(s.updated_at) || Number(s.created_at) || 0; if (s.balance_updated_at === undefined) s.balance_updated_at = Number(s.updated_at) || Number(s.created_at) || 0; });")
s=s.replace('created_at: now, updated_at: now, profile_updated_at: now, stock_updated_at: now\n  };\n  cache.customers.push', 'created_at: now, updated_at: now, profile_updated_at: now, balance_updated_at: debt > 0 ? now : 0\n  };\n  cache.customers.push')
p.write_text(s,encoding='utf-8')
