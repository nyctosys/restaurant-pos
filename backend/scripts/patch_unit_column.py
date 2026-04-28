path = r'e:\POS Project\frontend\src\components\inventory\MenuItemsTab.tsx'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add Unit column header AFTER the Base Price header th block
old_header = '''                  <th
                    aria-sort={sortKey === 'archived_at' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="sticky top-0 z-10 bg-white/90 backdrop-blur-md py-3 px-3 lg:px-4 xl:py-2 xl:text-xs text-right"
                  >'''

new_header = '''                  <th className="sticky top-0 z-10 bg-white/90 backdrop-blur-md py-3 px-3 lg:px-4 xl:py-2 xl:text-xs text-left text-soot-500 font-semibold">
                    Unit
                  </th>
                  <th
                    aria-sort={sortKey === 'archived_at' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="sticky top-0 z-10 bg-white/90 backdrop-blur-md py-3 px-3 lg:px-4 xl:py-2 xl:text-xs text-right"
                  >'''

if old_header in content:
    content = content.replace(old_header, new_header)
    print('Added Unit column header')
else:
    print('Header pattern not found')

# 2. Add Unit data cell — insert AFTER the price cell and BEFORE the actions cell
# Find the price cell end (the </td> after the unitOfMeasure conditional)
old_price_cell = '''                    </td>
                    <td className="py-3 px-3 lg:px-4 xl:py-2 text-right">'''

new_price_cell = '''                    </td>
                    <td className="py-3 px-3 lg:px-4 xl:py-2">
                      {p.unitOfMeasure ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-soot-100 text-soot-600 text-xs font-semibold border border-soot-200">
                          {p.unitOfMeasure}
                        </span>
                      ) : (
                        <span className="text-soot-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3 lg:px-4 xl:py-2 text-right">'''

if old_price_cell in content:
    content = content.replace(old_price_cell, new_price_cell, 1)
    print('Added Unit data cell')
else:
    print('Price cell end pattern not found')
    # Debug
    idx = content.find('xl:py-2 text-right')
    print(repr(content[idx-100:idx+100]))

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
