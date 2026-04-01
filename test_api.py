import urllib.request
import json
import uuid

req = urllib.request.Request(
    'http://localhost:5001/api/auth/login',
    data=json.dumps({"username": "admin", "password": "admin"}).encode('utf-8'),
    headers={'Content-Type': 'application/json'}
)
try:
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode('utf-8'))
        token = data.get("token")
        print("Login Success")

        # Now try to place an order
        kot_req = urllib.request.Request(
            'http://localhost:5001/api/orders/dine-in/kot',
            data=json.dumps({
                "items": [{"product_id": 1, "quantity": 1}],
                "order_snapshot": {"table_name": "Test Table"}
            }).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
        )
        with urllib.request.urlopen(kot_req) as kot_res:
            print("KOT Success", kot_res.read().decode('utf-8'))

except Exception as e:
    print("Error:", str(e))
    if hasattr(e, 'read'):
        print(e.read().decode('utf-8'))
