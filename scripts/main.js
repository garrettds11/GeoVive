// main.js
import {
  handleRedirectCallback,
  getCurrentUser,
  login,
  logout
} from "./auth.js";

document.addEventListener("DOMContentLoaded", async () => {
  // 1) See if this is the Cognito redirect (with ?code=...) and process it
  await handleRedirectCallback();

  // 2) Initialize the auth UI (header buttons, status)
  initAuthUi();

  // 3) Your existing map/tray initialization can go here
  // initMap();
  // initTopTray();
});

function initAuthUi() {
  const statusEl = document.getElementById("auth-status");
  const signinBtn = document.getElementById("signIn");
  const signoutBtn = document.getElementById("signOut");
  const modal = document.getElementById("login-modal");
  const modalSigninBtn = document.getElementById("modalSignIn");
  const cancelBtn = document.getElementById("cancelSignIn");

  function pickGreetingName(profile) {
    if (!profile) return "there";
    if (profile.given_name) return profile.given_name; // Google often provides this
    if (profile.name) return profile.name.split(" ")[0];
    if (profile.preferred_username) return profile.preferred_username;
    if (profile.email) return profile.email.split("@")[0];
    return "there";
  }

  async function render() {
    const user = await getCurrentUser();
    if (user) {
      const name = pickGreetingName(user.profile);
      if (statusEl) statusEl.textContent = `Hi ${name}.`;
      if (signinBtn) signinBtn.style.display = "none";
      if (signoutBtn) signoutBtn.style.display = "inline-flex";
      if (modal) modal.classList.add("hidden");
    } else {
      if (statusEl) statusEl.textContent = "Not signed in";
      if (signinBtn) signinBtn.style.display = "inline-flex";
      if (signoutBtn) signoutBtn.style.display = "none";
    }
  }

  function triggerLogin() {
    login();
  }

  // Header sign-in
  if (signinBtn) {
    signinBtn.addEventListener("click", triggerLogin);
  }

  // Modal sign-in
  if (modalSigninBtn) {
    modalSigninBtn.addEventListener("click", triggerLogin);
  }

  // Modal cancel
  if (cancelBtn && modal) {
    cancelBtn.addEventListener("click", () => {
      modal.classList.add("hidden");
    });
  }

  // Header sign-out
  if (signoutBtn) {
    signoutBtn.addEventListener("click", () => {
      logout();
    });
  }

  render();
}

