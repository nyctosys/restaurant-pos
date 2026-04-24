import os

path = r"e:\POS Project\backend\app\routers\menu.py"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace(
    '"archived_at": product.archived_at.isoformat() if getattr(product, "archived_at", None) else None,\n        "recipe_items": recipe_items,',
    '"archived_at": product.archived_at.isoformat() if getattr(product, "archived_at", None) else None,\n        "unit": getattr(product, "unit", "") or "",\n        "unitOfMeasure": getattr(product, "unit", "") or "",\n        "recipe_items": recipe_items,'
)

content = content.replace(
    'image_url=(data.get("image_url") or "").strip() or "",\n        )',
    'image_url=(data.get("image_url") or "").strip() or "",\n            unit=(data.get("unitOfMeasure") or data.get("unit") or "").strip() or None,\n        )'
)

content = content.replace(
    'if "image_url" in data:\n        product.image_url = data["image_url"] or ""\n    try:',
    'if "image_url" in data:\n        product.image_url = data["image_url"] or ""\n    if "unitOfMeasure" in data or "unit" in data:\n        product.unit = (data.get("unitOfMeasure") or data.get("unit") or "").strip() or None\n    try:'
)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("Patched menu.py")
