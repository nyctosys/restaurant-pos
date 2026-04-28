path = r'e:\POS Project\frontend\src\components\inventory\SuppliersTab.tsx'
content = open(path, 'r', encoding='utf-8').read()

# Remove opacity-0 group-hover:opacity-100 transition-opacity from the edit button container
content = content.replace(
    'opacity-0 group-hover:opacity-100 transition-opacity',
    ''
)

# While we're here add touch-target and transition-colors to the button itself
content = content.replace(
    'onClick={() => handleOpenEdit(s)} className="p-1.5 text-neutral-400 hover:text-brand-600 hover:bg-brand-50 rounded-md"',
    'onClick={() => handleOpenEdit(s)} className="p-1.5 text-neutral-400 hover:text-brand-600 hover:bg-brand-50 rounded-md transition-colors touch-target" title="Edit supplier"'
)

open(path, 'w', encoding='utf-8').write(content)
print('Patched SuppliersTab - edit button now always visible')
