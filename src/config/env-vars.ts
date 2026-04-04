export interface EnvVariableConfig {
  key: string;
  description: string;
  default?: string;
}

export const ENV_VARIABLES: EnvVariableConfig[] = [
  {
    key: 'SSH_KEY_PATH',
    description: 'Absolute path to the SSH private key used for deployment',
    default: '/path/to/your/key.pem'
  },
  {
    key: 'SSH_USER',
    description: 'SSH username for the deployment server (e.g., ubuntu)',
    default: 'ubuntu'
  },
  {
    key: 'SSH_HOST',
    description: 'Hostname or IP address of the deployment server',
    default: 'testflask.beyondchats.com'
  },
  {
    key: 'MENTION_KEYWORD',
    description: 'The keyword used to trigger the bot in messages (e.g., @siddhant)',
    default: '@siddhant'
  }
];
