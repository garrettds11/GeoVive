// main.js
import {
  handleRedirectCallback,
  getCurrentUser,
  login,
  logout
} from "./auth.js";

document.addEventListener("DOMContentLoaded", async () => {
  // If this is the redirect from Cognito, process the code & save tokens
  await handleRedirectCallback();

  // Then wire up the UI
  initAuthUi();
});

function initAuthUi() {
  const statusEl = document.getElementById("auth-status");
  const signinBtn = document.getElementById("signin-btn");
  const signoutBtn = document.getElementById("signout-btn");

  async function render() {
    const user = await getCurrentUser();
    if (user) {
      const label =
        user.profile?.preferred_username ||
        user.profile?.email ||
        user.profile?.name ||
        "User";

      statusEl.textContent = `Signed in as ${label}`;
      signinBtn.style.display = "none";
      signoutBtn.style.display = "inline-flex";
    } else {
      statusEl.textContent = "Not signed in";
      signinBtn.style.display = "inline-flex";
      signoutBtn.style.display = "none";
    }
  }

  signinBtn?.addEventListener("click", () => {
    login();
  });

  signoutBtn?.addEventListener("click", () => {
    logout();
  });

  render();
}
