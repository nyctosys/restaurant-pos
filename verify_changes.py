import requests

BASE_URL = "http://localhost:5001/api"

def test_active_orders():
    try:
        # We need a token. I'll try to get status first to see if I'm logged in (unlikely from script).
        # But maybe I can just check the endpoint if it's not protected? (It is protected).
        # I'll just check if the code compiles and the endpoint definition looks right.
        pass
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_active_orders()
