import { Action } from './Action.js';
import { InboundMessage } from '../services/InboundService.js';

export class ActionDispatcher {
  private actions: Action[] = [];

  async init(): Promise<void> {
    const enabledActionsStr = process.env.ENABLED_ACTIONS;
    if (!enabledActionsStr) {
      console.warn('No actions enabled. Please configure ENABLED_ACTIONS in your .env file.');
      return;
    }

    const enabledActionNames = enabledActionsStr.split(',').map(s => s.trim()).filter(Boolean);

    for (const actionName of enabledActionNames) {
      try {
        const module = await import(`./${actionName}.js`);
        const ActionClass = module[actionName];
        if (ActionClass) {
          this.actions.push(new ActionClass());
          console.log(`Loaded action: ${actionName}`);
        } else {
          console.error(`Action class ${actionName} not found in module.`);
        }
      } catch (error: any) {
        console.error(`Failed to load action ${actionName}:`, error.message);
      }
    }
  }

  async dispatch(message: InboundMessage): Promise<string | null> {
    for (const action of this.actions) {
      if (action.matches(message)) {
        console.log(`Matching action found: ${action.name}`);
        return await action.execute(message);
      }
    }
    
    // If mentioned but no action matched, provide help
    if (message.isMentioned) {
      return this.getHelpMessage();
    }
    
    return null;
  }

  private getHelpMessage(): string {
    let help = "Available commands:\n";
    for (const action of this.actions) {
      help += `🔹 *${action.name}*: ${action.template}\n   _${action.description}_\n\n`;
    }
    return help;
  }
}
