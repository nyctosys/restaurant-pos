from app.order_metadata import normalize_order_type_and_snapshot


def test_delivery_snapshot_keeps_rider_name():
    order_type, snapshot, error = normalize_order_type_and_snapshot(
        {
            "order_type": "delivery",
            "order_snapshot": {
                "customer_name": "Ali",
                "phone": "03001234567",
                "address": "Street 1",
                "rider_name": "Hamza",
            },
        }
    )

    assert error is None
    assert order_type == "delivery"
    assert snapshot == {
        "customer_name": "Ali",
        "phone": "03001234567",
        "address": "Street 1",
        "rider_name": "Hamza",
    }


def test_delivery_snapshot_allows_missing_rider_name():
    order_type, snapshot, error = normalize_order_type_and_snapshot(
        {
            "order_type": "delivery",
            "order_snapshot": {
                "customer_name": "Ali",
                "phone": "03001234567",
                "address": "Street 1",
            },
        }
    )

    assert error is None
    assert order_type == "delivery"
    assert snapshot == {
        "customer_name": "Ali",
        "phone": "03001234567",
        "address": "Street 1",
    }


def test_delivery_snapshot_rejects_overlong_rider_name():
    order_type, snapshot, error = normalize_order_type_and_snapshot(
        {
            "order_type": "delivery",
            "order_snapshot": {
                "customer_name": "Ali",
                "phone": "03001234567",
                "address": "Street 1",
                "rider_name": "H" * 256,
            },
        }
    )

    assert order_type is None
    assert snapshot is None
    assert error == "Name, address, nearest_landmark, or rider_name is too long"
