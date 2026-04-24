path = r'e:\POS Project\frontend\src\components\inventory\MenuItemsTab.tsx'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix title cell - remove the (kg)/(g) suffix from the title column
old_title = '{p.title}{(p.unitOfMeasure === "kg" || p.unitOfMeasure === "g") ? ` (${p.unitOfMeasure})` : ""}'
new_title = '{p.title}'
if old_title in content:
    content = content.replace(old_title, new_title)
    print('Fixed title cell')
else:
    print('NOT FOUND: title cell pattern')

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
