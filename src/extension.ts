import * as vscode from 'vscode';
import * as https from 'https';

export interface QuotaInfo {
    geminiPercent?: number; 
    geminiWeekly?: number;  
    geminiResetTime?: number;
    claudePercent?: number;
    claudeResetHours?: number;
    claudeResetTime?: number;
    lastUpdated?: number;
}

export interface SavedAccount {
    email: string;
    name: string;
    picture?: string;
    tokenInfo?: any;
    quota?: QuotaInfo;
}

let statusBarItem: vscode.StatusBarItem;
let lastActiveAccessToken: string | null = null;
let syncInterval: NodeJS.Timeout | null = null;

interface ProtoField {
    field: number;
    wireType: number;
    type: 'varint' | 'string' | 'message' | 'bytes' | 'float32' | 'float64';
    value: any;
}

function decodeProtobuf(buffer: Buffer, depth: number = 0): ProtoField[] {
    const results: ProtoField[] = [];
    let offset = 0;

    while (offset < buffer.length) {
        try {
            let tag = 0, shift = 0, byte: number;
            do {
                byte = buffer[offset++];
                tag |= (byte & 0x7f) << shift;
                shift += 7;
            } while (byte & 0x80 && offset < buffer.length);

            const fieldNumber = tag >> 3;
            const wireType = tag & 0x7;
            if (fieldNumber === 0 || fieldNumber > 1000) break;

            switch (wireType) {
                case 0: { 
                    let value = 0; shift = 0;
                    do {
                        byte = buffer[offset++];
                        value |= (byte & 0x7f) << shift;
                        shift += 7;
                    } while (byte & 0x80 && offset < buffer.length);
                    results.push({ field: fieldNumber, wireType, type: 'varint', value });
                    break;
                }
                case 1: { 
                    const value = buffer.readDoubleLE(offset);
                    offset += 8;
                    results.push({ field: fieldNumber, wireType, type: 'float64', value });
                    break;
                }
                case 2: { 
                    let len = 0; shift = 0;
                    do {
                        byte = buffer[offset++];
                        len |= (byte & 0x7f) << shift;
                        shift += 7;
                    } while (byte & 0x80 && offset < buffer.length);

                    const data = buffer.slice(offset, offset + len);
                    offset += len;

                    const str = data.toString('utf8');
                    const isPrintable = /^[\x20-\x7E\r\n\t]+$/.test(str);

                    if (isPrintable && str.length > 0) {
                        results.push({ field: fieldNumber, wireType, type: 'string', value: str });
                    } else if (depth < 3) {
                        try {
                            const nested = decodeProtobuf(data, depth + 1);
                            if (nested.length > 0) {
                                results.push({ field: fieldNumber, wireType, type: 'message', value: nested });
                            } else {
                                results.push({ field: fieldNumber, wireType, type: 'bytes', value: data });
                            }
                        } catch {
                            results.push({ field: fieldNumber, wireType, type: 'bytes', value: data });
                        }
                    }
                    break;
                }
                case 5: { 
                    const value = buffer.readFloatLE(offset);
                    offset += 4;
                    results.push({ field: fieldNumber, wireType, type: 'float32', value });
                    break;
                }
                default:
                    return results;
            }
        } catch {
            break;
        }
    }
    return results;
}

interface ModelQuota {
    label: string;
    remainingFraction: number;
}

function extractModelQuotas(decoded: ProtoField[]): ModelQuota[] {
    const models: ModelQuota[] = [];

    for (const field of decoded) {
        if (field.type !== 'message') continue;
        const subFields: ProtoField[] = field.value;

        
        const labelField = subFields.find(
            (f: ProtoField) => f.field === 1 && f.type === 'string'
        );
        if (!labelField) {
            
            models.push(...extractModelQuotas(subFields));
            continue;
        }
        const label: string = labelField.value;

        if (!label.includes('Gemini') && !label.includes('Claude') && !label.includes('GPT')) {
            
            models.push(...extractModelQuotas(subFields));
            continue;
        }

        
        const quotaField = subFields.find(
            (f: ProtoField) => f.field === 15 && f.type === 'message'
        );
        let remainingFraction = 1.0; 
        if (quotaField) {
            const fracField = (quotaField.value as ProtoField[]).find(
                (f: ProtoField) => f.field === 1 && (f.type === 'float32' || f.type === 'float64')
            );
            if (fracField) {
                remainingFraction = fracField.value;
            }
        }

        models.push({ label, remainingFraction });
    }
    return models;
}

/** Parse getUserStatus() base64 protobuf and return quota percentages. */
async function fetchQuotaFromUserStatus(): Promise<QuotaInfo | null> {
    const uss = getUnifiedStateSync();
    if (!uss || !uss.UserStatus) return null;

    try {
        const statusB64: string = await uss.UserStatus.getUserStatus();
        if (!statusB64 || typeof statusB64 !== 'string') return null;

        const buf = Buffer.from(statusB64, 'base64');
        const decoded = decodeProtobuf(buf);
        const models = extractModelQuotas(decoded);

        if (models.length === 0) return null;

        
        
        
        let geminiMin = 1.0;
        let claudeMin = 1.0;
        let hasGemini = false;
        let hasClaude = false;

        for (const m of models) {
            if (m.label.includes('Gemini')) {
                geminiMin = Math.min(geminiMin, m.remainingFraction);
                hasGemini = true;
            } else if (m.label.includes('Claude')) {
                claudeMin = Math.min(claudeMin, m.remainingFraction);
                hasClaude = true;
            }
        }

        return {
            geminiPercent: hasGemini ? Math.round(geminiMin * 100) : undefined,
            claudePercent: hasClaude ? Math.round(claudeMin * 100) : undefined,
            lastUpdated: Date.now()
        };
    } catch (e) {
        console.error('Error parsing getUserStatus protobuf:', e);
        return null;
    }
}



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



export async function activate(context: vscode.ExtensionContext) {
    console.log('Antigravity Google Account Switcher activated!');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'antigravity-switcher.showMenu';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    try {
        await migrateTokensToSecretStorage(context);
    } catch (err) {
        console.error('Error migrating tokens:', err);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-switcher.showMenu', () => showSwitcherMenu(context)),
        vscode.commands.registerCommand('antigravity-switcher.addAccount', () => triggerAddAccount(context)),
        vscode.commands.registerCommand('antigravity-switcher.logout', () => logoutActiveSession())
    );

    syncInterval = setInterval(() => {
        syncActiveSession(context);
    }, 3000);

    syncActiveSession(context);

    
    const { startBackgroundQuotaPolling, stopBackgroundQuotaPolling } = require('./agq_polling');
    startBackgroundQuotaPolling(context);
    
    context.subscriptions.push({ dispose: stopBackgroundQuotaPolling });

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

        let googleInfo: any;
        try {
            googleInfo = await fetchUserInfo(tokenInfo.accessToken);
        } catch (e) {
            console.error('Error fetching user info:', e);
            throw e;
        }

        const email = googleInfo.email;
        const accounts = context.globalState.get<SavedAccount[]>('saved_accounts', []);
        const existingIdx = accounts.findIndex(a => a.email.toLowerCase() === email.toLowerCase());

        
        const existingAccount = existingIdx !== -1 ? accounts[existingIdx] : null;

        await context.secrets.store(`token_${email.toLowerCase()}`, JSON.stringify(tokenInfo));

        const updatedAccount: SavedAccount = {
            email,
            name: googleInfo.name,
            picture: googleInfo.picture,
            quota: existingAccount?.quota || undefined
        };

        if (existingIdx !== -1) {
            accounts[existingIdx] = updatedAccount;
        } else {
            accounts.push(updatedAccount);
            vscode.window.showInformationMessage(`Google account saved in switcher: ${email}`);
        }

        await context.globalState.update('saved_accounts', accounts);
        await context.globalState.update('active_email', email);

        lastActiveAccessToken = tokenInfo.accessToken;

        statusBarItem.text = `👤 ${email}`;
        statusBarItem.tooltip = `Active account: ${googleInfo.name} (${email}). Click to switch or add accounts.`;

    } catch (e) {
        console.error('Error syncing active session:', e);
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

async function migrateTokensToSecretStorage(context: vscode.ExtensionContext) {
    const accounts = context.globalState.get<SavedAccount[]>('saved_accounts', []);
    let migrated = false;
    for (const account of accounts) {
        if (account.tokenInfo) {
            const emailKey = `token_${account.email.toLowerCase()}`;
            await context.secrets.store(emailKey, JSON.stringify(account.tokenInfo));
            delete account.tokenInfo;
            migrated = true;
        }
    }
    if (migrated) {
        await context.globalState.update('saved_accounts', accounts);
    }
}



async function showSwitcherMenu(context: vscode.ExtensionContext) {
    const accounts = context.globalState.get<SavedAccount[]>('saved_accounts', []);
    const activeEmail = context.globalState.get<string>('active_email');

    const items: vscode.QuickPickItem[] = [];

    let activeItemToFocus: vscode.QuickPickItem | undefined = undefined;

    for (const account of accounts) {
        const isActive = activeEmail && account.email.toLowerCase() === activeEmail.toLowerCase();

        let detailLine = '';
        const q = account.quota as any;
        if (q) {
            
            const gPct = q.geminiPercent !== undefined ? q.geminiPercent
                       : q.geminiWeekly !== undefined ? q.geminiWeekly  
                       : undefined;
            const cPct = q.claudePercent !== undefined ? q.claudePercent
                       : q.claudeWeekly !== undefined ? q.claudeWeekly  
                       : undefined;

            const formatResetStr = (resetTimeMs?: number) => {
                if (!resetTimeMs) return '';
                const diff = resetTimeMs - Date.now();
                if (diff <= 0) return ' (Quota Reset)';
                const mins = Math.ceil(diff / 60000);
                if (mins < 60) return ` (Reset in ${mins}m)`;
                const hours = Math.floor(mins / 60);
                return ` (Reset in ${hours}h ${mins % 60}m)`;
            };

            if (gPct !== undefined || cPct !== undefined) {
                const gResetStr = formatResetStr(q.geminiResetTime);
                const cResetStr = formatResetStr(q.claudeResetTime);
                
                const gStr = gPct !== undefined ? `${gPct}%${gPct < 100 ? gResetStr : ''}` : '?';
                const cStr = cPct !== undefined ? `${cPct}%${cPct < 100 ? cResetStr : ''}` : '?';
                
                detailLine = `Gemini ${gStr}  ·  Claude/GPT ${cStr}`;
                if (!isActive && q.lastUpdated) {
                    const ago = Math.round((Date.now() - q.lastUpdated) / 60000);
                    detailLine += `  (updated ${ago}m ago)`;
                }
            } else {
                detailLine = isActive ? 'Updating quota...' : 'Switch to update quota';
            }
        } else {
            detailLine = isActive ? 'Updating quota...' : 'Switch to update quota';
        }

        const qItem: vscode.QuickPickItem = {
            label: `${isActive ? '$(check) ' : '$(account) '} ${account.name}`,
            description: account.email,
            detail: detailLine
        };
        
        items.push(qItem);
        
        if (isActive) {
            activeItemToFocus = qItem;
        }
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
    if (activeItemToFocus) {
        quickPick.activeItems = [activeItemToFocus];
    }

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
                await context.secrets.delete(`token_${accountToRemove.toLowerCase()}`);
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
            const tokenInfoStr = await context.secrets.get(`token_${email.toLowerCase()}`);
            if (!tokenInfoStr) {
                vscode.window.showErrorMessage(`Credentials for ${email} could not be retrieved securely.`);
                return;
            }
            const tokenInfo = JSON.parse(tokenInfoStr);

            await uss.OAuthPreferences.setOAuthTokenInfo(tokenInfo);

            await context.globalState.update('active_email', email);
            lastActiveAccessToken = tokenInfo.accessToken;

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
