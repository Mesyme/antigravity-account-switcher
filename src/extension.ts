import * as vscode from 'vscode';
import * as https from 'https';

interface SavedAccount {
    email: string;
    name: string;
    picture?: string;
    tokenInfo: any;
}

let statusBarItem: vscode.StatusBarItem;
let lastActiveAccessToken: string | null = null;
let syncInterval: NodeJS.Timeout | null = null;

function fetchUserInfo(accessToken: string): Promise<{ email: string; name: string; picture?: string }> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'www.googleapis.com',
            path: '/oauth2/v2/userinfo',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(data);
                        resolve({
                            email: parsed.email || '',
                            name: parsed.name || '',
                            picture: parsed.picture
                        });
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`Google API status: ${res.statusCode}, response: ${data}`));
                }
            });
        });

        req.on('error', (err) => { reject(err); });
        req.end();
    });
}

function getUnifiedStateSync(): any {
    return (vscode as any).antigravityUnifiedStateSync;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Antigravity Google Account Switcher activated!');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravity-switcher.showMenu';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-switcher.showMenu', () => showSwitcherMenu(context)),
        vscode.commands.registerCommand('antigravity-switcher.addAccount', () => triggerAddAccount(context)),
        vscode.commands.registerCommand('antigravity-switcher.logout', () => logoutActiveSession())
    );

    syncInterval = setInterval(() => {
        syncActiveSession(context);
    }, 3000);

    syncActiveSession(context);
}

export function deactivate() {
    if (syncInterval) {
        clearInterval(syncInterval);
    }
}

async function syncActiveSession(context: vscode.ExtensionContext) {
    const uss = getUnifiedStateSync();
    if (!uss || !uss.OAuthPreferences) {
        statusBarItem.text = '$(warning) Switcher Error';
        statusBarItem.tooltip = 'Unified State Sync API not found.';
        return;
    }

    try {
        const tokenInfo = await uss.OAuthPreferences.getOAuthTokenInfo();
        if (!tokenInfo || !tokenInfo.accessToken) {
            lastActiveAccessToken = null;
            statusBarItem.text = '👤 Sign In';
            statusBarItem.tooltip = 'No Google account connected. Click to sign in.';
            return;
        }

        if (tokenInfo.accessToken === lastActiveAccessToken) {
            return;
        }
        lastActiveAccessToken = tokenInfo.accessToken;

        const googleInfo = await fetchUserInfo(tokenInfo.accessToken);
        const email = googleInfo.email;

        const accounts = context.globalState.get<SavedAccount[]>('saved_accounts', []);
        const existingIdx = accounts.findIndex(a => a.email.toLowerCase() === email.toLowerCase());

        const updatedAccount: SavedAccount = {
            email,
            name: googleInfo.name,
            picture: googleInfo.picture,
            tokenInfo
        };

        if (existingIdx !== -1) {
            accounts[existingIdx] = updatedAccount;
        } else {
            accounts.push(updatedAccount);
            vscode.window.showInformationMessage(`Google account saved in switcher: ${email}`);
        }

        await context.globalState.update('saved_accounts', accounts);
        await context.globalState.update('active_email', email);

        statusBarItem.text = `👤 ${email}`;
        statusBarItem.tooltip = `Active account: ${googleInfo.name} (${email}). Click to switch or add accounts.`;

    } catch (e) {
        console.error('Error syncing active session:', e);
        const accounts = context.globalState.get<SavedAccount[]>('saved_accounts', []);
        const activeEmail = context.globalState.get<string>('active_email');
        if (activeEmail) {
            statusBarItem.text = `👤 ${activeEmail}`;
            statusBarItem.tooltip = `Active account (offline/expired): ${activeEmail}. Click to switch or add accounts.`;
        } else {
            statusBarItem.text = '👤 Switch Account';
            statusBarItem.tooltip = 'Click to manage Google accounts.';
        }
    }
}

async function showSwitcherMenu(context: vscode.ExtensionContext) {
    const accounts = context.globalState.get<SavedAccount[]>('saved_accounts', []);
    const activeEmail = context.globalState.get<string>('active_email');

    const items: vscode.QuickPickItem[] = [];

    for (const account of accounts) {
        const isActive = activeEmail && account.email.toLowerCase() === activeEmail.toLowerCase();
        items.push({
            label: `${isActive ? '$(check) ' : '$(account) '} ${account.name}`,
            description: account.email,
            buttons: [
                {
                    iconPath: new vscode.ThemeIcon('trash'),
                    tooltip: 'Remove account'
                }
            ]
        });
    }

    if (accounts.length > 0) {
        items.push({
            label: '',
            kind: vscode.QuickPickItemKind.Separator
        });
    }

    items.push({
        label: '$(plus) Add Account'
    });

    if (activeEmail) {
        items.push({
            label: '$(log-out) Sign Out'
        });
    }

    const quickPick = vscode.window.createQuickPick();
    quickPick.items = items;
    quickPick.placeholder = 'Google AI Pro Account Switcher';

    quickPick.onDidTriggerItemButton(async (e) => {
        const accountToRemove = e.item.description;
        if (accountToRemove) {
            const confirm = await vscode.window.showWarningMessage(
                `Remove the account ${accountToRemove} from the switcher?`,
                { modal: true },
                'Yes',
                'No'
            );
            if (confirm === 'Yes') {
                const filtered = accounts.filter(a => a.email.toLowerCase() !== accountToRemove.toLowerCase());
                await context.globalState.update('saved_accounts', filtered);
                if (activeEmail && activeEmail.toLowerCase() === accountToRemove.toLowerCase()) {
                    await logoutActiveSession();
                    await context.globalState.update('active_email', undefined);
                }
                vscode.window.showInformationMessage(`Account ${accountToRemove} removed.`);
                quickPick.hide();
            }
        }
    });

    quickPick.onDidChangeSelection(async (selection) => {
        if (selection[0]) {
            const selected = selection[0];
            quickPick.hide();

            if (selected.label.startsWith('$(plus)')) {
                await triggerAddAccount(context);
            } else if (selected.label.startsWith('$(log-out)')) {
                await logoutActiveSession();
            } else if (selected.description) {
                await switchAccount(context, selected.description);
            }
        }
    });

    quickPick.show();
}

async function triggerAddAccount(context: vscode.ExtensionContext) {
    vscode.window.showInformationMessage('Google login initiated. Please complete the authentication in your browser.');
    
    try {
        await vscode.commands.executeCommand('workbench.action.loginWithRedirect');
    } catch (err) {
        vscode.window.showErrorMessage(`Unable to start IDE login: ${err}`);
        return;
    }

    const uss = getUnifiedStateSync();
    if (!uss || !uss.OAuthPreferences) {
        return;
    }

    let pollCount = 0;
    const initialToken = await uss.OAuthPreferences.getOAuthTokenInfo();
    const initialAccess = initialToken ? initialToken.accessToken : null;

    const interval = setInterval(async () => {
        pollCount++;
        if (pollCount > 60) {
            clearInterval(interval);
            vscode.window.showWarningMessage('Timeout: login not detected or expired.');
            return;
        }

        const currentToken = await uss.OAuthPreferences.getOAuthTokenInfo();
        if (currentToken && currentToken.accessToken && currentToken.accessToken !== initialAccess) {
            clearInterval(interval);
            await syncActiveSession(context);
            vscode.window.showInformationMessage('New account detected and saved successfully!');
        }
    }, 1000);
}

async function switchAccount(context: vscode.ExtensionContext, email: string) {
    const accounts = context.globalState.get<SavedAccount[]>('saved_accounts', []);
    const target = accounts.find(a => a.email.toLowerCase() === email.toLowerCase());

    if (!target) {
        vscode.window.showErrorMessage(`Account ${email} not found in saved profiles.`);
        return;
    }

    const uss = getUnifiedStateSync();
    if (!uss || !uss.OAuthPreferences) {
        vscode.window.showErrorMessage('IDE State Sync API not available.');
        return;
    }

    try {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Switching to account ${email}...`,
            cancellable: false
        }, async () => {
            await uss.OAuthPreferences.setOAuthTokenInfo(target.tokenInfo);
            
            await context.globalState.update('active_email', email);
            lastActiveAccessToken = target.tokenInfo.accessToken;

            await new Promise(resolve => setTimeout(resolve, 1500));

            await syncActiveSession(context);

            vscode.window.showInformationMessage(`Switched to Google AI Pro account: ${email}`);
        });
    } catch (err) {
        vscode.window.showErrorMessage(`Error during account switch: ${err}`);
    }
}

async function logoutActiveSession() {
    const uss = getUnifiedStateSync();
    if (!uss || !uss.OAuthPreferences || !uss.UserStatus) {
        return;
    }

    try {
        await uss.OAuthPreferences.setOAuthTokenInfo(null);
        await uss.UserStatus.clearUserStatus();
        lastActiveAccessToken = null;
        vscode.window.showInformationMessage('Account signed out successfully.');
    } catch (err) {
        vscode.window.showErrorMessage(`Error during sign out: ${err}`);
    }
}
