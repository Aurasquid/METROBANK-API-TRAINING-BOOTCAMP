document.addEventListener("DOMContentLoaded", () => {
    initializeSMELayout();

    // Only call loadUserInfo on pages that have the sidebar/header
    if (window.location.pathname.includes("dashboard") || window.location.pathname.includes("SME")) {
        loadUserInfo(); // 🔹 Load user data from backend
    }
});

function initializeSMELayout() {
    // Sidebar toggle
    const toggleBtn = document.querySelector(".toggle-btn");
    const sidebar = document.querySelector(".sidebar");

    if (toggleBtn && sidebar) {
        toggleBtn.addEventListener("click", () => {
            sidebar.classList.toggle("collapsed");
        });
    }

    // Profile dropdown toggle
    const profileBtn = document.getElementById("profileBtn");
    const profileMenu = document.getElementById("profileMenu");

    if (profileBtn && profileMenu) {
        profileBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            profileMenu.classList.toggle("show");
        });

        document.addEventListener("click", (e) => {
            if (!profileMenu.contains(e.target) && !profileBtn.contains(e.target)) {
                profileMenu.classList.remove("show");
            }
        });
    }

    console.log("✅ SME layout initialized");
}

// 🔹 Login user and redirect to dashboard
async function loginUser() {
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value.trim();

    if (!email || !password) {
        alert("Please enter both email and password.");
        return;
    }

    try {
        const res = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });

        const data = await res.json();

        if (data.success) {
            // Optional: store user info in session storage (for frontend use)
            sessionStorage.setItem("currentUser", JSON.stringify(data.user));

            alert(`Welcome, ${data.user.name}!`);
            window.location.href = "dashboard.html"; // ✅ Redirect to your dashboard
        } else {
            alert(data.message || "Login failed.");
        }
    } catch (err) {
        console.error("❌ Login error:", err);
        alert("An error occurred during login.");
    }
}

// 🔹 Load user info on dashboard
async function loadUserInfo() {
    try {
        const res = await fetch("/api/user");
        if (!res.ok) throw new Error("Failed to fetch user info");
        const user = await res.json();

        // Sidebar user info
        const userName = document.getElementById("userName");
        const userRole = document.getElementById("userRole");
        const profileImg = document.getElementById("profileImage");

        if (userName) userName.textContent = user.name || "Unknown User";
        if (userRole) userRole.textContent = user.role || "Role not set";
        if (profileImg && user.profile_image) profileImg.src = user.profile_image;

        // Header info
        const headerName = document.querySelector(".profile-name");
        const headerImg = document.querySelector(".header-profile img");
        if (headerName) headerName.textContent = user.name || "User";
        if (headerImg && user.profile_image) headerImg.src = user.profile_image;

        console.log("👤 User info loaded:", user);
    } catch (err) {
        console.error("❌ Error loading user info:", err);
    }
}
