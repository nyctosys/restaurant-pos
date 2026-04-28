path = r'e:\POS Project\frontend\src\components\inventory\MenuItemsTab.tsx'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Remove the "per unit" sub-line from the price cell since unit now has its own column
old = '''                    <td className="py-3 px-3 lg:px-4 xl:py-2">

                      <div className="font-semibold text-sm xl:text-xs">{formatCurrency(p.base_price)}</div>

                      {p.unitOfMeasure && (

                        <div className="text-xs text-soot-400 font-normal">per {p.unitOfMeasure}</div>

                      )}

                    </td>'''

new = '''                    <td className="py-3 px-3 lg:px-4 xl:py-2 font-semibold text-sm xl:text-xs">
                      {formatCurrency(p.base_price)}
                    </td>'''

if old in content:
    content = content.replace(old, new)
    print('Cleaned up price cell')
else:
    print('Price cell pattern not found, checking...')
    idx = content.find('formatCurrency(p.base_price)')
    print(repr(content[idx-200:idx+200]))

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
