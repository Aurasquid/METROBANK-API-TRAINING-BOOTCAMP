// === SME LOGIN ===
async function loginUser() {
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  try {
    const response = await fetch("http://localhost:3000/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json();

    if (data.success) {
      sessionStorage.setItem("currentUser", JSON.stringify(data.user));
      window.location.href = "SMEdashboard.html"; // ✅ redirect SME only
    } else {
      document.getElementById("error-message").textContent =
        "❌ " + data.message;
    }
  } catch (err) {
    document.getElementById("error-message").textContent =
      "🚫 Server connection failed.";
  }
}

// === SME DASHBOARD SESSION CHECK ===
async function loadUserInfo() {
  try {
    const response = await fetch("http://localhost:3000/api/user", {
      credentials: "include",
    });

    if (!response.ok) {
      window.location.href = "mainlayout.html"; // redirect to login
      return;
    }

    const user = await response.json();
    updateUserUI(user);
  } catch {
    window.location.href = "mainlayout.html";
  }
}

// === SME LOGOUT ===
async function logoutUser() {
  await fetch("http://localhost:3000/api/logout", {
    method: "POST",
    credentials: "include",
  });
  sessionStorage.removeItem("currentUser");
  window.location.href = "mainlayout.html";
}
