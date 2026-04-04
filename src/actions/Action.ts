import { InboundMessage } from '../services/InboundService.js';

export interface Action {
  name: string;
  template: string; // e.g., "make_live test <repo_link> <branch_name>"
  description: string;
  
  /**
   * Returns true if this action should handle the message.
   */
  matches(message: InboundMessage): boolean;
  
  /**
   * Executes the action and returns a response string.
   */
  execute(message: InboundMessage): Promise<string>;
}
