from app.memory import pattern_label


def test_numbers_are_dropped_so_equivalent_reasons_share_one_pattern():
    assert pattern_label("Rapid velocity: 6 txns in 1h") == pattern_label("Rapid velocity: 5 txns in 1h") == "rapid velocity"
    assert pattern_label("Unusual amount ($950 vs median $40)") == "unusual amount"


def test_ml_model_signals_keep_their_feature_so_they_do_not_all_collapse_into_one_node():
    a = pattern_label("Model signal: ratio to median purchase price (SHAP +0.123)")
    b = pattern_label("Model signal: is new device (SHAP +0.044)")
    assert a == "model signal ratio to median purchase price" and b == "model signal is new device" and a != b
    assert pattern_label("Model signal: ratio to median purchase price (SHAP +0.9)") == a   # the SHAP value is not part of the pattern


def test_empty_and_pii_reasons_are_safe():
    assert pattern_label("") == "unspecified pattern"
    assert "@" not in pattern_label("Contact bob@example.com about this")
