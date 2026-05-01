export interface EnvVariableConfig {
  key: string;
  description: string;
  default?: string;
  secret?: boolean;
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
  },
  {
    key: 'GEMINI_API_KEY',
    description: 'Google AI Studio API key for Gemini model calls',
    default: '',
    secret: true
  },
  {
    key: 'LLM_MODEL_FAST',
    description: 'Gemini model used for cheap/fast classification calls',
    default: 'gemini-2.5-flash'
  },
  {
    key: 'LLM_MODEL_SMART',
    description: 'Gemini model used when reasoning matters (EOD aggregate, plan-day)',
    default: 'gemini-2.5-pro'
  },
  {
    key: 'LLM_DRY_RUN',
    description: 'When true, GeminiClient returns canned shapes without hitting the API',
    default: 'false'
  },
  {
    key: 'SCHEDULER_TZ',
    description: 'IANA timezone for cron schedules (e.g., Asia/Kolkata)',
    default: 'Asia/Kolkata'
  },
  {
    key: 'WORKING_DAYS',
    description: 'Comma-separated list of weekdays the bot operates on',
    default: 'mon,tue,wed,thu,fri'
  },
  {
    key: 'WORKING_HOURS_START',
    description: 'Start of working hours in HH:MM (in SCHEDULER_TZ)',
    default: '09:00'
  },
  {
    key: 'WORKING_HOURS_END',
    description: 'End of working hours in HH:MM (in SCHEDULER_TZ)',
    default: '19:00'
  },
  {
    key: 'ENABLED_HOOKS',
    description: 'Comma-separated list of Hook class names to enable',
    default: 'PersistMessageHook'
  },
  {
    key: 'ENABLED_JOBS',
    description: 'Comma-separated list of Job class names to enable',
    default: 'PruneMessagesJob'
  },
  {
    key: 'DB_PATH',
    description: 'Path to the SQLite database file',
    default: 'data/machine.db'
  },
  {
    key: 'MESSAGE_RETENTION_DAYS',
    description: 'How many days of messages to keep before PruneMessagesJob deletes them',
    default: '7'
  }
];
