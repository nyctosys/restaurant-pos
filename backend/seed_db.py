import sys
from app import create_app
from app.models import db, Product, Setting, Modifier, Branch

app = create_app()

def seed():
    with app.app_context():
        # Ensure a branch exists
        branch = Branch.query.first()
        if not branch:
            branch = Branch(name="Main Restaurant", address="123 Food Street")
            db.session.add(branch)
            db.session.flush()

        # Update Settings (Categories and Tables)
        setting = Setting.query.filter_by(branch_id=None).first()
        if not setting:
            setting = Setting(config={})
            db.session.add(setting)
        
        # Modify the JSON dict
        config = dict(setting.config or {})
        
        if "tables" not in config or not config["tables"]:
            config["tables"] = ["Table 1", "Table 2", "Table 3", "Table 4", "Booth 1", "Booth 2", "Patio 1"]
        if "sections" not in config or not config["sections"]:
            config["sections"] = ["Starters", "Mains", "Sides", "Beverages", "Desserts"]
        if "tax_enabled" not in config:
            config["tax_enabled"] = True
            config["tax_rates_by_payment_method"] = {"Cash": 0, "Card": 8, "Online Transfer": 8}
            
        setting.config = config
        
        # Seed Modifiers
        if Modifier.query.count() == 0:
            modifiers = [
                Modifier(name="Extra Cheese", price=1.50),
                Modifier(name="Bacon Add-on", price=2.00),
                Modifier(name="No Onions", price=0.0),
                Modifier(name="Extra Spicy", price=0.0),
                Modifier(name="Gluten Free Base", price=2.50)
            ]
            db.session.bulk_save_objects(modifiers)
            
        # Seed Products (Menu Items) with Variants
        if Product.query.count() == 0:
            products = [
                Product(sku="APP-001", title="Truffle Fries", base_price=6.50, section="Starters", variants=[], is_deal=False),
                Product(sku="APP-002", title="Garlic Butter Shrimp", base_price=9.00, section="Starters", variants=[], is_deal=False),
                Product(sku="MAI-001", title="Signature Smash Burger", base_price=14.00, section="Mains", variants=["Beef", "Chicken"], is_deal=False),
                Product(sku="MAI-002", title="Margherita Pizza", base_price=12.50, section="Mains", variants=["10 inch", "14 inch"], is_deal=False),
                Product(sku="MAI-003", title="Spicy Pepperoni Pizza", base_price=14.50, section="Mains", variants=["10 inch", "14 inch"], is_deal=False),
                Product(sku="SID-001", title="Onion Rings", base_price=5.00, section="Sides", variants=[], is_deal=False),
                Product(sku="BEV-001", title="House Lemonade", base_price=3.50, section="Beverages", variants=[], is_deal=False),
                Product(sku="BEV-002", title="Craft Cola", base_price=2.50, section="Beverages", variants=[], is_deal=False),
                Product(sku="DES-001", title="Caramel Cheesecake", base_price=6.00, section="Desserts", variants=["Regular", "Large Slice"], is_deal=False)
            ]
            db.session.bulk_save_objects(products)
            
        db.session.commit()
        print("Database seeded successfully with default restaurant items, categories, tables, and modifiers!")

if __name__ == "__main__":
    seed()
