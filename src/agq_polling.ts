import * as vscode from 'vscode';
import { ProcessFinder } from './agq/process_finder';
import { QuotaManager } from './agq/quota_manager';
import { QuotaInfo, SavedAccount } from './extension';

let processFinder: ProcessFinder | null = null;
let quotaManager: QuotaManager | null = null;
let isInitialized = false;

export async function startBackgroundQuotaPolling(context: vscode.ExtensionContext) {
    if (isInitialized) return;
    
    processFinder = new ProcessFinder();
    quotaManager = new QuotaManager();

    quotaManager.on_update((snapshot) => {
        let geminiMin = 1.0;
        let claudeMin = 1.0;
        let claudeHours = 0;
        
        for (const model of snapshot.models) {
            const label = model.label || '';
            let remain = 1.0;
            if (model.remaining_fraction !== undefined) {
                remain = model.remaining_fraction;
            } else if (model.remaining_percentage !== undefined) {
                remain = model.remaining_percentage / 100.0;
            } else if (model.is_exhausted) {
                remain = 0.0;
            }

            const hours = model.time_until_reset ? model.time_until_reset / (1000 * 60 * 60) : 0;
            
            if (label.toLowerCase().includes('gemini')) {
                geminiMin = Math.min(geminiMin, remain);
            } else if (label.toLowerCase().includes('claude')) {
                claudeMin = Math.min(claudeMin, remain);
                claudeHours = Math.max(claudeHours, hours);
            } else if (label.toLowerCase().includes('gpt')) {
                // If GPT shares Claude quota, we can also count it
                claudeMin = Math.min(claudeMin, remain);
                claudeHours = Math.max(claudeHours, hours);
            }
        }
        
        // Log the models to file so we can see what Claude reports when 0%
        const fs = require('fs');
        const path = require('path');
        try {
            const logPath = path.join(__dirname, '..', 'quota_debug.log');
            fs.appendFileSync(logPath, `\n--- SNAPSHOT ---\n${JSON.stringify(snapshot.models, null, 2)}\n`);
        } catch (e) {}
        
        const quotaInfo: QuotaInfo = {
            geminiPercent: Math.round(geminiMin * 100),
            claudePercent: Math.round(claudeMin * 100),
            claudeResetHours: claudeHours > 0 ? parseFloat(claudeHours.toFixed(1)) : 0
        };

        // Update active account
        const activeEmail = context.globalState.get<string>('active_email');
        if (!activeEmail) return;

        const accounts = context.globalState.get<SavedAccount[]>('saved_accounts', []);
        const idx = accounts.findIndex(a => a.email.toLowerCase() === activeEmail.toLowerCase());
        if (idx === -1) return;
        if (snapshot.email && snapshot.email.toLowerCase() !== activeEmail.toLowerCase()) {
            console.log(`[AGQ Polling] Ignoring stale snapshot for ${snapshot.email} (waiting for ${activeEmail} to sync)`);
            return;
        }

        const oldQuota = accounts[idx].quota;
        if (!oldQuota || 
            oldQuota.geminiPercent !== quotaInfo.geminiPercent || 
            oldQuota.claudePercent !== quotaInfo.claudePercent) {
            
            accounts[idx].quota = quotaInfo;
            context.globalState.update('saved_accounts', accounts);
            
            console.log(`[AGQ Polling] Quota updated for ${activeEmail}: Gemini ${quotaInfo.geminiPercent}%, Claude ${quotaInfo.claudePercent}%`);
            
        }
    });

    quotaManager.on_error((err) => {
        console.error('[AGQ Polling] Error:', err);
    });

    try {
        const processInfo = await processFinder.detect_process_info(3);
        if (processInfo) {
            quotaManager.init(processInfo.connect_port, processInfo.csrf_token);
            quotaManager.start_polling(5000); // 5 seconds interval
            isInitialized = true;
            console.log('[AGQ Polling] Started successfully');
        } else {
            console.log('[AGQ Polling] Could not detect language server process');
        }
    } catch (e) {
        console.error('[AGQ Polling] Detection failed:', e);
    }
}

export function stopBackgroundQuotaPolling() {
    if (quotaManager) {
        quotaManager.stop_polling();
    }
    isInitialized = false;
}
