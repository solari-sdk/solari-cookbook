document.getElementById("add-btn").addEventListener("click", () => {
  const input = document.getElementById("todo-input")
  const text = input.value.trim()
  if (!text) return

  const item = document.createElement("li")
  item.textContent = text
  list.appendChild(item)

  input.value = ""
})
