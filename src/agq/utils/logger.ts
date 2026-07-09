import * as vscode from 'vscode';

class Logger {
	debug(...args: any[]) { console.log('[DEBUG]', ...args); }
	info(...args: any[]) { console.log('[INFO]', ...args); }
	warn(...args: any[]) { console.warn('[WARN]', ...args); }
	error(...args: any[]) { console.error('[ERROR]', ...args); }
	section(...args: any[]) { console.log('[SECTION]', ...args); }
	time_start(label: string) { 
		const start = Date.now(); 
		return () => console.log(`[TIME] ${label} took ${Date.now() - start}ms`); 
	}
	init(context: vscode.ExtensionContext) {}
	show() {}
}

export const logger = new Logger();
