/**
 * Tiny checkout fixture with a shipping/pay race.
 *
 * Changing shipping starts a real GET /api/shipping request. The server sleeps
 * 250–899ms then returns method/cost. Pay used to freeze in `paying` if that
 * request was still pending at an 80ms check. Payment now completes when the
 * current shipping operation finishes.
 */
export const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>One In Twenty Checkout</title>
  <style>
    body { font-family: sans-serif; max-width: 28rem; margin: 2rem auto; line-height: 1.4; }
    label, button, select { font-size: 1rem; }
    #status { padding: 0.5rem 0.75rem; border: 1px solid #ccc; }
    #status[data-state="paid"] { border-color: #0a0; }
    #status[data-state="error"], #status[data-state="paying"] { border-color: #a40; }
  </style>
</head>
<body>
  <h1>One In Twenty</h1>
  <p id="product">Test Widget — $20</p>
  <label>
    Shipping
    <select id="shipping">
      <option value="standard">Standard — $5</option>
      <option value="express">Express — $15</option>
    </select>
  </label>
  <p>Shipping: <span id="shipping-cost">$5</span></p>
  <p>Total: <span id="total">$25</span></p>
  <button id="pay" type="button">Pay</button>
  <p id="status" data-state="ready">Ready</p>
  <script>
    const PRODUCT = 20;
    let shipping = "standard";
    let shippingCost = 5;
    let pending = 0;
    let shippingSeq = 0;
    let payGen = 0;
    const statusEl = document.getElementById("status");

    function setStatus(state, text) {
      statusEl.dataset.state = state;
      statusEl.textContent = text;
    }

    function render() {
      document.getElementById("shipping-cost").textContent = "$" + shippingCost;
      document.getElementById("total").textContent = "$" + (PRODUCT + shippingCost);
    }

    function completePay(method, cost, gen) {
      if (statusEl.dataset.state === "paid") return false;
      if (gen !== payGen) return false;
      shipping = method;
      shippingCost = cost;
      render();
      setStatus("paid", "Paid " + method + " $" + (PRODUCT + cost));
      return true;
    }

    document.getElementById("shipping").addEventListener("change", async (event) => {
      const next = event.target.value;
      pending += 1;
      const seq = ++shippingSeq;
      setStatus("shipping", "Updating shipping…");
      try {
        const res = await fetch("/api/shipping?method=" + encodeURIComponent(next));
        if (!res.ok) {
          pending -= 1;
          if (seq === shippingSeq) setStatus("error", "Shipping request failed");
          return;
        }
        const data = await res.json();
        pending -= 1;
        if (seq !== shippingSeq) {
          if (statusEl.dataset.state === "paying" && pending === 0) {
            completePay(shipping, shippingCost, payGen);
          }
          return;
        }
        if (statusEl.dataset.state === "paid") {
          setStatus("error", "Shipping update overwrote paid checkout");
          return;
        }
        shipping = data.method;
        shippingCost = data.cost;
        render();
        if (statusEl.dataset.state === "paying" && pending === 0) {
          completePay(data.method, data.cost, payGen);
          return;
        }
        if (pending === 0) {
          setStatus("ready", "Shipping ready");
        }
      } catch (err) {
        pending -= 1;
        if (seq === shippingSeq) setStatus("error", "Shipping request failed");
      }
    });

    document.getElementById("pay").addEventListener("click", () => {
      if (statusEl.dataset.state === "paid") return;
      payGen += 1;
      const gen = payGen;
      const capturedShipping = shipping;
      const capturedCost = shippingCost;
      setStatus("paying", "Processing payment…");
      setTimeout(function () {
        if (statusEl.dataset.state === "paid") return;
        if (pending > 0) return;
        completePay(capturedShipping, capturedCost, gen);
      }, 80);
    });
  </script>
</body>
</html>
`;
