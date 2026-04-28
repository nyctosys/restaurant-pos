import os

path = r"e:\POS Project\frontend\src\components\inventory\MenuItemsTab.tsx"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Update Product type
content = content.replace(
    'image_url?: string;\n  archived_at?: string | null;\n};',
    'image_url?: string;\n  archived_at?: string | null;\n  unitOfMeasure?: string;\n};'
)

# 2. Add formUnit state
content = content.replace(
    "const [formImageUrl, setFormImageUrl] = useState('');",
    "const [formImageUrl, setFormImageUrl] = useState('');\n  const [formUnit, setFormUnit] = useState('');"
)

# 3. resetForm
content = content.replace(
    "setFormImageUrl('');\n    setFormVariants([]);",
    "setFormImageUrl('');\n    setFormUnit('');\n    setFormVariants([]);"
)

# 4. handleOpenEditModal
content = content.replace(
    "setFormImageUrl(p.image_url || '');\n    setFormVariants(",
    "setFormImageUrl(p.image_url || '');\n    setFormUnit(p.unitOfMeasure || '');\n    setFormVariants("
)

# 5. payload in handleSubmit
content = content.replace(
    "image_url: formImageUrl.trim() || '',\n      };",
    "image_url: formImageUrl.trim() || '',\n        unitOfMeasure: formUnit.trim() || '',\n      };"
)

# 6. Add Units dropdown in Modal body
modal_content = """              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">
                  Base price <span className="text-red-400">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={formPrice}
                    onChange={e => setFormPrice(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                  />
                  <div className="w-1/3">
                    <select
                      value={formUnit}
                      onChange={e => setFormUnit(e.target.value)}
                      className="w-full h-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                    >
                      <option value="">No unit</option>
                      <option value="kg">kg</option>
                      <option value="g">g</option>
                      <option value="l">l</option>
                      <option value="ml">ml</option>
                      <option value="piece">piece</option>
                    </select>
                  </div>
                </div>
              </div>"""

content = content.replace(
    """              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">
                  Base price <span className="text-red-400">*</span>
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={formPrice}
                  onChange={e => setFormPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                />
              </div>""",
    modal_content
)

# 7. Add formatQuantityWithUnit logic to table? The POS Menu Items don't display their OWN quantity in the CATALOG listing, only price. Wait, if we want to display the unit explicitly in the TITLE column?
# "If unit is kg or g -> display explicitly. If unit is something else -> ALWAYS display that unit next to quantity" 
# Oh right, no quantity. Let's append the unit to the Title explicitly if kg/g, or to the base price!
# Let's import formatQuantityWithUnit
content = """import { formatQuantityWithUnit } from '../../utils/formatQuantityWithUnit';\n""" + content

content = content.replace(
    "{formatCurrency(p.base_price)}</td>",
    "{formatCurrency(p.base_price)}{p.unitOfMeasure ? ` / ${p.unitOfMeasure}` : ''}</td>"
)

content = content.replace(
    '<td className="py-3 px-3 lg:px-4 xl:py-2 font-medium text-soot-900 text-sm xl:text-xs">{p.title}</td>',
    '<td className="py-3 px-3 lg:px-4 xl:py-2 font-medium text-soot-900 text-sm xl:text-xs">{p.title}{(p.unitOfMeasure === "kg" || p.unitOfMeasure === "g") ? ` (${p.unitOfMeasure})` : ""}</td>'
)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("Patched MenuItemsTab.tsx")
