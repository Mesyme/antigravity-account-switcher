import * as vscode from 'vscode';

class Logger {
	private channel: vscode.OutputChannel | null = null;

	init(context: vscode.ExtensionContext) {
		if (!this.channel) {
			this.channel = vscode.window.createOutputChannel('Antigravity Switcher Logs');
			context.subscriptions.push(this.channel);
		}
	}

	private log(level: string, ...args: any[]) {
		const timestamp = new Date().toISOString();
		const msg = args.map(arg => {
			if (typeof arg === 'object') {
				try {
					return JSON.stringify(arg, null, 2);
				} catch {
					return String(arg);
				}
			}
			return String(arg);
		}).join(' ');
		const formatted = `[${timestamp}] [${level}] ${msg}`;
		console.log(formatted);
		if (this.channel) {
			this.channel.appendLine(formatted);
		}
	}

	debug(...args: any[]) { this.log('DEBUG', ...args); }
	info(...args: any[]) { this.log('INFO', ...args); }
	warn(...args: any[]) { this.log('WARN', ...args); }
	error(...args: any[]) { this.log('ERROR', ...args); }
	section(...args: any[]) { this.log('SECTION', ...args); }

	time_start(label: string) { 
		const start = Date.now(); 
		return () => this.info(`[TIME] ${label} took ${Date.now() - start}ms`); 
	}

	show() {
		if (this.channel) {
			this.channel.show(true);
		}
	}
}

export const logger = new Logger();
