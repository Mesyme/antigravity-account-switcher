# Antigravity Google Account Switcher

**Antigravity Google Account Switcher** is a lightweight, highly efficient utility designed specifically for **Antigravity IDE**. It allows you to seamlessly register, manage, and instantly switch between multiple Google AI Pro accounts directly from your status bar.

---

## 🚀 Features

* **Multi-Account Support**: Add and store credentials for multiple Google AI Pro profiles.
* **Instant Switch**: Swap active profiles in under 2 seconds with a single click.
* **Smart Session Sync**: Automatically detects manual sign-ins or logouts, keeping your profiles in sync in real-time.
* **Clean QuickPick Menu**: A minimal, icon-guided interface to quickly swap or remove saved accounts.
* **Single-Click Access**: Access your account hub instantly from a persistent status bar indicator showing your active profile.

---

## 🛠️ How It Works

This extension leverages the IDE's unified state sync APIs to update token credentials on-the-fly and refresh the active language server. Your profiles are securely stored in the extension's local `globalState`, meaning you only need to authenticate via the browser **once** per account.

---

## 📖 Usage

### Adding an Account
1. Click the 👤 or active profile email in the Status Bar (bottom right).
2. Select **Add Account** from the menu.
3. Complete the Google authentication flow in your browser.
4. The extension will automatically detect the new session and save it.

### Switching Accounts
1. Click the status bar profile item.
2. Select any previously saved account from the list.
3. The IDE session will update automatically.

### Managing Profiles
* **Sign Out**: Click **Sign Out** to clear the current active session in the IDE while keeping all saved profiles.
* **Remove Profile**: Click the **Trash Icon** next to any saved account to delete its credentials from the switcher.

---

## 📦 Requirements

* **Antigravity IDE** (built-in API support required).
* Active internet connection for fetching user profile info on initial setup.

---

Enjoy a frictionless multi-account workflow in Antigravity IDE!
