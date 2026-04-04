import { EventEmitter } from 'events';

export interface InboundMessage {
  sender: string;
  groupID: string; // Empty string if not a group
  groupName?: string;
  text: string;
  isMentioned: boolean;
  timestamp: number;
}

export abstract class AbstractInboundService extends EventEmitter {
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(to: string, text: string): Promise<void>;
  
  protected emitMessage(message: InboundMessage) {
    this.emit('message', message);
  }
}
