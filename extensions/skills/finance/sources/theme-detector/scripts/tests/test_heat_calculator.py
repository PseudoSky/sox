"""Tests for heat_calculator.py - Theme Heat Score (0-100)"""

import pytest
from calculators.heat_calculator import (
    breadth_signal_score,
    calculate_theme_heat,
    momentum_strength_score,
    uptrend_signal_score,
    volume_intensity_score,
)

# ── momentum_strength_score ──────────────────────────────────────────


class TestMomentumStrengthScore:
    """score = 100 / (1 + (16 / (1 + |wr%|))**2); equals 50 at |wr| = 15%.

    Hand-computed from the module's documented formula
    100 / (1 + exp(-2 * (ln(1 + |wr|) - ln 16))).
    """

    def test_zero_return(self):
        # (16/1)^2 = 256 => 100/257
        assert momentum_strength_score(0.0) == pytest.approx(100 / 257, abs=1e-6)

    def test_five_percent(self):
        # (16/6)^2 = 7.1111 => 100/8.1111
        assert momentum_strength_score(5.0) == pytest.approx(12.3288, abs=1e-3)

    def test_negative_five_percent(self):
        assert momentum_strength_score(-5.0) == pytest.approx(momentum_strength_score(5.0))

    def test_fifteen_percent_is_the_midpoint(self):
        assert momentum_strength_score(15.0) == pytest.approx(50.0, abs=1e-9)

    def test_twenty_percent(self):
        # (16/21)^2 = 0.58050 => 100/1.58050
        assert momentum_strength_score(20.0) == pytest.approx(63.271, abs=1e-3)

    def test_negative_twenty_percent(self):
        assert momentum_strength_score(-20.0) == pytest.approx(63.271, abs=1e-3)

    def test_thirty_and_fifty_percent(self):
        assert momentum_strength_score(30.0) == pytest.approx(100 / (1 + (16 / 31) ** 2), abs=1e-6)
        assert momentum_strength_score(50.0) == pytest.approx(100 / (1 + (16 / 51) ** 2), abs=1e-6)

    def test_returns_float(self):
        assert isinstance(momentum_strength_score(3.0), float)


# ── volume_intensity_score ───────────────────────────────────────────


class TestVolumeIntensityScore:
    """min(100, sqrt(max(0, ratio - 0.8)) / sqrt(1.2) * 100)"""

    def test_ratio_0_8_returns_zero(self):
        assert volume_intensity_score(80.0, 100.0) == pytest.approx(0.0)

    def test_ratio_1_0(self):
        # sqrt(0.2 / 1.2) * 100 = 40.8248
        assert volume_intensity_score(100.0, 100.0) == pytest.approx(40.8248, abs=1e-3)

    def test_ratio_1_2(self):
        # sqrt(0.4 / 1.2) * 100 = 57.7350
        assert volume_intensity_score(120.0, 100.0) == pytest.approx(57.7350, abs=1e-3)

    def test_ratio_1_5(self):
        # sqrt(0.7 / 1.2) * 100 = 76.3763
        assert volume_intensity_score(150.0, 100.0) == pytest.approx(76.3763, abs=1e-3)

    def test_ratio_2_0_reaches_the_cap(self):
        # sqrt(1.2 / 1.2) * 100 = 100
        assert volume_intensity_score(200.0, 100.0) == pytest.approx(100.0)

    def test_ratio_above_cap_clamped_to_100(self):
        assert volume_intensity_score(400.0, 100.0) == pytest.approx(100.0)

    def test_ratio_below_floor_clamped_to_0(self):
        assert volume_intensity_score(50.0, 100.0) == pytest.approx(0.0)

    def test_none_vol_20d(self):
        assert volume_intensity_score(None, 100.0) == pytest.approx(50.0)

    def test_none_vol_60d(self):
        assert volume_intensity_score(100.0, None) == pytest.approx(50.0)

    def test_zero_vol_60d(self):
        assert volume_intensity_score(100.0, 0.0) == pytest.approx(50.0)


# ── uptrend_signal_score ─────────────────────────────────────────────


class TestUptrendSignalScore:
    """Per sector: min(80, ratio * 100) + 10 if ratio > ma_10 + 10 if slope > 0; ratio is a 0-1 fraction."""

    def _make_sector(self, ratio, ma_10, slope, weight=1.0):
        return {
            "sector": "test",
            "ratio": ratio,
            "ma_10": ma_10,
            "slope": slope,
            "weight": weight,
        }

    def test_both_bonuses(self):
        # 50 + 10 + 10
        data = [self._make_sector(ratio=0.5, ma_10=0.4, slope=0.5)]
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(70.0)

    def test_ratio_bonus_only(self):
        # 50 + 10
        data = [self._make_sector(ratio=0.5, ma_10=0.4, slope=-0.1)]
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(60.0)

    def test_slope_bonus_only(self):
        # 30 + 10
        data = [self._make_sector(ratio=0.3, ma_10=0.4, slope=0.5)]
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(40.0)

    def test_no_bonus(self):
        data = [self._make_sector(ratio=0.3, ma_10=0.4, slope=-0.1)]
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(30.0)

    def test_base_is_capped_at_80(self):
        # min(80, 90) + 10 + 10
        data = [self._make_sector(ratio=0.9, ma_10=0.4, slope=0.5)]
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(100.0)

    def test_weighted_average(self):
        # A: 70 weight 2; B: 30 weight 1 => (140 + 30) / 3
        data = [
            self._make_sector(ratio=0.5, ma_10=0.4, slope=0.5, weight=2.0),
            self._make_sector(ratio=0.3, ma_10=0.4, slope=-0.1, weight=1.0),
        ]
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(170 / 3)

    def test_bearish_inversion(self):
        # 100 - 70
        data = [self._make_sector(ratio=0.5, ma_10=0.4, slope=0.5)]
        assert uptrend_signal_score(data, is_bearish=True) == pytest.approx(30.0)

    def test_empty_list(self):
        assert uptrend_signal_score([], is_bearish=False) == pytest.approx(50.0)

    def test_equal_ratio_and_ma10_earns_no_ratio_bonus(self):
        # 40 + 0 + 0
        data = [self._make_sector(ratio=0.4, ma_10=0.4, slope=0)]
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(40.0)


# ── breadth_signal_score ─────────────────────────────────────────────


class TestBreadthSignalScore:
    """min(100, ratio**2.5 * 80 + min(20, 2 * industry_count))"""

    def test_zero(self):
        assert breadth_signal_score(0.0) == pytest.approx(0.0)

    def test_half(self):
        # 0.5^2.5 * 80 = 14.1421
        assert breadth_signal_score(0.5) == pytest.approx(14.1421, abs=1e-3)

    def test_full(self):
        assert breadth_signal_score(1.0) == pytest.approx(80.0)

    def test_industry_count_bonus(self):
        assert breadth_signal_score(1.0, industry_count=5) == pytest.approx(90.0)
        assert breadth_signal_score(1.0, industry_count=20) == pytest.approx(100.0)

    def test_above_one_clamped(self):
        assert breadth_signal_score(1.5) == pytest.approx(100.0)

    def test_negative_clamped(self):
        assert breadth_signal_score(-0.3) == pytest.approx(0.0)

    def test_none(self):
        assert breadth_signal_score(None) == pytest.approx(50.0)


# ── calculate_theme_heat ─────────────────────────────────────────────


class TestCalculateThemeHeat:
    def test_weighted_sum(self):
        # 80*0.35 + 60*0.20 + 70*0.25 + 50*0.20 = 28 + 12 + 17.5 + 10
        assert calculate_theme_heat(80.0, 60.0, 70.0, 50.0) == pytest.approx(67.5)

    def test_all_100(self):
        assert calculate_theme_heat(100.0, 100.0, 100.0, 100.0) == pytest.approx(100.0)

    def test_all_zero(self):
        assert calculate_theme_heat(0.0, 0.0, 0.0, 0.0) == pytest.approx(0.0)

    def test_none_defaults_to_50(self):
        assert calculate_theme_heat(None, None, None, None) == pytest.approx(50.0)

    def test_partial_none(self):
        # 80*0.35 + 50*0.20 + 50*0.25 + 50*0.20 = 28 + 10 + 12.5 + 10
        assert calculate_theme_heat(80.0, None, None, None) == pytest.approx(60.5)

    def test_clamped_above_100(self):
        assert calculate_theme_heat(200.0, 200.0, 200.0, 200.0) == 100.0

    def test_clamped_below_0(self):
        assert calculate_theme_heat(-50.0, -50.0, -50.0, -50.0) == 0.0

    def test_returns_float(self):
        assert isinstance(calculate_theme_heat(50, 50, 50, 50), float)


# ── uptrend_signal_score with None values ────────────────────────────


class TestUptrendSignalNoneValues:
    """Ensure None values in sector_data don't cause TypeError (treated as 0)."""

    def test_none_ma_10(self):
        data = [{"sector": "Tech", "ratio": 0.5, "ma_10": None, "slope": 0.01, "weight": 1.0}]
        # 50 + 10 (0.5 > 0) + 10 (slope > 0)
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(70.0)

    def test_none_slope(self):
        data = [{"sector": "Tech", "ratio": 0.5, "ma_10": 0.3, "slope": None, "weight": 1.0}]
        # 50 + 10 + 0
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(60.0)

    def test_none_ratio(self):
        data = [{"sector": "Tech", "ratio": None, "ma_10": 0.3, "slope": 0.01, "weight": 1.0}]
        # 0 + 0 + 10
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(10.0)

    def test_all_none(self):
        data = [{"sector": "Tech", "ratio": None, "ma_10": None, "slope": None, "weight": 1.0}]
        assert uptrend_signal_score(data, is_bearish=False) == pytest.approx(0.0)
