path = r'e:\POS Project\frontend\src\components\inventory\MenuItemsTab.tsx'
content = open(path, 'r', encoding='utf-8').read()

# Find exact bytes around the pattern
idx = content.find('formatCurrency(p.base_price)')
snippet = content[idx-100:idx+200]
print(repr(snippet))

# Try to find and replace with raw strings avoiding escape issues
import re
# Replace price td
old = 'xl:py-2 font-semibold text-sm xl:text-xs">{formatCurrency(p.base_price)}{p.unitOfMeasure ? ` / ${p.unitOfMeasure}` : \'\'}</td>'
if old in content:
    new = 'xl:py-2">\r\n                      <div className="font-semibold text-sm xl:text-xs">{formatCurrency(p.base_price)}</div>\r\n                      {p.unitOfMeasure && (\r\n                        <div className="text-xs text-soot-400 font-normal">per {p.unitOfMeasure}</div>\r\n                      )}\r\n                    </td>'
    content = content.replace(old, new)
    print('Replaced price cell OK')
else:
    print('Still not found. Let me check exact content...')
    # Find exact boundary
    idx2 = content.find('font-semibold text-sm xl:text-xs')
    print(idx2, repr(content[idx2:idx2+200]))

open(path, 'w', encoding='utf-8').write(content)
