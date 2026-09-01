"""Tests for the in-sandbox pricing parser.

These run locally and do not need a Solari API key.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from parser import parse


SAMPLE_HTML = """
<html>
  <body>
    <div class="pricing-card">
      <h3 class="plan-name">Starter</h3>
      <div class="plan-price">$20</div>
      <div class="plan-suffix">/mo</div>
      <p class="plan-desc">For small teams</p>
      <ul>
        <li class="plan-feature">1 user</li>
        <li class="plan-feature">10 projects</li>
      </ul>
    </div>
    <div class="pricing-card">
      <h3 class="plan-name">Pro</h3>
      <div class="plan-price">$99</div>
      <div class="plan-suffix">/mo</div>
      <p class="plan-desc">For growing teams</p>
      <ul>
        <li class="plan-feature">Unlimited users</li>
        <li class="plan-feature">Unlimited projects</li>
      </ul>
    </div>
  </body>
</html>
"""


class TestParser(unittest.TestCase):
    def test_extracts_two_plans(self):
        config = {
            "card": "pricing-card",
            "name": "plan-name",
            "price": "plan-price",
            "suffix": "plan-suffix",
            "description": "plan-desc",
            "features": "plan-feature",
        }

        plans = parse(SAMPLE_HTML, config)

        self.assertEqual(len(plans), 2)

        self.assertEqual(plans[0]["plan"], "Starter")
        self.assertEqual(plans[0]["price"], "$20 /mo")
        self.assertEqual(plans[0]["description"], "For small teams")
        self.assertEqual(plans[0]["features"], ["1 user", "10 projects"])

        self.assertEqual(plans[1]["plan"], "Pro")
        self.assertEqual(plans[1]["price"], "$99 /mo")
        self.assertEqual(plans[1]["description"], "For growing teams")
        self.assertEqual(plans[1]["features"], ["Unlimited users", "Unlimited projects"])

    def test_uses_price_without_suffix(self):
        html = """
        <div class="card">
          <h2 class="name">Free</h2>
          <span class="price">$0</span>
          <p class="desc">Always free</p>
        </div>
        """
        config = {
            "card": "card",
            "name": "name",
            "price": "price",
            "suffix": "suffix",
            "description": "desc",
            "features": "feature",
        }

        plans = parse(html, config)

        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]["plan"], "Free")
        self.assertEqual(plans[0]["price"], "$0")


if __name__ == "__main__":
    unittest.main()
