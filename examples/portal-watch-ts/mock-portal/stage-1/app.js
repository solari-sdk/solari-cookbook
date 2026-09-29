// Stand-in for a real ATS's session cookie: once logged in, the portal skips
// straight to the status page on the next visit — same behavior a Solari
// profile is meant to ride on top of.
const loginForm = document.getElementById("login-form")
const status = document.getElementById("status")

if (localStorage.getItem("acme-logged-in") === "true") {
  loginForm.hidden = true
  status.hidden = false
} else {
  loginForm.addEventListener("submit", (event) => {
    event.preventDefault()
    localStorage.setItem("acme-logged-in", "true")
    loginForm.hidden = true
    status.hidden = false
  })
}
