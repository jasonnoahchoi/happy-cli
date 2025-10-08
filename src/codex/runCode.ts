/**
 * Code CLI Integration - Simple wrapper for @just-every/code
 *
 * Unlike Codex which uses MCP, Code CLI is spawned directly with appropriate flags.
 * This provides a simpler integration path while maintaining session management.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '@/ui/logger';
import { ApiClient } from '@/api/api';
import { readSettings, type Credentials } from '@/persistence';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import packageJson from '../../package.json';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { resolve } from 'node:path';
import { initialMachineMetadata } from '@/daemon/run';
import type { Metadata } from '@/api/types';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';

type PermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

export interface RunCodeOptions {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    model?: string;
    permissionMode?: PermissionMode;
    additionalArgs?: string[];
}

export async function runCode(opts: RunCodeOptions): Promise<void> {
    const sessionTag = randomUUID();
    const api = await ApiClient.create(opts.credentials);

    logger.debug(`[code] Starting with options: startedBy=${opts.startedBy || 'terminal'}, model=${opts.model || 'default'}`);

    // Get machine ID
    const settings = await readSettings();
    let machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings. Please report this issue.`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    // Create session
    const metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'code'
    };

    const response = await api.getOrCreateSession({
        tag: sessionTag,
        metadata,
        state: { controlledByUser: false }
    });

    const session = api.sessionSyncClient(response);

    // Report to daemon
    try {
        logger.debug(`[START] Reporting session ${response.id} to daemon`);
        const result = await notifyDaemonSessionStarted(response.id, metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${response.id} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }

    // Build Code CLI command arguments
    const args = buildCodeArgs(opts);

    logger.debug(`[code] Spawning: coder ${args.join(' ')}`);
    console.log(`\n🚀 Starting Code CLI with ${opts.model || 'default model'}...\n`);

    // Spawn Code CLI process
    let codeProcess: ChildProcess | null = null;
    let shouldExit = false;

    try {
        codeProcess = spawn('coder', args, {
            stdio: 'inherit', // Pass through stdin/stdout/stderr
            cwd: process.cwd(),
            env: {
                ...process.env,
                // Ensure Code CLI uses correct home directory
                CODEX_HOME: process.env.CODEX_HOME || os.homedir() + '/.code'
            }
        });

        // Handle kill session RPC
        session.rpcHandlerManager.registerHandler('killSession', async () => {
            logger.debug('[code] Kill session requested');
            shouldExit = true;
            if (codeProcess && !codeProcess.killed) {
                codeProcess.kill('SIGTERM');
                // Give it a moment to clean up, then force kill
                setTimeout(() => {
                    if (codeProcess && !codeProcess.killed) {
                        codeProcess.kill('SIGKILL');
                    }
                }, 2000);
            }

            // Update session lifecycle
            session.updateMetadata((current) => ({
                ...current,
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now(),
                archivedBy: 'cli',
                archiveReason: 'User terminated'
            }));

            session.sendSessionDeath();
            await session.flush();
            await session.close();
            process.exit(0);
        });

        // Handle process exit
        codeProcess.on('exit', (code, signal) => {
            logger.debug(`[code] Process exited with code ${code}, signal ${signal}`);
            shouldExit = true;
        });

        codeProcess.on('error', (error) => {
            logger.warn(`[code] Process error:`, error);
            console.error(`\n❌ Error running Code CLI: ${error.message}`);
            console.error(`\nMake sure Code CLI is installed:`);
            console.error(`  npm install -g @just-every/code\n`);
            shouldExit = true;
        });

        // Wait for process to exit
        await new Promise<void>((resolve) => {
            const checkExit = setInterval(() => {
                if (shouldExit || !codeProcess || codeProcess.killed) {
                    clearInterval(checkExit);
                    resolve();
                }
            }, 100);
        });

    } finally {
        logger.debug('[code] Cleanup start');

        // Ensure process is killed
        if (codeProcess && !codeProcess.killed) {
            logger.debug('[code] Killing process');
            codeProcess.kill('SIGTERM');
            setTimeout(() => {
                if (codeProcess && !codeProcess.killed) {
                    codeProcess.kill('SIGKILL');
                }
            }, 1000);
        }

        // Close session
        try {
            session.sendSessionDeath();
            await session.flush();
            await session.close();
        } catch (e) {
            logger.debug('[code] Error closing session:', e);
        }

        logger.debug('[code] Cleanup completed');
    }
}

/**
 * Build Code CLI arguments based on options
 */
function buildCodeArgs(opts: RunCodeOptions): string[] {
    const args: string[] = [];

    // Add model if specified
    if (opts.model) {
        args.push('--model', opts.model);
    }

    // Map permission mode to Code CLI flags
    const permissionMode = opts.permissionMode || 'default';

    switch (permissionMode) {
        case 'yolo':
            // EXTREMELY DANGEROUS - no approvals, no sandbox
            args.push('--dangerously-bypass-approvals-and-sandbox');
            break;
        case 'safe-yolo':
            // Low-friction sandboxed auto-execution (on-failure approval + workspace-write sandbox)
            args.push('--full-auto');
            break;
        case 'read-only':
            // Read-only sandbox mode
            args.push('--sandbox', 'read-only');
            break;
        case 'default':
            // Use default approval behavior (untrusted commands require approval)
            break;
    }

    // Add any additional arguments passed through
    if (opts.additionalArgs && opts.additionalArgs.length > 0) {
        args.push(...opts.additionalArgs);
    }

    return args;
}
