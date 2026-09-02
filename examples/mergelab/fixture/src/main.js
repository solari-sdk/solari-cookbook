async function renderCart() {
  const res = await fetch("/api/cart");
  const data = await res.json();
  const count = data.count;
  document.getElementById("cart")!.textContent = `Cart: ${count}`;
}

renderCart();
