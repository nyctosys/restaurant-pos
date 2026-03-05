import requests
import json
import uuid

API_URL = "http://localhost:5001/api"

# 1. First, try to login as existing owner to get a token.
# Wait, do we know an existing owner? We might need to run /auth/setup if none exists,
# or authenticate. I'll just check status, setup if needed.
print("Checking system status...")
res = requests.get(f"{API_URL}/auth/status")
status = res.json()

if not status.get("initialized"):
    print("System not initialized. Setting up...")
    res = requests.post(f"{API_URL}/auth/setup", json={
        "username": "admin",
        "password": "password",
        "branch_name": "Main Branch"
    })
    token = res.json()["token"]
    print("Setup complete.")
else:
    # We don't know the admin password natively. Let's create a temp user directly in DB if possible?
    # Or assuming admin / password from earlier testing?
    print("System already initialized. Trying admin / password...")
    res = requests.post(f"{API_URL}/auth/login", json={
        "username": "admin",
        "password": "password"
    })
    if res.status_code == 200:
        token = res.json()["token"]
        print("Logged in as admin.")
    else:
        print("Failed to login as admin. Can't automatically verify unless we know credentials.")
        exit(1)

headers = {"Authorization": f"Bearer {token}"}

# Test Receipt Settings
print("Testing Receipt Settings Update...")
config_updates = {"config": {"receipt_settings": {"businessName": "Script Test Corp", "logoUrl": "", "footerMessage": "Thanks!"}}}
res = requests.put(f"{API_URL}/settings/", json=config_updates, headers=headers)
print("PUT Settings:", res.status_code, res.json())
assert res.status_code == 200

# Test User Creation (Cashier)
print("Testing User Creation...")
cashier_username = f"cashier_{uuid.uuid4().hex[:6]}"
res = requests.post(f"{API_URL}/users/", json={
    "username": cashier_username,
    "password": "123",
    "role": "cashier"
}, headers=headers)
print("POST Users:", res.status_code, res.json())
assert res.status_code == 201

user_id = res.json()["user"]["id"]

# Login as Cashier
print("Logging in as new cashier...")
res = requests.post(f"{API_URL}/auth/login", json={
    "username": cashier_username,
    "password": "123"
})
cashier_token = res.json()["token"]
cashier_headers = {"Authorization": f"Bearer {cashier_token}"}

# Cashier tries to access Users (Should fail)
print("Cashier trying to GET users...")
res = requests.get(f"{API_URL}/users/", headers=cashier_headers)
print("GET Users (Cashier):", res.status_code, res.json())
assert res.status_code == 403

# Cashier tries to update Settings (Should fail)
print("Cashier trying to PUT settings...")
res = requests.put(f"{API_URL}/settings/", json=config_updates, headers=cashier_headers)
print("PUT Settings (Cashier):", res.status_code, res.json())
assert res.status_code == 403

# Owner deletes Cashier
print("Owner deleting cashier...")
res = requests.delete(f"{API_URL}/users/{user_id}", headers=headers)
print("DELETE User:", res.status_code, res.json())
assert res.status_code == 200

print("All tests passed successfully!")
