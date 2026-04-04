import 'dotenv/config';
import projectsMap from '../config/projects-map.json' with { type: 'json' };
import { ShellExecutor } from '../utils/ShellExecutor.js';
import { Action } from './Action.js';
import { InboundMessage } from '../services/InboundService.js';

export class MakeLiveAction implements Action {
  name = 'make_live';
  template = 'make_live test <repo_link> <branch_name>';
  description = 'Deploys a specific branch of a GitLab repository to the test server.';

  private static readonly SSH_KEY_PATH = process.env.SSH_KEY_PATH;
  private static readonly SSH_USER = process.env.SSH_USER;
  private static readonly SSH_HOST = process.env.SSH_HOST;

  matches(message: InboundMessage): boolean {
    if (!message.isMentioned) return false;
    const parts = message.text.split(/\s+/);
    const mentionIndex = parts.findIndex(p => p.includes(process.env.MENTION_KEYWORD || '@siddhant'));
    return parts[mentionIndex + 1] === 'make_live' && parts[mentionIndex + 2] === 'test';
  }

  async execute(message: InboundMessage): Promise<string> {
    const parts = message.text.split(/\s+/);
    const mentionIndex = parts.findIndex(p => p.includes(process.env.MENTION_KEYWORD || '@siddhant'));
    
    const repoLink = parts[mentionIndex + 3];
    const branchName = parts[mentionIndex + 4];

    if (!repoLink || !branchName) {
      return `Error: Missing arguments. Template: ${this.template}`;
    }

    if (!MakeLiveAction.SSH_KEY_PATH || !MakeLiveAction.SSH_USER || !MakeLiveAction.SSH_HOST) {
      return `Error: SSH configuration is missing in the environment variables.`;
    }

    const serverPath = (projectsMap as Record<string, string>)[repoLink];
    
    if (!serverPath) {
      return `Error: Project not found in mapping: ${repoLink}`;
    }

    const sshCommand = `ssh -i ${MakeLiveAction.SSH_KEY_PATH} ${MakeLiveAction.SSH_USER}@${MakeLiveAction.SSH_HOST}`;
    const command = `${sshCommand} "cd ${serverPath} && git fetch --all && git checkout ${branchName} && git pull"`;
    
    console.log(`Executing: ${command}`);
    
    try {
      const { stdout, stderr } = await ShellExecutor.run(command);
      return `✅ Deployment successful for ${repoLink} [${branchName}].\n\nOutput:\n${stdout || stderr}`;
    } catch (error: any) {
      return `❌ Deployment failed for ${repoLink}: ${error.message}`;
    }
  }
}
