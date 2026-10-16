"""The bundled price table covers the models agents run today."""

from __future__ import annotations

import pytest

from app.pricing import cost_for, normalize_model


@pytest.mark.parametrize(
    "model,normalized,input_rate,output_rate",
    [
        ("claude-opus-5-5", "claude-opus-5-5", 4.0, 20.0),
        ("claude-opus-5-5-medium", "claude-opus-5-5", 4.0, 20.0),
        ("claude-sonnet-5-5", "claude-sonnet-5-5", 2.0, 10.0),
        ("claude-haiku-5-5", "claude-haiku-5-5", 0.10, 0.50),
        ("claude-fable-5-1", "claude-fable-5-1", 10.0, 50.0),
        ("grok-4.7-high", "cursor-grok-4.7", 2.0, 6.0),
        ("grok-4.7-high-fast", "cursor-grok-4.7-fast", 4.0, 12.0),
        ("gpt-6.1-sol", "gpt-6.1-sol", 2.0, 10.0),
        ("gpt-6-astra-high", "gpt-6-astra", 10.0, 50.0),
        ("gpt-5.6-terra", "gpt-5.6-terra", 2.0, 12.0),
    ],
)
def test_current_models_have_their_own_rates(model, normalized, input_rate, output_rate):
    assert normalize_model(model) == normalized
    assert cost_for(model, 1_000_000, 0) == pytest.approx(input_rate)
    assert cost_for(model, 0, 1_000_000) == pytest.approx(output_rate)


def test_an_unknown_grok_borrows_its_own_tier():
    # A newer Grok than the table knows is priced like the newest one, Fast like Fast.
    assert cost_for("grok-9.9", 1_000_000, 0) == pytest.approx(2.0)
    assert cost_for("grok-9.9-fast", 1_000_000, 0) == pytest.approx(4.0)
