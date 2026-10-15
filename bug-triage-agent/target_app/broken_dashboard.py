"""
target_app/broken_dashboard.py

A deliberately-buggy tiny web app to reproduce bugs against on a real Solari
Desktop session. Kept intentionally small so the repro/patch loop is fast
to demo, but the bug is a real class of bug (a stale/undefined JS handler),
not a toy string-mismatch.

Bug: clicking "Submit" after selecting "Express" shipping does nothing —
the JS handler for the shipping dropdown never re-binds the submit button
once the DOM re-renders the order summary. Classic stale-event-listener bug,
extremely common in real dashboards, and exactly the kind of thing that
requires actually SEEING the rendered page (Desktop/VNC) rather than just
reading the source, because the bug only manifests after a specific UI
interaction sequence.

Run: python broken_dashboard.py  (serves on localhost:5000)
"""

from flask import Flask, render_template_string

app = Flask(__name__)

PAGE = """
<!doctype html>
<html>
<head><title>Checkout</title></head>
<body>
  <h2>Order Summary</h2>
  <div id="summary">Standard shipping — $4.99</div>

  <label>Shipping:</label>
  <select id="shipping">
    <option value="standard">Standard - $4.99</option>
    <option value="express">Express - $14.99</option>
  </select>

  <div id="submit-area">
    <button id="submit-btn">Submit Order</button>
  </div>

  <div id="result"></div>

  <script>
    // BUG: this re-renders #submit-area's innerHTML on shipping change,
    // which destroys the original submit button and creates a new one —
    // but the click listener below was only ever bound to the ORIGINAL
    // button reference, so the new button has no handler at all.
    const submitArea = document.getElementById('submit-area');
    const shippingSelect = document.getElementById('shipping');
    const summary = document.getElementById('summary');

    function bindSubmit() {
      const btn = document.getElementById('submit-btn');
      btn.addEventListener('click', () => {
        document.getElementById('result').innerText = 'Order submitted!';
      });
    }
    bindSubmit();  // bound once, on page load

    shippingSelect.addEventListener('change', (e) => {
      const price = e.target.value === 'express' ? '14.99' : '4.99';
      const label = e.target.value === 'express' ? 'Express' : 'Standard';
      summary.innerText = `${label} shipping — $${price}`;

      // re-renders the button -> orphans the old listener -> BUG
      submitArea.innerHTML = '<button id="submit-btn">Submit Order</button>';
      // (the fix: call bindSubmit() again here, or use event delegation
      // on submitArea instead of binding directly to the button)
    });
  </script>
</body>
</html>
"""


@app.route("/")
def checkout():
    return render_template_string(PAGE)


if __name__ == "__main__":
    app.run(port=5000, debug=True)
