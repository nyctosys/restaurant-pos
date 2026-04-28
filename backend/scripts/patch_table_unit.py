path = r'e:\POS Project\frontend\src\components\inventory\MenuItemsTab.tsx'
content = open(path, 'r', encoding='utf-8').read()

# Fix 1: Title cell - remove the inline unit appended to title, it clutters
old_title = r'<td className="py-3 px-3 lg:px-4 xl:py-2 font-medium text-soot-900 text-sm xl:text-xs">{p.title}{(p.unitOfMeasure === \"kg\" || p.unitOfMeasure === \"g\") ? ` (${p.unitOfMeasure})` : \"\"}</td>'
new_title = r'<td className="py-3 px-3 lg:px-4 xl:py-2 font-medium text-soot-900 text-sm xl:text-xs">{p.title}</td>'

# Fix 2: Price cell - make unit show as a sub-line clearly
old_price = r'<td className="py-3 px-3 lg:px-4 xl:py-2 font-semibold text-sm xl:text-xs">{formatCurrency(p.base_price)}{p.unitOfMeasure ? ` / ${p.unitOfMeasure}` : \'\'}</td>'
new_price = r"""<td className="py-3 px-3 lg:px-4 xl:py-2">
                      <div className="font-semibold text-sm xl:text-xs">{formatCurrency(p.base_price)}</div>
                      {p.unitOfMeasure && (
                        <div className="text-xs text-soot-400 font-normal">per {p.unitOfMeasure}</div>
                      )}
                    </td>"""

if old_title in content:
    content = content.replace(old_title, new_title)
    print('Fixed title cell')
else:
    print('Title pattern not found')

if old_price in content:
    content = content.replace(old_price, new_price)
    print('Fixed price cell')
else:
    print('Price pattern not found')
    # Try finding it
    idx = content.find('formatCurrency(p.base_price)')
    print('formatCurrency at:', idx)
    print(repr(content[idx-50:idx+200]))

open(path, 'w', encoding='utf-8').write(content)
print('Done')
